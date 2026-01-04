#!/usr/bin/env node
/**
 * Kahoot Auto-Join Script - Fixed based on browser capture
 * Usage: node join.js <gamePin> <playerName>
 */

const https = require('https');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const DEBUG = true;
const gamePin = args.find(a => /^\d+$/.test(a));
const playerName = args.find(a => !/^\d+$/.test(a) && !a.startsWith('--')) || 'Player';

if (!gamePin) {
    console.log('Usage: node join.js <gamePin> <playerName>');
    console.log('Example: node join.js 1234567 MyName');
    process.exit(1);
}

// Global state for cleanup
let globalWs = null;
let globalClientId = null;
let globalMessageId = 1;
let currentQuestionIndex = 0;
let questionActive = false;
let answerMode = 'manual'; // 'manual', 'random', 'first', 'second', 'third', 'fourth'

// Check for bypass filter flag
const useBypass = args.includes('--bypass');

/**
 * Bypass text filters using various techniques:
 * 1. Zero-width characters inserted between letters
 * 2. Combining diacritical marks (invisible)
 * 3. Only a few carefully chosen lookalikes that pass script detection
 */
function bypassFilter(str) {
    if (!useBypass) return str;
    
    // Method 1: Insert zero-width joiners between characters to break pattern matching
    const zwj = '\u200D';      // Zero-width joiner
    const zwnj = '\u200C';     // Zero-width non-joiner  
    const zwsp = '\u200B';     // Zero-width space
    
    // Split and rejoin with zero-width chars
    let result = str.split('').join(zwsp);
    
    // Method 2: Add invisible combining marks to some characters
    // These attach to the previous character and are invisible
    const combiningMarks = [
        '\u034F',  // Combining grapheme joiner (invisible)
        '\u0332',  // Combining low line (subtle underline, often invisible)
    ];
    
    // Add a combining grapheme joiner after first char (invisible but changes string)
    if (result.length > 1) {
        result = result[0] + '\u034F' + result.slice(1);
    }
    
    return result;
}

function log(...args) {
    if (DEBUG) console.log('[DEBUG]', ...args);
}

// Parse the dynamic offset from the challenge function
function parseOffset(challengeBody) {
    const match = challengeBody.match(/var offset\s*=\s*([^;]+)/);
    if (!match) return 0;
    
    let expr = match[1].replace(/\\t/g, '').replace(/\t/g, '').replace(/\s+/g, '');
    try {
        if (/^[\d+\-*\/\(\)\s]+$/.test(expr)) {
            return eval(expr);
        }
    } catch (e) {}
    return 0;
}

// Kahoot's decode function
function kahootDecode(message, offset) {
    let result = '';
    for (let i = 0; i < message.length; i++) {
        const charCode = message.charCodeAt(i);
        result += String.fromCharCode((((charCode * i) + offset) % 77) + 48);
    }
    return result;
}

// Decode the session token
function decodeToken(headerToken, challengeBody) {
    const msgMatch = challengeBody.match(/decode\.call\(this,\s*'([^']+)'\)/);
    if (!msgMatch) {
        log('No challenge message found');
        return headerToken;
    }
    
    const challengeMessage = msgMatch[1];
    const offset = parseOffset(challengeBody);
    log('Challenge message length:', challengeMessage.length);
    log('Offset:', offset);
    
    const decodedChallenge = kahootDecode(challengeMessage, offset);
    log('Decoded challenge length:', decodedChallenge.length);
    
    // XOR the header token (base64 decoded) with decoded challenge
    const tokenBytes = Buffer.from(headerToken, 'base64');
    log('Token bytes length:', tokenBytes.length);
    
    // XOR each byte with the challenge character code - result is the actual token chars!
    let result = '';
    for (let i = 0; i < tokenBytes.length; i++) {
        const challengeChar = decodedChallenge.charCodeAt(i % decodedChallenge.length);
        const xored = tokenBytes[i] ^ challengeChar;
        result += String.fromCharCode(xored);  // Convert to character, not hex!
    }
    
    log('Final token length:', result.length);
    log('Final token:', result);
    return result;
}

// Reserve session
function reserveSession(pin) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const url = `https://kahoot.it/reserve/session/${pin}/?${timestamp}`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Reserve failed: ${res.statusCode}`));
                    return;
                }
                
                const sessionToken = res.headers['x-kahoot-session-token'];
                const body = JSON.parse(data);
                
                log('Session token (raw):', sessionToken);
                log('Session token length:', sessionToken.length);
                log('Base64 decoded length:', Buffer.from(sessionToken, 'base64').length);
                
                resolve({
                    sessionToken,
                    challenge: body.challenge,
                    gameServer: res.headers['x-kahoot-gameserver']
                });
            });
        }).on('error', reject);
    });
}

// Connect and join - MATCHES BROWSER EXACTLY
async function connectAndJoin(pin, name, token) {
    return new Promise((resolve, reject) => {
        // NO query params! Browser doesn't use ?mode=player&name=
        const wsUrl = `wss://kahoot.it/cometd/${pin}/${token}`;
        
        log('WebSocket URL:', wsUrl);
        
        const ws = new WebSocket(wsUrl, {
            headers: {
                'Origin': 'https://kahoot.it',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        let clientId = null;
        let messageId = 1;
        let ackCount = 0;
        let playerId = null;
        let joined = false;
        let keepAliveInterval = null;
        let originalName = name;
        let currentName = name;
        let retryCount = 0;
        const maxRetries = 6;
        
        ws.on('open', () => {
            console.log('✓ Connected to WebSocket');
            
            // Step 1: Handshake - EXACTLY like browser
            const handshake = [{
                id: String(messageId++),
                version: '1.0',
                minimumVersion: '1.0',
                channel: '/meta/handshake',
                supportedConnectionTypes: ['websocket', 'long-polling', 'callback-polling'],
                advice: { timeout: 60000, interval: 0 },
                ext: { ack: true, timesync: { tc: Date.now(), l: 0, o: 0 } }
            }];
            
            log('SEND handshake');
            ws.send(JSON.stringify(handshake));
        });
        
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            log('RECV:', msg[0]?.channel, msg[0]?.data?.type || '');
            
            for (const m of msg) {
                // Handle handshake response
                if (m.channel === '/meta/handshake' && m.successful) {
                    clientId = m.clientId;
                    console.log('✓ Handshake OK, clientId:', clientId);
                    
                    // Step 2: First connect with advice timeout:0
                    const connect1 = [{
                        id: String(messageId++),
                        channel: '/meta/connect',
                        connectionType: 'websocket',
                        advice: { timeout: 0 },
                        clientId: clientId,
                        ext: { ack: 0, timesync: { tc: Date.now(), l: 0, o: 0 } }
                    }];
                    log('SEND connect (first)');
                    ws.send(JSON.stringify(connect1));
                }
                
                // Handle connect response
                if (m.channel === '/meta/connect' && m.successful) {
                    ackCount = m.ext?.ack || ackCount + 1;
                    
                    if (ackCount === 1 && !playerId) {
                        // Step 3: Second connect (no advice)
                        const connect2 = [{
                            id: String(messageId++),
                            channel: '/meta/connect',
                            connectionType: 'websocket',
                            clientId: clientId,
                            ext: { ack: 1, timesync: { tc: Date.now(), l: 0, o: 0 } }
                        }];
                        log('SEND connect (second)');
                        ws.send(JSON.stringify(connect2));
                        
                        // Step 4: Send login - use currentName and allow retries on duplicate
                        const sendLogin = () => {
                            const filteredName = bypassFilter(currentName);
                            const login = [{
                                id: String(messageId++),
                                channel: '/service/controller',
                                data: {
                                    type: 'login',
                                    gameid: pin,
                                    host: 'kahoot.it',
                                    name: filteredName,
                                    content: '{}'  // Empty! Not device info
                                },
                                clientId: clientId,
                                ext: {}
                            }];
                            log('SEND login', currentName, useBypass ? `(filtered: ${filteredName})` : '');
                            ws.send(JSON.stringify(login));
                        };
                        sendLogin();
                    } else {
                        // ALWAYS respond to /meta/connect with another connect to keep alive
                        // This is the key - respond immediately to each server connect response
                        setTimeout(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                const keepAlive = [{
                                    id: String(messageId++),
                                    channel: '/meta/connect',
                                    connectionType: 'websocket',
                                    clientId: clientId,
                                    ext: { ack: ackCount, timesync: { tc: Date.now(), l: 0, o: 0 } }
                                }];
                                try { ws.send(JSON.stringify(keepAlive)); } catch (e) {}
                            }
                        }, 500); // Small delay, then respond
                    }
                }
                
                // Handle login response and controller errors
                if (m.channel === '/service/controller') {
                    if (m.data?.type === 'loginResponse') {
                        playerId = m.data.cid;
                        console.log('✓ Login successful! CID:', playerId);

                        // Resolve immediately — loginResponse means the bot is in
                        joined = true;
                        const resolvedBot = { ws, clientId, playerId, playerName: currentName };

                        // Step 5: Send namerator message (id:16) - like browser
                        const namerator = [{
                            id: String(messageId++),
                            channel: '/service/controller',
                            data: {
                                gameid: pin,
                                type: 'message',
                                host: 'kahoot.it',
                                id: 16,
                                content: JSON.stringify({ usingNamerator: false })
                            },
                            clientId: clientId,
                            ext: {}
                        }];
                        log('SEND namerator message');
                        try { ws.send(JSON.stringify(namerator)); } catch (e) {}

                        // Keep-alive is now handled by responding to every /meta/connect
                        // No interval needed - the server sends connects and we respond

                        resolve(resolvedBot);
                    }

                    if (m.data?.error) {
                        const errMsg = (m.data.description || m.data.error || '').toString();
                        console.log('✗ Error:', errMsg);
                        // If duplicate name, retry with a small randomized suffix
                        if (/duplicate name/i.test(errMsg) && retryCount < maxRetries) {
                            retryCount++;
                            currentName = `${originalName}-${Math.random().toString(36).slice(2,6)}`;
                            const filteredRetryName = bypassFilter(currentName);
                            log(`Duplicate name, retrying as ${currentName}`, useBypass ? `(filtered: ${filteredRetryName})` : '');
                            const loginRetry = [{
                                id: String(messageId++),
                                channel: '/service/controller',
                                data: { type: 'login', gameid: pin, host: 'kahoot.it', name: filteredRetryName, content: '{}' },
                                clientId: clientId,
                                ext: {}
                            }];
                            try { ws.send(JSON.stringify(loginRetry)); } catch (e) { reject(new Error('Retry failed')); }
                        } else {
                            reject(new Error(errMsg || 'Unknown error'));
                        }
                    }
                }
                
                // Handle player messages
                if (m.channel === '/service/player' && m.data) {
                    // Handle question start (id 2 = question start with choices)
                    if (m.data.id === 2) {
                        try {
                            const content = JSON.parse(m.data.content || '{}');
                            currentQuestionIndex = content.questionIndex || 0;
                            questionActive = true;
                            const numChoices = content.quizQuestionAnswers || content.numberOfChoices || 4;
                            console.log('QUESTION_START:', JSON.stringify({
                                questionIndex: currentQuestionIndex,
                                choices: numChoices,
                                timeLeft: content.timeLeft
                            }));
                            
                            // Auto-answer based on mode
                            if (answerMode !== 'manual') {
                                setTimeout(() => {
                                    if (questionActive) {
                                        let choice;
                                        if (answerMode === 'random') choice = Math.floor(Math.random() * numChoices);
                                        else if (answerMode === 'first') choice = 0;
                                        else if (answerMode === 'second') choice = 1;
                                        else if (answerMode === 'third') choice = 2;
                                        else if (answerMode === 'fourth') choice = 3;
                                        else choice = parseInt(answerMode) || 0;
                                        sendAnswer(choice);
                                    }
                                }, 500 + Math.random() * 1000); // Random delay 0.5-1.5s
                            }
                        } catch (e) {}
                    }
                    
                    // Handle get ready (question coming)
                    if (m.data.id === 1) {
                        console.log('QUESTION_READY');
                    }
                    
                    // Handle time up (id 8)
                    if (m.data.id === 8) {
                        questionActive = false;
                        console.log('TIME_UP');
                    }
                    
                    // Handle answer result (id 8 with content)
                    if (m.data.id === 8 && m.data.content) {
                        try {
                            const content = JSON.parse(m.data.content);
                            if (content.isCorrect !== undefined) {
                                console.log('ANSWER_RESULT:', JSON.stringify({
                                    correct: content.isCorrect,
                                    points: content.points
                                }));
                            }
                        } catch (e) {}
                    }
                    
                    if (m.data.content) {
                        try {
                            const content = JSON.parse(m.data.content);
                                if (content.playerName) {
                                    joined = true;
                                    console.log('\n🎉 JOINED AS:', content.playerName);
                                    console.log('   Player CID:', playerId);

                                    // Start a proper keep-alive using the live ackCount
                                    if (!keepAliveInterval) {
                                        keepAliveInterval = setInterval(() => {
                                            if (ws.readyState === WebSocket.OPEN) {
                                                const keepAlive = [{
                                                    id: String(messageId++),
                                                    channel: '/meta/connect',
                                                    connectionType: 'websocket',
                                                    clientId: clientId,
                                                    ext: { ack: ackCount, timesync: { tc: Date.now(), l: 0, o: 0 } }
                                                }];
                                                try { ws.send(JSON.stringify(keepAlive)); } catch (e) {}
                                            } else {
                                                clearInterval(keepAliveInterval);
                                            }
                                        }, 25000);
                                    }

                                    resolve({ ws, clientId, playerId, playerName: content.playerName });
                                }
                        } catch (e) {}
                    }
                }
                
                // Handle status
                if (m.channel === '/service/status' && m.data?.status === 'ACTIVE') {
                    console.log('✓ Game is ACTIVE');
                }
            }
        });
        
        ws.on('error', (err) => {
            console.log('✗ WebSocket error:', err.message);
            reject(err);
        });
        
        ws.on('close', (code) => {
            log('WebSocket closed:', code);
            if (!joined) {
                reject(new Error(`Connection closed (${code})`));
            }
        });
        
        // Timeout
        setTimeout(() => {
            if (!joined) {
                console.log('\n⚠ Timeout - check if name appears in Kahoot lobby');
                ws.close();
            }
        }, 15000);
    });
}

// Main
async function main() {
    console.log('\n=== Kahoot Auto-Join ===');
    console.log(`Game PIN: ${gamePin}`);
    console.log(`Player: ${playerName}\n`);
    
    try {
        // Step 1: Get session
        console.log('[1/3] Getting session token...');
        const { sessionToken, challenge } = await reserveSession(gamePin);
        console.log('   ✓ Got session token');
        
        // Step 2: Decode token
        console.log('[2/3] Decoding token...');
        const token = decodeToken(sessionToken, challenge);
        log('Token:', token);
        console.log('   ✓ Token decoded (length:', token.length + ')');
        
        // Step 3: Connect
        console.log('[3/3] Connecting...\n');
        const result = await connectAndJoin(gamePin, playerName, token);
        
        // Store globals for cleanup
        globalWs = result.ws;
        globalClientId = result.clientId;
        
        console.log('\n=== SUCCESS ===');
        console.log('Listening for game events... (Ctrl+C to exit)\n');
        
        // Listen for commands on stdin
        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    const cmd = line.trim();
                    if (!cmd) continue;
                    
                    if (cmd.startsWith('ANSWER:')) {
                        const answer = parseInt(cmd.split(':')[1]);
                        if (!isNaN(answer) && answer >= 0 && answer <= 7) {
                            sendAnswer(answer);
                        }
                    } else if (cmd.startsWith('MODE:')) {
                        answerMode = cmd.split(':')[1] || 'manual';
                        console.log('MODE_SET:', answerMode);
                    }
                }
            }
        });
        
        // keep-alive is handled inside connectAndJoin using live ackCount
        
    } catch (err) {
        console.log('\n=== FAILED ===');
        console.log('Error:', err.message);
        process.exit(1);
    }
}

// Send answer to Kahoot
function sendAnswer(choice) {
    if (!globalWs || globalWs.readyState !== WebSocket.OPEN || !globalClientId) {
        console.log('Cannot answer - not connected');
        return;
    }
    
    questionActive = false; // Mark as answered
    
    const answerMsg = [{
        id: String(globalMessageId++),
        channel: '/service/controller',
        data: {
            type: 'message',
            gameid: gamePin,
            host: 'kahoot.it',
            id: 45,
            content: JSON.stringify({
                choice: choice,
                questionIndex: currentQuestionIndex,
                meta: { lag: Math.floor(Math.random() * 50) + 10 }
            })
        },
        clientId: globalClientId,
        ext: {}
    }];
    
    try {
        globalWs.send(JSON.stringify(answerMsg));
        console.log('ANSWERED:', choice, 'Q:', currentQuestionIndex);
    } catch (e) {
        console.log('Answer failed:', e.message);
    }
}

// Graceful disconnect - send /meta/disconnect to Kahoot so bot leaves instantly
function gracefulDisconnect() {
    if (globalWs && globalWs.readyState === WebSocket.OPEN && globalClientId) {
        try {
            const disconnect = [{
                id: String(globalMessageId++),
                channel: '/meta/disconnect',
                clientId: globalClientId,
                ext: {}
            }];
            globalWs.send(JSON.stringify(disconnect));
            globalWs.close();
        } catch (e) {}
    }
    process.exit(0);
}

// Handle kill signals - disconnect properly before dying
process.on('SIGTERM', gracefulDisconnect);
process.on('SIGINT', gracefulDisconnect);
process.on('SIGHUP', gracefulDisconnect);

main();

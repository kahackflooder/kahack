const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});
const PORT = 9235;

// Bot tracking - each bot: { id, name, pin, ws, clientId, messageId, questionIndex, status, ackCount }
const bots = [];
let botIdCounter = 0;

// Answer mode
let currentAnswerMode = 'manual';

// CORS: allow specific frontends (GitHub Pages + Cloudflare tunnels + localhost)
const ALLOWED_ORIGINS = [
    'https://kahackflooder.github.io',
    'http://localhost:9235',
    'http://127.0.0.1:9235'
];

function isAllowedOrigin(origin) {
    if (!origin) return true;  // Allow same-origin requests
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // allow github.io subdomains and any trycloudflare.com tunnel for convenience
    if (origin.endsWith('.github.io')) return true;
    if (origin.includes('trycloudflare.com')) return true;
    if (origin.startsWith('http://localhost:')) return true;
    if (origin.startsWith('http://127.0.0.1:')) return true;
    return false;
}

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.static(__dirname));
app.use(express.json());

// Parse offset from challenge
function parseOffset(challengeBody) {
    const match = challengeBody.match(/var offset\s*=\s*([^;]+)/);
    if (!match) return 0;
    let expr = match[1].replace(/\\t/g, '').replace(/\t/g, '').replace(/\s+/g, '');
    try {
        if (/^[\d+\-*\/\(\)\s]+$/.test(expr)) return eval(expr);
    } catch (e) {}
    return 0;
}

// Kahoot decode function
function kahootDecode(message, offset) {
    let result = '';
    for (let i = 0; i < message.length; i++) {
        const charCode = message.charCodeAt(i);
        result += String.fromCharCode((((charCode * i) + offset) % 77) + 48);
    }
    return result;
}

// Decode token
function decodeToken(headerToken, challengeBody) {
    const msgMatch = challengeBody.match(/decode\.call\(this,\s*'([^']+)'\)/);
    if (!msgMatch) return headerToken;
    
    const challengeMessage = msgMatch[1];
    const offset = parseOffset(challengeBody);
    const decodedChallenge = kahootDecode(challengeMessage, offset);
    
    const tokenBytes = Buffer.from(headerToken, 'base64');
    let result = '';
    for (let i = 0; i < tokenBytes.length; i++) {
        const challengeChar = decodedChallenge.charCodeAt(i % decodedChallenge.length);
        result += String.fromCharCode(tokenBytes[i] ^ challengeChar);
    }
    return result;
}

// Reserve session endpoint
app.get('/api/reserve/:pin', (req, res) => {
    const pin = req.params.pin;
    const timestamp = Date.now();
    const url = `https://kahoot.it/reserve/session/${pin}/?${timestamp}`;
    
    https.get(url, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
            if (response.statusCode !== 200) {
                res.status(response.statusCode).json({ error: 'Game not found or ended' });
                return;
            }
            
            try {
                const sessionToken = response.headers['x-kahoot-session-token'];
                const body = JSON.parse(data);
                const token = decodeToken(sessionToken, body.challenge);
                
                res.json({
                    token,
                    twoFactorAuth: body.twoFactorAuth,
                    namerator: body.namerator
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    }).on('error', (e) => {
        res.status(500).json({ error: e.message });
    });
});

// Bypass filter using zero-width chars
function bypassFilter(str, useBypass) {
    if (!useBypass) return str;
    return str.split('').join('\u200B');
}

// Reserve session
function reserveSession(pin) {
    return new Promise((resolve, reject) => {
        const url = `https://kahoot.it/reserve/session/${pin}/?${Date.now()}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('Game not found'));
                try {
                    const sessionToken = res.headers['x-kahoot-session-token'];
                    const body = JSON.parse(data);
                    resolve({ sessionToken, challenge: body.challenge });
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Handle messages from Kahoot for a bot
function handleBotMessage(bot, m) {
    if (m.channel === '/meta/handshake' && m.successful) {
        bot.clientId = m.clientId;
        const connect = [{ id: String(bot.messageId++), channel: '/meta/connect', connectionType: 'websocket', advice: { timeout: 0 }, clientId: bot.clientId, ext: { ack: 0, timesync: { tc: Date.now(), l: 0, o: 0 } } }];
        bot.ws.send(JSON.stringify(connect));
    }
    
    if (m.channel === '/meta/connect' && m.successful) {
        bot.ackCount = m.ext?.ack || bot.ackCount + 1;
        if (bot.ackCount === 1 && bot.status === 'connecting') {
            const connect2 = [{ id: String(bot.messageId++), channel: '/meta/connect', connectionType: 'websocket', clientId: bot.clientId, ext: { ack: 1, timesync: { tc: Date.now(), l: 0, o: 0 } } }];
            bot.ws.send(JSON.stringify(connect2));
            const login = [{ id: String(bot.messageId++), channel: '/service/controller', data: { type: 'login', gameid: bot.pin, host: 'kahoot.it', name: bot.name, content: '{}' }, clientId: bot.clientId, ext: {} }];
            bot.ws.send(JSON.stringify(login));
        } else {
            setTimeout(() => {
                if (bot.ws && bot.ws.readyState === WebSocket.OPEN) {
                    const keepAlive = [{ id: String(bot.messageId++), channel: '/meta/connect', connectionType: 'websocket', clientId: bot.clientId, ext: { ack: bot.ackCount, timesync: { tc: Date.now(), l: 0, o: 0 } } }];
                    try { bot.ws.send(JSON.stringify(keepAlive)); } catch (e) {}
                }
            }, 500);
        }
    }
    
    if (m.channel === '/service/controller') {
        if (m.data?.type === 'loginResponse') {
            bot.status = 'joined';
            bot.cid = m.data.cid;
            io.emit('botJoinSuccess', { name: bot.originalName });
            const namerator = [{ id: String(bot.messageId++), channel: '/service/controller', data: { gameid: bot.pin, type: 'message', host: 'kahoot.it', id: 16, content: JSON.stringify({ usingNamerator: false }) }, clientId: bot.clientId, ext: {} }];
            try { bot.ws.send(JSON.stringify(namerator)); } catch (e) {}
        }
        if (m.data?.error) {
            const err = m.data.description || m.data.error || '';
            if (/duplicate/i.test(err)) {
                bot.name = `${bot.originalName}-${Math.random().toString(36).slice(2, 5)}`;
                const loginRetry = [{ id: String(bot.messageId++), channel: '/service/controller', data: { type: 'login', gameid: bot.pin, host: 'kahoot.it', name: bot.name, content: '{}' }, clientId: bot.clientId, ext: {} }];
                try { bot.ws.send(JSON.stringify(loginRetry)); } catch (e) {}
            } else {
                bot.status = 'failed';
                io.emit('botJoinFail', { message: err });
            }
        }
    }
    
    if (m.channel === '/service/player' && m.data) {
        // Question start - id 2 is the main question event
        if (m.data.id === 2) {
            try {
                const content = JSON.parse(m.data.content || '{}');
                bot.questionIndex = content.questionIndex !== undefined ? content.questionIndex : (bot.questionIndex || 0);
                bot.answered = false; // Reset answered flag for new question
                const numChoices = content.quizQuestionAnswers || content.numberOfChoices || 4;
                console.log(`[Bot ${bot.originalName}] Question ${bot.questionIndex} started, ${numChoices} choices`);
                io.emit('questionStart', { questionIndex: bot.questionIndex, choices: numChoices });
                if (currentAnswerMode !== 'manual' && !bot.answered) {
                    setTimeout(() => {
                        if (!bot.answered) {
                            let choice = currentAnswerMode === 'random' ? Math.floor(Math.random() * numChoices) :
                                         currentAnswerMode === 'first' ? 0 :
                                         currentAnswerMode === 'second' ? 1 :
                                         currentAnswerMode === 'third' ? 2 : 3;
                            sendBotAnswer(bot, choice);
                        }
                    }, 500 + Math.random() * 1000);
                }
            } catch (e) { console.log('Question parse error:', e.message); }
        }
        
        // Get ready for question (id: 1)
        if (m.data.id === 1) {
            try {
                const content = JSON.parse(m.data.content || '{}');
                if (content.questionIndex !== undefined) {
                    bot.questionIndex = content.questionIndex;
                }
                bot.answered = false; // Reset for upcoming question
                console.log(`[Bot ${bot.originalName}] Get ready for question ${bot.questionIndex}`);
            } catch (e) {}
        }
        
        // Time up / answer result (id: 8)
        if (m.data.id === 8) {
            bot.answered = true; // Mark as answered/time up
        }
    }
}

// Send answer for a bot
function sendBotAnswer(bot, choice) {
    if (!bot.ws || bot.ws.readyState !== WebSocket.OPEN || !bot.clientId) return false;
    if (bot.answered) return false; // Already answered this question
    
    const answerMsg = [{ 
        id: String(bot.messageId++), 
        channel: '/service/controller', 
        data: { 
            type: 'message', 
            gameid: bot.pin, 
            host: 'kahoot.it', 
            id: 45, 
            content: JSON.stringify({ 
                choice: choice, 
                questionIndex: bot.questionIndex || 0, 
                meta: { lag: Math.floor(Math.random() * 50) + 10 } 
            }) 
        }, 
        clientId: bot.clientId, 
        ext: {} 
    }];
    
    try { 
        bot.ws.send(JSON.stringify(answerMsg)); 
        bot.answered = true; // Mark as answered
        console.log(`[Bot ${bot.originalName}] Answered ${choice} for question ${bot.questionIndex}`);
        return true; 
    } catch (e) { 
        return false; 
    }
}

// Create a single bot
async function createBot(pin, name, useBypass) {
    const botId = ++botIdCounter;
    try {
        const { sessionToken, challenge } = await reserveSession(pin);
        const token = decodeToken(sessionToken, challenge);
        const wsUrl = `wss://kahoot.it/cometd/${pin}/${token}`;
        const ws = new WebSocket(wsUrl, { headers: { 'Origin': 'https://kahoot.it', 'User-Agent': 'Mozilla/5.0' } });
        
        const bot = { id: botId, name: bypassFilter(name, useBypass), originalName: name, pin, ws, clientId: null, messageId: 1, questionIndex: 0, status: 'connecting', ackCount: 0, answered: false };
        bots.push(bot);
        
        ws.on('open', () => {
            const handshake = [{ id: String(bot.messageId++), version: '1.0', minimumVersion: '1.0', channel: '/meta/handshake', supportedConnectionTypes: ['websocket', 'long-polling', 'callback-polling'], advice: { timeout: 60000, interval: 0 }, ext: { ack: true, timesync: { tc: Date.now(), l: 0, o: 0 } } }];
            ws.send(JSON.stringify(handshake));
        });
        ws.on('message', (data) => { try { JSON.parse(data.toString()).forEach(m => handleBotMessage(bot, m)); } catch (e) {} });
        ws.on('close', () => { bot.status = 'disconnected'; io.emit('botDisconnected', { name: bot.originalName }); });
        ws.on('error', () => { bot.status = 'failed'; });
        return botId;
    } catch (e) {
        io.emit('botJoinFail', { message: e.message });
        return null;
    }
}

// Flag to stop spawning
let stopSpawning = false;

// Spawn bots
app.post('/api/spawn', async (req, res) => {
    const { pin, count, baseName, bypass } = req.body || {};
    if (!pin || !/^\d+$/.test(String(pin))) return res.status(400).json({ error: 'Invalid PIN' });
    const c = Math.max(1, Math.min(parseInt(count, 10) || 1, 100));
    const name = String(baseName || 'Bot');
    
    stopSpawning = false;
    res.json({ message: 'Spawning bots...', count: c });
    
    for (let i = 0; i < c; i++) {
        if (stopSpawning) {
            io.emit('spawnStopped', { spawned: i, total: c });
            break;
        }
        const suffix = c === 1 ? '' : `-${Math.random().toString(36).slice(2, 5)}`;
        createBot(pin, `${name}${suffix}`, bypass === true);
        await new Promise(r => setTimeout(r, 100));
    }
});

// Stop spawning
app.post('/api/stop-spawn', (req, res) => {
    stopSpawning = true;
    res.json({ stopped: true });
});

// Return current bot stats
app.get('/api/bots', (req, res) => {
    const total = bots.length;
    const joined = bots.filter(b => b.status === 'joined').length;
    const failed = bots.filter(b => b.status === 'failed').length;
    const connecting = bots.filter(b => b.status === 'connecting').length;
    res.json({ total, joined, failed, connecting });
});

// Debug endpoint to see bot states
app.get('/api/bots/debug', (req, res) => {
    const botInfo = bots.map(b => ({
        name: b.originalName,
        status: b.status,
        questionIndex: b.questionIndex,
        answered: b.answered
    }));
    res.json(botInfo);
});

// Set answer mode
app.post('/api/answer-mode', (req, res) => {
    const { mode } = req.body || {};
    currentAnswerMode = mode || 'manual';
    const joined = bots.filter(b => b.status === 'joined').length;
    res.json({ mode: currentAnswerMode, sent: joined });
});

app.get('/api/answer-mode', (req, res) => {
    res.json({ mode: currentAnswerMode });
});

// Send answer to all bots
app.post('/api/answer', (req, res) => {
    let { answer } = req.body || {};
    if (answer === 'random') answer = Math.floor(Math.random() * 4);
    else if (answer === 'first' || answer === 'red') answer = 0;
    else if (answer === 'second' || answer === 'blue') answer = 1;
    else if (answer === 'third' || answer === 'yellow') answer = 2;
    else if (answer === 'fourth' || answer === 'green') answer = 3;
    
    answer = parseInt(answer);
    if (isNaN(answer) || answer < 0 || answer > 7) return res.status(400).json({ error: 'Invalid answer' });
    
    // Force reset answered flag for manual answer (user is explicitly sending)
    for (const bot of bots) {
        if (bot.status === 'joined') bot.answered = false;
    }
    
    let sent = 0;
    for (const bot of bots) {
        if (bot.status === 'joined' && sendBotAnswer(bot, answer)) sent++;
    }
    console.log(`[Answer] Sent answer ${answer} to ${sent} bots`);
    io.emit('questionAnswered', { answer, sent });
    res.json({ answer, sent });
});

// Disconnect a bot gracefully
function disconnectBot(bot) {
    if (bot.ws && bot.ws.readyState === WebSocket.OPEN && bot.clientId) {
        try {
            const disconnect = [{ id: String(bot.messageId++), channel: '/meta/disconnect', clientId: bot.clientId, ext: {} }];
            bot.ws.send(JSON.stringify(disconnect));
        } catch (e) {}
    }
    try { bot.ws.close(); } catch (e) {}
    bot.status = 'disconnected';
}

// Kill all bots
app.post('/api/kill-all', (req, res) => {
    let killed = 0;
    for (const bot of bots) {
        disconnectBot(bot);
        killed++;
    }
    bots.length = 0;
    res.json({ killed });
});

app.post('/api/leave', (req, res) => {
    let killed = 0;
    for (const bot of bots) {
        disconnectBot(bot);
        killed++;
    }
    bots.length = 0;
    res.json({ killed });
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
    console.log('Dashboard connected');
    socket.on('disconnect', () => console.log('Dashboard disconnected'));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});

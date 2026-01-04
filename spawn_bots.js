const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const pin = process.argv[2];
const count = parseInt(process.argv[3], 10) || 1;
const baseName = process.argv[4] || 'Bot';

if (!pin) {
  console.error('Usage: node spawn_bots.js <pin> <count> [baseName]');
  process.exit(1);
}

const logsDir = path.join(__dirname, 'bot-logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

const children = [];
let spawnedAttempts = 0;
let joined = 0;
let failed = 0;
let spawning = 0;

// Control concurrency
const BATCH_SIZE = 12; // concurrent spawn limit
const START_DELAY = 50; // ms between spawn checks

const MAX_ATTEMPTS = Math.max(100, count * 3); // safety cap to avoid infinite loops

function successMarker(s) {
  s = String(s || '').toLowerCase();
  return s.includes('login successful') || s.includes('loginresponse') || s.includes('=== success ===');
}

function spawnOne(slotId) {
  const name = `${baseName}${spawnedAttempts + 1}-${Math.random().toString(36).slice(2,5)}`;
  spawnedAttempts++;
  spawning++;

  const child = spawn(process.execPath, [path.join(__dirname, 'join.js'), pin, name], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const entry = { name, pid: child.pid, child, joined: false };
  children.push(entry);

  // Monitor stdout for success
  child.stdout.on('data', (chunk) => {
    const s = String(chunk || '');
    if (!entry.joined && successMarker(s)) {
      entry.joined = true;
      joined++;
      spawning--;
      console.log(`+ Joined: ${entry.name} (pid=${entry.pid}) — ${joined}/${count}`);
    }
  });

  child.stderr.on('data', () => {
    // treat stderr as potential failure indicator; handled on exit
  });

  child.on('exit', (code) => {
    if (!entry.joined) {
      failed++;
      spawning = Math.max(0, spawning - 1);
      console.log(`- Failed: ${entry.name} (code=${code}) — failed=${failed}`);
    }
    // If not yet reached requested joined count, try to spawn replacements
    trySpawnLoop();
  });
}

function trySpawnLoop() {
  // Spawn until we have enough joined bots or we've attempted too many times
  while ((joined + spawning) < count && spawnedAttempts < MAX_ATTEMPTS) {
    if (spawning >= BATCH_SIZE) break;
    spawnOne(children.length);
  }

  // If we've reached enough joined, print summary and exit after short delay
  if (joined >= count) {
    console.log(`\nTarget reached: ${joined}/${count} joined.`);
    return;
  }

  // Continue checking periodically
  if (spawnedAttempts < MAX_ATTEMPTS) {
    setTimeout(trySpawnLoop, START_DELAY);
  } else {
    console.log(`\nMax attempts reached. joined=${joined}, failed=${failed}, attempts=${spawnedAttempts}`);
  }
}

// Kick off spawning
trySpawnLoop();

// Handle Ctrl+C: kill children and exit
process.on('SIGINT', () => {
  console.log('\nKilling all child processes...');
  for (const e of children) {
    try { if (e.child) e.child.kill(); } catch (ex) {}
  }
  console.log(`Killed ${children.length} children.`);
  process.exit(0);
});

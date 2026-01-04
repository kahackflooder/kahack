const { spawn } = require('child_process');

const tunnel = spawn('C:\\Users\\sebmo\\Downloads\\cloudflared.exe', ['tunnel', '--url', 'http://localhost:9235'], {
    stdio: 'inherit'
});

tunnel.on('close', (code) => {
    console.log(`Cloudflared exited with code ${code}`);
    process.exit(code);
});

process.on('SIGINT', () => {
    tunnel.kill();
    process.exit();
});

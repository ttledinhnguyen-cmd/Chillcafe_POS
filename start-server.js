// Robust auto-restart wrapper with crash protection, memory monitoring, and logging
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'server-monitor.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const RESTART_DELAY = 3000;
const MAX_RAPID_RESTARTS = 5;
const RAPID_RESTART_WINDOW = 60000;
const MEMORY_CHECK_INTERVAL = 5 * 60 * 1000;
const MAX_MEMORY_MB = 512;

let restartTimes = [];
let child = null;
let memoryCheckTimer = null;

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
            const backup = LOG_FILE + '.old';
            if (fs.existsSync(backup)) fs.unlinkSync(backup);
            fs.renameSync(LOG_FILE, backup);
        }
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) {}
}

function startServer() {
    const now = Date.now();
    restartTimes.push(now);
    restartTimes = restartTimes.filter(t => now - t < RAPID_RESTART_WINDOW);

    if (restartTimes.length > MAX_RAPID_RESTARTS) {
        const waitTime = 60;
        log(`CRASH LOOP DETECTED: ${restartTimes.length} restarts in 1 min. Waiting ${waitTime}s before retry...`);
        setTimeout(() => {
            restartTimes = [];
            startServer();
        }, waitTime * 1000);
        return;
    }

    log('Starting server...');

    child = spawn('node', ['--max-old-space-size=1024', 'server.js'], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'production' }
    });

    child.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) log(`[SERVER] ${msg}`);
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) log(`[ERROR] ${msg}`);
    });

    child.on('exit', (code, signal) => {
        log(`Server exited: code=${code} signal=${signal}. Restarting in ${RESTART_DELAY/1000}s...`);
        clearInterval(memoryCheckTimer);
        child = null;
        setTimeout(startServer, RESTART_DELAY);
    });

    child.on('error', (err) => {
        log(`Server spawn error: ${err.message}. Restarting in ${RESTART_DELAY/1000}s...`);
        clearInterval(memoryCheckTimer);
        child = null;
        setTimeout(startServer, RESTART_DELAY);
    });

    memoryCheckTimer = setInterval(() => {
        if (!child || !child.pid) return;
        try {
            const usage = process.memoryUsage();
            const rss = Math.round(usage.rss / 1024 / 1024);
            if (rss > MAX_MEMORY_MB) {
                log(`MEMORY WARNING: ${rss}MB > ${MAX_MEMORY_MB}MB limit. Restarting server...`);
                child.kill('SIGTERM');
            }
        } catch (e) {}
    }, MEMORY_CHECK_INTERVAL);

    log(`Server started with PID ${child.pid}`);
}

process.on('SIGTERM', () => { log('Monitor SIGTERM'); if (child) child.kill('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('Monitor SIGINT'); if (child) child.kill('SIGTERM'); process.exit(0); });
process.on('uncaughtException', (err) => { log(`Monitor error: ${err.message}`); });
process.on('unhandledRejection', (reason) => { log(`Monitor rejection: ${reason}`); });

log('=== CHILL CAFE SERVER MONITOR STARTED ===');
startServer();

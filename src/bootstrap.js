const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const {
    PORT,
    TRUST_PROXY_HOPS,
    PUBLIC_DIR,
    WORK_DIR,
    COOKIES_PATH
} = require('./config');
const { Logger } = require('./logger');
const { AppError, classifyError, sendError } = require('./errors');
const { downloadQueue } = require('./queue');
const { registerRoutes } = require('./routes');

function sweepWorkDir(staleOnly = true) {
    const staleBefore = staleOnly ? Date.now() - 6 * 60 * 60 * 1000 : Infinity;
    const prefixes = ['ripcord_', 'out_', 'track_', 'cover_', 'tagged_', 'comments_'];
    let removed = 0;
    try {
        for (const entry of fs.readdirSync(WORK_DIR, { withFileTypes: true })) {
            if (!entry.isFile() || !prefixes.some(prefix => entry.name.startsWith(prefix))) continue;
            const filePath = path.join(WORK_DIR, entry.name);
            try {
                if (!staleOnly || fs.statSync(filePath).mtimeMs < staleBefore) {
                    fs.unlinkSync(filePath);
                    removed++;
                }
            } catch (error) {
                Logger.warn(`Unable to sweep temporary file ${entry.name}: ${error.message}`);
            }
        }
    } catch (error) {
        Logger.warn(`Unable to sweep work directory ${WORK_DIR}: ${error.message}`);
    }
    Logger.info(`Temporary file sweep removed ${removed} ${staleOnly ? 'stale ' : ''}file(s) from ${WORK_DIR}`);
}

const cleanupStaleWorkFiles = () => sweepWorkDir(true);

if (COOKIES_PATH) {
    Logger.warn(`DEPRECATION WARNING: YTDLP_COOKIES_PATH (${COOKIES_PATH}) is deprecated and will be removed in a future release. Use AGE_GATE_COOKIES=on with YTDLP_AGE_COOKIES_DIR instead. Cookies are now scoped strictly to age-gate retries.`);
}

cleanupStaleWorkFiles();

let isShuttingDown = false;
let serverInstance = null;
let shutdownPromise = null;

function createApp() {
    const app = express();

    app.disable('x-powered-by');
    app.set('trust proxy', TRUST_PROXY_HOPS);

function isPrivateOrLoopbackIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    let cleanIp = ip.trim();
    if (cleanIp.startsWith('::ffff:')) {
        cleanIp = cleanIp.slice(7);
    }
    if (cleanIp === '::1' || cleanIp === 'localhost') return true;

    const parts = cleanIp.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255)) {
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    }
    if (/^f[cd][0-9a-f]{2}:/i.test(cleanIp) || /^fe80:/i.test(cleanIp)) return true;
    return false;
}

let warnedPrivateProxy = false;
function checkProxySanity(req) {
    if (warnedPrivateProxy) return;
    if (!req.path || !req.path.startsWith('/api')) return;
    const isUnset = process.env.TRUST_PROXY_HOPS === undefined || process.env.TRUST_PROXY_HOPS === '' || Number(process.env.TRUST_PROXY_HOPS) === 0;
    if (isUnset) {
        let clientIp = req.ip || req.socket?.remoteAddress || '';
        if (clientIp.startsWith('::ffff:')) {
            clientIp = clientIp.slice(7);
        }
        if (isPrivateOrLoopbackIp(clientIp)) {
            warnedPrivateProxy = true;
            Logger.warn('Detected client IP is in a private, loopback, or container network range on first API request. If running behind a reverse proxy, TRUST_PROXY_HOPS is probably wrong (set to 1 or higher so per-IP rate limiting works correctly).');
        }
    }
}

// Attach request ID, logger, and response header to every request early
    app.use((req, res, next) => {
        checkProxySanity(req);
        const rawHeader = req.headers['x-request-id'];
        const validHeader = typeof rawHeader === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(rawHeader);
        req.id = validHeader ? rawHeader : randomUUID();
        res.setHeader('X-Request-Id', req.id);
        req.logger = Logger.child({ requestId: req.id });
        next();
    });

    app.use((req, res, next) => {
        if (isShuttingDown) {
            res.setHeader('Connection', 'close');
            return sendError(res, new AppError('SERVER_SHUTTING_DOWN'), req);
        }
        next();
    });

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                imgSrc: ["'self'", 'data:'],
                objectSrc: ["'none'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                upgradeInsecureRequests: null
            }
        }
    }));

    // serve static files only after every API path has passed common protections
    app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));

    // Mount API and frontend routes
    registerRoutes(app);

    // Unhandled request error handler
    app.use((err, req, res, _next) => {
        Logger.error(`Unhandled request error: ${err.message}`);
        if (res.headersSent) return res.destroy();
        sendError(res, classifyError(err), req);
    });

    return app;
}

const app = createApp();

function gracefulShutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    Logger.info(`Received ${signal}. Initiating graceful shutdown...`);
    isShuttingDown = true;

    shutdownPromise = (async () => {
        downloadQueue.stopAccepting();

        if (serverInstance) {
            await new Promise((resolve) => {
                serverInstance.close((err) => {
                    if (err) Logger.warn(`Error closing HTTP server: ${err.message}`);
                    else Logger.info('HTTP server closed.');
                    resolve();
                });
            });
        }

        downloadQueue.abortAll();

        const drainStart = Date.now();
        while (downloadQueue.running > 0 && Date.now() - drainStart < 5000) {
            await new Promise(r => setTimeout(r, 100));
        }

        sweepWorkDir(false);

        Logger.success('Graceful shutdown complete.');
        if (signal !== 'test') {
            process.exit(signal === 'uncaughtException' ? 1 : 0);
        }
    })();

    const forceExitTimeout = setTimeout(() => {
        Logger.error('Graceful shutdown timed out, forcing exit.');
        sweepWorkDir(false);
        process.exit(1);
    }, 10000);
    forceExitTimeout.unref();

    return shutdownPromise;
}

process.on('unhandledRejection', (reason) => {
    Logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`);
});

process.on('uncaughtException', (err) => {
    Logger.error(`Uncaught Exception: ${err.stack || err.message}`);
    gracefulShutdown('uncaughtException');
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function startServer(port = PORT) {
    if (serverInstance) return serverInstance;
    serverInstance = app.listen(port, '0.0.0.0', () => {
        Logger.success(`Ripcord server live at http://localhost:${port}`);
        Logger.info('Ready for requests under domain');
    });
    serverInstance.headersTimeout = 15000;
    serverInstance.requestTimeout = 30000;
    serverInstance.keepAliveTimeout = 5000;
    return serverInstance;
}

function getServerInstance() {
    return serverInstance;
}

module.exports = {
    app,
    createApp,
    startServer,
    getServerInstance,
    gracefulShutdown,
    sweepWorkDir,
    cleanupStaleWorkFiles
};

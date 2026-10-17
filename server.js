require('dotenv').config();
process.umask(0o077);
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { spawn, spawnSync } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

function findExecutableInPath(command) {
    const extensions = process.platform === 'win32'
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
        : [''];

    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
        for (const extension of extensions) {
            const candidate = path.resolve(directory || '.', `${command}${extension}`);
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch (e) { }
        }
    }
    return null;
}

// Resolve directly from PATH so broken local `which` shims cannot hide system FFmpeg.
const ffmpegPath = findExecutableInPath('ffmpeg') || ffmpegStatic || 'ffmpeg';
const ffprobePath = findExecutableInPath('ffprobe') || 'ffprobe';

// make sure yt-dlp is installed and in the system path
const checkYtdlp = spawnSync('yt-dlp', ['--version']);
const ytdlpAvailable = checkYtdlp.status === 0;
const ytdlpVersion = ytdlpAvailable ? checkYtdlp.stdout.toString().trim() : 'NOT INSTALLED';

// optional cookies file if youtube starts blocking downloads
function resolveCookiesPath() {
    const raw = (process.env.YTDLP_COOKIES_PATH || '').trim();
    if (raw && raw.toLowerCase() !== 'none' && raw.toLowerCase() !== 'false' && fs.existsSync(raw)) {
        return raw;
    }
    const defaultFile = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(defaultFile)) {
        return defaultFile;
    }
    return null;
}
const COOKIES_PATH = resolveCookiesPath();

function redactLog(str) {
    if (typeof str !== 'string') {
        if (str === null || str === undefined) return '';
        if (str instanceof Error) str = str.stack || str.message;
        else str = String(str);
    }

    let out = str;

    // 1. Redact known cookies paths
    if (typeof COOKIES_PATH === 'string' && COOKIES_PATH) {
        out = out.split(COOKIES_PATH).join('[cookies.txt]');
    }
    if (process.env.YTDLP_COOKIES_PATH) {
        out = out.split(process.env.YTDLP_COOKIES_PATH).join('[cookies.txt]');
    }
    if (process.env.YTDLP_AGE_COOKIES_DIR) {
        out = out.split(process.env.YTDLP_AGE_COOKIES_DIR).join('[cookies_dir]');
    }

    // 2. Redact sensitive key=value patterns (tokens, auth, sid, cookies, secret, canary)
    out = out.replace(/(?:cookie|token|auth|sid|secret|password|canary|access_token|refresh_token)\s*[:=]\s*([^\s,;&"']+)/gi, (match) => {
        const prefix = match.split(/[:=]/)[0];
        return `${prefix}=[REDACTED]`;
    });

    // Bare canary tokens (e.g. COOKIE_CANARY_12345)
    out = out.replace(/COOKIE_CANARY_\w+/gi, '[CANARY_REDACTED]');

    // 3. URLs: strip query parameters except keep video ID for YouTube
    out = out.replace(/https?:\/\/[^\s"'<>)\]]+/g, (urlStr) => {
        try {
            const u = new URL(urlStr);
            if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(u.hostname.toLowerCase())) {
                const v = u.searchParams.get('v');
                return `${u.protocol}//${u.hostname}${u.pathname}${v ? `?v=${v}` : ''}`;
            }
            if (u.hostname.toLowerCase() === 'youtu.be') {
                return `${u.protocol}//${u.hostname}${u.pathname}`;
            }
            u.search = '';
            u.hash = '';
            return u.toString();
        } catch {
            return urlStr;
        }
    });

    // 4. IP addresses: truncate IPv4
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => {
        const parts = ip.split('.');
        if (parts.length === 4 && parts.every(p => Number(p) >= 0 && Number(p) <= 255)) {
            return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
        }
        return ip;
    });

    // 5. Filesystem absolute paths to basenames (skipping URLs)
    out = out.replace(/(?:^|[\s"'`([])(?:[a-zA-Z]:\\|\/)(?:[a-zA-Z0-9_.-]+[\\\/])+[a-zA-Z0-9_.-]+/g, (fullMatch) => {
        const lead = fullMatch.match(/^[\s"'`(\[]/) ? fullMatch[0] : '';
        const rawPath = fullMatch.slice(lead.length);
        if (rawPath.startsWith('//') || rawPath.includes('://')) return fullMatch;
        return lead + path.basename(rawPath);
    });

    // 6. Cap line length
    if (out.length > 2000) {
        out = out.slice(0, 2000) + '...[truncated]';
    }

    return out;
}

const LOG_LEVELS = { debug: 10, info: 20, success: 20, warn: 30, error: 40 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const LOG_FORMAT = String(process.env.LOG_FORMAT || 'pretty').toLowerCase() === 'json' ? 'json' : 'pretty';

class StructuredLogger {
    constructor(context = {}) {
        this.context = context;
    }

    child(extra = {}) {
        return new StructuredLogger({ ...this.context, ...extra });
    }

    _log(levelStr, msg, meta = {}) {
        const numericLevel = LOG_LEVELS[levelStr.toLowerCase()] || 20;
        if (numericLevel < CURRENT_LOG_LEVEL) return;

        const ts = new Date().toISOString();
        const mergedMeta = { ...this.context, ...meta };
        const cleanMsg = redactLog(msg);

        if (LOG_FORMAT === 'json') {
            const entry = {
                ts,
                level: levelStr,
                msg: cleanMsg
            };
            for (const key of ['requestId', 'jobId', 'stage', 'trackIndex', 'durationMs', 'code', 'okCount', 'failedCount', 'failures']) {
                if (mergedMeta[key] !== undefined) entry[key] = mergedMeta[key];
            }
            const serialized = JSON.stringify(entry);
            if (levelStr === 'ERROR') console.error(serialized);
            else if (levelStr === 'WARN') console.warn(serialized);
            else console.log(serialized);
        } else {
            const colors = {
                DEBUG: '\x1b[90m',
                INFO: '\x1b[36m',
                SUCCESS: '\x1b[32m',
                WARN: '\x1b[33m',
                ERROR: '\x1b[31m',
                RESET: '\x1b[0m'
            };
            const time = ts.replace('T', ' ').substring(0, 19);
            const reqPart = mergedMeta.requestId ? ` [${mergedMeta.requestId.slice(0, 8)}]` : '';
            const jobPart = mergedMeta.jobId ? ` [job:${mergedMeta.jobId.slice(0, 8)}]` : '';
            const stagePart = mergedMeta.stage ? ` [${mergedMeta.stage}]` : '';
            const trackPart = mergedMeta.trackIndex !== undefined ? ` [track:${mergedMeta.trackIndex + 1}]` : '';
            const durationPart = mergedMeta.durationMs !== undefined ? ` (${mergedMeta.durationMs}ms)` : '';
            const codePart = mergedMeta.code ? ` [code:${mergedMeta.code}]` : '';

            const prefix = `${colors[levelStr] || ''}[${time}] [${levelStr}]${colors.RESET}${reqPart}${jobPart}${stagePart}${trackPart}${codePart}`;
            const line = `${prefix} ${cleanMsg}${durationPart}`;
            if (levelStr === 'ERROR') console.error(line);
            else if (levelStr === 'WARN') console.warn(line);
            else console.log(line);
        }
    }

    debug(msg, meta) { this._log('DEBUG', msg, meta); }
    info(msg, meta) { this._log('INFO', msg, meta); }
    success(msg, meta) { this._log('SUCCESS', msg, meta); }
    warn(msg, meta) { this._log('WARN', msg, meta); }
    error(msg, meta) { this._log('ERROR', msg, meta); }
}

const Logger = new StructuredLogger();

function startStage(logger, stage, meta = {}) {
    const activeLogger = logger || Logger;
    const start = Date.now();
    const stageLogger = activeLogger.child({ stage, ...meta });
    stageLogger.debug(`Stage started: ${stage}`);
    return {
        logger: stageLogger,
        end(status = 'ok', extra = {}) {
            const durationMs = Date.now() - start;
            if (status === 'ok') {
                stageLogger.info(`Stage completed: ${stage}`, { durationMs, ...extra });
            } else {
                stageLogger.warn(`Stage failed: ${stage}`, { durationMs, ...extra });
            }
            return durationMs;
        }
    };
}

Logger.info('Ripcord audio engine initializing');
Logger.info(`yt-dlp version: ${ytdlpVersion}`);
Logger.info(`ffmpeg path: ${ffmpegPath}`);

// Unified application error codes, safe user messages, and HTTP status mappings
const ERROR_DEFINITIONS = {
    INVALID_URL: {
        httpStatus: 400,
        userMessage: 'Please enter a valid Spotify or YouTube URL.',
        retryable: false,
        action: null
    },
    UNSUPPORTED_URL: {
        httpStatus: 400,
        userMessage: 'Unsupported URL. Please provide a Spotify or YouTube link.',
        retryable: false,
        action: null
    },
    UNSUPPORTED_FORMAT: {
        httpStatus: 400,
        userMessage: 'Unsupported audio format or bitrate.',
        retryable: false,
        action: null
    },
    MIX_NOT_SUPPORTED: {
        httpStatus: 400,
        userMessage: 'YouTube Mix/Radio playlists are dynamic and cannot be downloaded as collections. Please link a specific track or curated playlist.',
        retryable: false,
        action: null
    },
    QUEUE_FULL: {
        httpStatus: 503,
        userMessage: 'The queue is full. Please try again shortly.',
        retryable: true,
        action: 'retry',
        retryAfterSeconds: 5
    },
    RATE_LIMITED: {
        httpStatus: 429,
        userMessage: 'Too many requests. Please wait before trying again.',
        retryable: true,
        action: 'retry',
        retryAfterSeconds: 60
    },
    SERVER_SHUTTING_DOWN: {
        httpStatus: 503,
        userMessage: 'Server is shutting down.',
        retryable: true,
        action: 'retry',
        retryAfterSeconds: 10
    },
    AGE_RESTRICTED: {
        httpStatus: 403,
        userMessage: "This video is age-restricted and can't be downloaded on this server.",
        retryable: false,
        action: null
    },
    LOGIN_REQUIRED: {
        httpStatus: 403,
        userMessage: 'Sign in or bot verification is required for this content.',
        retryable: false,
        action: null
    },
    PRIVATE_OR_UNAVAILABLE: {
        httpStatus: 404,
        userMessage: 'This media is private, removed, or unavailable.',
        retryable: false,
        action: null
    },
    REGION_BLOCKED: {
        httpStatus: 403,
        userMessage: 'This video is not available in the server’s geographic region.',
        retryable: false,
        action: null
    },
    MEMBERS_ONLY: {
        httpStatus: 403,
        userMessage: 'This video is only available to channel members.',
        retryable: false,
        action: null
    },
    LIVE_NOT_SUPPORTED: {
        httpStatus: 400,
        userMessage: 'Live streams cannot be downloaded until the broadcast has ended.',
        retryable: false,
        action: null
    },
    TOO_LARGE: {
        httpStatus: 413,
        userMessage: 'The audio file exceeds the maximum allowed size limit.',
        retryable: false,
        action: null
    },
    TOO_LONG: {
        httpStatus: 413,
        userMessage: 'The media duration exceeds the maximum allowed limit.',
        retryable: false,
        action: null
    },
    NETWORK_TIMEOUT: {
        httpStatus: 504,
        userMessage: 'Network connection to upstream provider timed out.',
        retryable: true,
        action: 'retry'
    },
    NO_MATCH: {
        httpStatus: 404,
        userMessage: 'No matching audio track could be found.',
        retryable: false,
        action: null
    },
    SPOTIFY_UNREADABLE: {
        httpStatus: 502,
        userMessage: 'Unable to extract Spotify metadata. The track/playlist may be private or restricted.',
        retryable: false,
        action: null
    },
    ENCODE_FAILED: {
        httpStatus: 500,
        userMessage: 'Audio encoding failed.',
        retryable: true,
        action: 'retry'
    },
    TIMEOUT: {
        httpStatus: 504,
        userMessage: 'Processing timed out. Please try again.',
        retryable: true,
        action: 'retry'
    },
    CANCELLED: {
        httpStatus: 499,
        userMessage: 'The request was cancelled.',
        retryable: false,
        action: null
    },
    INTERNAL: {
        httpStatus: 500,
        userMessage: 'An internal server error occurred.',
        retryable: true,
        action: 'retry'
    }
};

class AppError extends Error {
    constructor(code, overrides = {}) {
        const def = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.INTERNAL;
        const resolvedCode = (code in ERROR_DEFINITIONS) ? code : 'INTERNAL';
        const userMsg = overrides.userMessage || def.userMessage;
        super(userMsg);
        this.name = 'AppError';
        this.code = resolvedCode;
        this.httpStatus = overrides.httpStatus || def.httpStatus;
        this.userMessage = userMsg;
        this.retryable = overrides.retryable !== undefined ? overrides.retryable : def.retryable;
        this.action = overrides.action !== undefined ? overrides.action : (def.action || null);
        this.internalDetail = overrides.internalDetail || null;
        this.retryAfterSeconds = overrides.retryAfterSeconds !== undefined ? overrides.retryAfterSeconds : (def.retryAfterSeconds || null);
    }
}

const CLASSIFIER_RULES = [
    {
        code: 'CANCELLED',
        test: (combined, err) => err?.name === 'AbortError' || err?.code === 'ERR_CANCELED' || /request cancelled|request aborted|abort\(|aborted/i.test(combined)
    },
    {
        code: 'RATE_LIMITED',
        test: (combined, err) => err?.status === 429 || err?.response?.status === 429 || /http error 429|too many requests|rate limit/i.test(combined)
    },
    {
        code: 'AGE_RESTRICTED',
        test: (combined) => /sign in to confirm your age|confirm your age|age-restricted|inappropriate for some users|requires age confirmation/i.test(combined)
    },
    {
        code: 'LOGIN_REQUIRED',
        test: (combined) => /sign in to confirm you('?re| are) not a bot|confirm you('?re| are) not a bot|bot check|login required|solve the captcha|please sign in/i.test(combined)
    },
    {
        code: 'REGION_BLOCKED',
        test: (combined) => /not available in your country|blocked it in your country|geo-restricted|geographic region|geoblocked|uploader has not made this video available in your country/i.test(combined)
    },
    {
        code: 'MEMBERS_ONLY',
        test: (combined) => /join this channel to get access|members-only|members only/i.test(combined)
    },
    {
        code: 'PRIVATE_OR_UNAVAILABLE',
        test: (combined) => /private video|video is private|this video is private|video unavailable|video has been removed|this video is unavailable|deleted by the uploader|does not exist|media is not available/i.test(combined)
    },
    {
        code: 'LIVE_NOT_SUPPORTED',
        test: (combined) => /is a live stream|is currently live|live event will begin|premieres in|live stream recording is not available/i.test(combined)
    },
    {
        code: 'TOO_LARGE',
        test: (combined) => /file is larger than max-filesize|max-filesize|exceeds the allowed size|file size exceeds|audio output exceeds the allowed size|playlist track exceeds the allowed size|cover image exceeds size limit/i.test(combined)
    },
    {
        code: 'TOO_LONG',
        test: (combined) => /video is too long|duration exceeds|duration is longer than/i.test(combined)
    },
    {
        code: 'NETWORK_TIMEOUT',
        test: (combined, err) => ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code) ||
            /connect timed out|read timed out|socket hang up|network is unreachable|econnreset|econnrefused|esockettimedout|etimedout/i.test(combined)
    },
    {
        code: 'TIMEOUT',
        test: (combined) => /timed out|timeout/i.test(combined)
    },
    {
        code: 'NO_MATCH',
        test: (combined) => /no search result|no match found|no candidates found|no tracks could be processed/i.test(combined)
    },
    {
        code: 'SPOTIFY_UNREADABLE',
        test: (combined) => /unable to extract spotify metadata|spotify metadata unreadable|invalid spotify link/i.test(combined)
    },
    {
        code: 'ENCODE_FAILED',
        test: (combined) => /ffmpeg encoding failed|conversion failed|invalid data found when processing input|error while opening encoder/i.test(combined)
    },
    {
        code: 'QUEUE_FULL',
        test: (combined) => /queue is full/i.test(combined)
    },
    {
        code: 'MIX_NOT_SUPPORTED',
        test: (combined) => /youtube mix\/radio playlists are dynamic/i.test(combined)
    },
    {
        code: 'UNSUPPORTED_FORMAT',
        test: (combined) => /unsupported audio format|unsupported audio bitrate/i.test(combined)
    },
    {
        code: 'UNSUPPORTED_URL',
        test: (combined) => /unsupported url/i.test(combined)
    },
    {
        code: 'INVALID_URL',
        test: (combined) => /invalid url|please enter a valid|filename is invalid|title is invalid|image host not allowed|not an image|cross-site requests are not allowed|unsupported or unreadable url format|api endpoint not found/i.test(combined)
    },
    {
        code: 'SERVER_SHUTTING_DOWN',
        test: (combined) => /server is shutting down/i.test(combined)
    }
];

function classifyError(err, stderr = '') {
    if (err instanceof AppError) return err;

    const errMessage = err?.message || (typeof err === 'string' ? err : '');
    const errStderr = err?.stderr || (typeof stderr === 'string' ? stderr : '');
    const combined = `${errMessage}\n${errStderr}\n${stderr || ''}`;

    for (const rule of CLASSIFIER_RULES) {
        if (rule.test(combined, err)) {
            return new AppError(rule.code, {
                internalDetail: combined.trim().slice(-1000)
            });
        }
    }

    return new AppError('INTERNAL', {
        internalDetail: combined.trim().slice(-1000)
    });
}

function sendError(res, error, req = null) {
    const appErr = error instanceof AppError ? error : classifyError(error, error?.stderr || '');
    const requestId = req?.id || res.getHeader('X-Request-Id') || randomUUID();
    res.setHeader('X-Request-Id', requestId);
    if (res.headersSent) {
        if (!res.destroyed) res.destroy();
        return;
    }
    const responsePayload = {
        error: appErr.userMessage,
        code: appErr.code,
        requestId,
        retryable: appErr.retryable,
        action: appErr.action || null,
        retryAfterSeconds: appErr.retryAfterSeconds || null
    };
    if (appErr.retryAfterSeconds) {
        res.setHeader('Retry-After', String(appErr.retryAfterSeconds));
    }
    return res.status(appErr.httpStatus).json(responsePayload);
}

function positiveIntegerEnv(name, fallback, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(`${name} must be an integer between 1 and ${max}.`);
    }
    return value;
}

const RATE_LIMIT_WINDOW_MS = positiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 24 * 60 * 60 * 1000);
const API_RATE_LIMIT_MAX = positiveIntegerEnv('RATE_LIMIT_MAX', 120, 10000);
const DOWNLOAD_CONCURRENCY = positiveIntegerEnv('DOWNLOAD_CONCURRENCY', 4, 8);
const METADATA_CONCURRENCY = positiveIntegerEnv('METADATA_CONCURRENCY', DOWNLOAD_CONCURRENCY, 8);
const MAX_QUEUED_DOWNLOADS = positiveIntegerEnv('MAX_QUEUED_DOWNLOADS', 8, 100);
const MAX_PLAYLIST_TRACKS = positiveIntegerEnv('MAX_PLAYLIST_TRACKS', 30, 100);
const MAX_PLAYLIST_OUTPUT_BYTES = positiveIntegerEnv('MAX_PLAYLIST_OUTPUT_BYTES', 2 * 1024 * 1024, 16 * 1024 * 1024);
const MAX_COVER_BYTES = positiveIntegerEnv('MAX_COVER_BYTES', 5 * 1024 * 1024, 20 * 1024 * 1024);
const MAX_DOWNLOAD_BYTES = positiveIntegerEnv('MAX_DOWNLOAD_BYTES', 100 * 1024 * 1024, 512 * 1024 * 1024);
const MAX_AUDIO_OUTPUT_BYTES = positiveIntegerEnv('MAX_AUDIO_OUTPUT_BYTES', 150 * 1024 * 1024, 512 * 1024 * 1024);
const MAX_ZIP_TRACK_BYTES = positiveIntegerEnv('MAX_ZIP_TRACK_BYTES', 40 * 1024 * 1024, 128 * 1024 * 1024);
// lossless tracks are ~5-10 MB/min, so they need a larger per-track cap than lossy formats
const zipTrackLimit = format => (format === 'flac' || format === 'wav') ? Math.max(MAX_ZIP_TRACK_BYTES, MAX_AUDIO_OUTPUT_BYTES) : MAX_ZIP_TRACK_BYTES;
const ENCODE_CONCURRENCY = positiveIntegerEnv('ENCODE_CONCURRENCY', Math.max(1, Math.min(2, os.cpus().length)), 8);
const YTDLP_CONCURRENT_FRAGMENTS = positiveIntegerEnv('YTDLP_CONCURRENT_FRAGMENTS', 4, 16);
const WORK_DIR = process.env.WORK_DIR || os.tmpdir();
if (!path.isAbsolute(WORK_DIR)) throw new Error('WORK_DIR must be an absolute path.');
fs.mkdirSync(WORK_DIR, { recursive: true });
const YTDLP_USE_ARIA2C = String(process.env.YTDLP_USE_ARIA2C || '').toLowerCase() === 'true';
const TRUST_PROXY_HOPS_VALUE = process.env.TRUST_PROXY_HOPS === undefined || process.env.TRUST_PROXY_HOPS === ''
    ? 0
    : Number(process.env.TRUST_PROXY_HOPS);
if (!Number.isSafeInteger(TRUST_PROXY_HOPS_VALUE) || TRUST_PROXY_HOPS_VALUE < 0 || TRUST_PROXY_HOPS_VALUE > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
}
const TRUST_PROXY_HOPS = TRUST_PROXY_HOPS_VALUE || false;

if (!ytdlpAvailable) {
    Logger.error('yt-dlp is not installed or not in PATH. Please install yt-dlp: https://github.com/yt-dlp/yt-dlp');
}

const checkAria2c = spawnSync('aria2c', ['--version']);
const aria2cAvailable = checkAria2c.status === 0;
Logger.info(`aria2c: ${aria2cAvailable ? 'available' : 'not installed'}${YTDLP_USE_ARIA2C && aria2cAvailable ? ' (enabled)' : ''}`);

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
cleanupStaleWorkFiles();

if (COOKIES_PATH) {
    Logger.info(`Using yt-dlp cookies from: ${COOKIES_PATH}`);
}

const AGE_GATE_COOKIES_ENABLED = ['1', 'true', 'on', 'yes'].includes(String(process.env.AGE_GATE_COOKIES || 'off').toLowerCase().trim());
const YTDLP_AGE_COOKIES_DIR = process.env.YTDLP_AGE_COOKIES_DIR || '';

class AgeGateCookiePool {
    constructor({
        enabled = false,
        dirPath = '',
        hourlyLimit = 30,
        logger = Logger
    } = {}) {
        this.enabled = enabled;
        this.dirPath = dirPath;
        this.hourlyLimit = hourlyLimit;
        this.logger = logger;
        this.accounts = [];
        this.currentIndex = 0;
    }

    init() {
        if (!this.enabled) {
            return;
        }
        if (!this.dirPath) {
            this.logger.warn('AGE_GATE_COOKIES is enabled but YTDLP_AGE_COOKIES_DIR is not configured.');
            this.enabled = false;
            return;
        }

        const resolvedDir = path.resolve(this.dirPath);
        const publicDir = path.resolve(path.join(__dirname, 'public'));

        // Directory validation: make sure it can NEVER be under public/ or web root
        if (resolvedDir === publicDir || resolvedDir.startsWith(publicDir + path.sep)) {
            this.logger.error('YTDLP_AGE_COOKIES_DIR is inside public directory. Disabling age-gate cookie pool for security.');
            this.enabled = false;
            return;
        }

        if (!fs.existsSync(resolvedDir)) {
            this.logger.warn(`YTDLP_AGE_COOKIES_DIR directory does not exist: [cookies_dir]`);
            this.enabled = false;
            return;
        }

        let entries;
        try {
            entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
        } catch (err) {
            this.logger.warn(`Failed to read YTDLP_AGE_COOKIES_DIR: ${err.message}`);
            this.enabled = false;
            return;
        }

        let accountIndex = 1;
        this.accounts = [];

        for (const entry of entries) {
            if (!entry.isFile() || entry.name.startsWith('.')) continue;
            const fullPath = path.join(resolvedDir, entry.name);

            try {
                const stat = fs.statSync(fullPath);
                // Check file permissions: warn if broader than owner-only (0600 / 0400)
                if ((stat.mode & 0o077) !== 0) {
                    this.logger.warn(`Cookie file permissions broader than owner-only (mode 0${(stat.mode & 0o777).toString(8)}): account-${accountIndex}`);
                }

                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split(/\r?\n/);

                // Startup validation 1: Netscape format check
                const isNetscape = lines.some(l => l.includes('# Netscape HTTP Cookie File') || l.includes('# HTTP Cookie File'));
                if (!isNetscape) {
                    this.logger.warn(`Skipping non-Netscape cookie file: account-${accountIndex}`);
                    continue;
                }

                // Startup validation 2: Domain restriction check
                const unexpectedDomains = new Set();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const parts = trimmed.split('\t');
                    if (parts.length >= 7) {
                        const domain = parts[0].toLowerCase();
                        if (!domain.includes('youtube.com') && !domain.includes('google.com')) {
                            unexpectedDomains.add(domain);
                        }
                    }
                }

                if (unexpectedDomains.size > 0) {
                    this.logger.warn(`Cookie file contains unexpected domain(s): account-${accountIndex}`);
                }

                this.accounts.push({
                    id: `account-${accountIndex++}`,
                    filename: entry.name,
                    filePath: fullPath,
                    active: false,
                    cooldownUntil: 0,
                    failCount: 0,
                    hourlyUsage: []
                });
            } catch (err) {
                this.logger.warn(`Failed to inspect cookie file: ${err.message}`);
            }
        }

        if (this.accounts.length === 0) {
            this.logger.warn('No valid Netscape cookie files found in YTDLP_AGE_COOKIES_DIR.');
            this.enabled = false;
        } else {
            this.logger.info(`Age-gate cookie pool initialized with ${this.accounts.length} valid account(s)`);
        }
    }

    isEnabled() {
        return Boolean(this.enabled && this.accounts.length > 0);
    }

    getHealthyAccount() {
        if (!this.isEnabled()) return null;
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        const count = this.accounts.length;

        for (let i = 0; i < count; i++) {
            const idx = (this.currentIndex + i) % count;
            const acc = this.accounts[idx];

            // clean up hourlyUsage
            acc.hourlyUsage = acc.hourlyUsage.filter(ts => ts > oneHourAgo);

            // check active, cooldown, quota
            if (!acc.active && now >= acc.cooldownUntil && acc.hourlyUsage.length < this.hourlyLimit) {
                this.currentIndex = (idx + 1) % count;
                return acc;
            }
        }
        return null;
    }

    async acquire() {
        const account = this.getHealthyAccount();
        if (!account) return null;

        account.active = true;
        const tempCookiePath = path.join(WORK_DIR, `ripcord_cookie_${randomUUID()}.tmp`);

        try {
            const fd = fs.openSync(tempCookiePath, 'w', 0o600);
            const content = fs.readFileSync(account.filePath);
            fs.writeSync(fd, content);
            fs.closeSync(fd);
        } catch (err) {
            account.active = false;
            try { fs.unlinkSync(tempCookiePath); } catch {}
            throw err;
        }

        const release = (success = false, err = null) => {
            try {
                if (success) {
                    account.failCount = 0;
                    account.hourlyUsage.push(Date.now());

                    // Atomic copy-back if updated
                    try {
                        if (fs.existsSync(tempCookiePath)) {
                            const newContent = fs.readFileSync(tempCookiePath);
                            const oldContent = fs.readFileSync(account.filePath);
                            if (Buffer.compare(newContent, oldContent) !== 0) {
                                const tmpDst = `${account.filePath}.tmp.${randomUUID()}`;
                                const fd = fs.openSync(tmpDst, 'w', 0o600);
                                fs.writeSync(fd, newContent);
                                fs.closeSync(fd);
                                fs.renameSync(tmpDst, account.filePath);
                            }
                        }
                    } catch (syncErr) {
                        this.logger.warn(`Failed to atomic copy-back cookie updates for [${account.id}]: ${syncErr.message}`);
                    }
                } else if (err) {
                    const code = err.code || '';
                    if (code === 'LOGIN_REQUIRED' || code === 'RATE_LIMITED') {
                        account.failCount++;
                        const backoffMs = Math.min(3600000, 60000 * Math.pow(2, account.failCount - 1));
                        account.cooldownUntil = Date.now() + backoffMs;
                        this.logger.warn(`Age-gate account [${account.id}] entering cooldown for ${Math.round(backoffMs / 1000)}s`);
                    }
                }
            } finally {
                try {
                    if (fs.existsSync(tempCookiePath)) {
                        fs.unlinkSync(tempCookiePath);
                    }
                } catch {}
                account.active = false;
            }
        };

        return {
            account,
            cookiePath: tempCookiePath,
            release
        };
    }
}

const ageGateCookiePool = new AgeGateCookiePool({
    enabled: AGE_GATE_COOKIES_ENABLED,
    dirPath: YTDLP_AGE_COOKIES_DIR,
    logger: Logger
});
ageGateCookiePool.init();


// simple download queue so we don't melt the cpu with too many conversions
class DownloadQueue {
    constructor(concurrency = DOWNLOAD_CONCURRENCY, maxQueued = MAX_QUEUED_DOWNLOADS) {
        this.concurrency = concurrency;
        this.maxQueued = maxQueued;
        this.running = 0;
        this.queue = [];
        this.activeEntries = new Set();
        this.shuttingDown = false;
    }

    addTask(task, res, req = null) {
        if (this.shuttingDown) return false;
        if (this.running >= this.concurrency && this.queue.length >= this.maxQueued) return false;

        const entry = { task, res, req, controller: new AbortController(), started: false };
        entry.onClose = () => {
            if (res.writableEnded) return;
            entry.controller.abort();
            if (!entry.started) this.queue = this.queue.filter(queued => queued !== entry);
        };
        res.once('close', entry.onClose);
        this.queue.push(entry);
        Logger.info(`[Queue] Task queued. Position: ${this.queue.length}. Running: ${this.running}/${this.concurrency}`);
        this.process();
        return true;
    }

    process() {
        if (this.shuttingDown) return;
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const entry = this.queue.shift();
        entry.started = true;
        this.activeEntries.add(entry);

        if (entry.controller.signal.aborted || entry.res.destroyed) {
            entry.res.removeListener('close', entry.onClose);
            this.activeEntries.delete(entry);
            this.running--;
            this.process();
            return;
        }

        Promise.resolve(entry.task(entry.controller.signal))
            .catch(err => Logger.error(`[Queue] Task failed: ${err.message}`))
            .finally(() => {
                entry.res.removeListener('close', entry.onClose);
                this.activeEntries.delete(entry);
                this.running--;
                this.process();
            });
    }

    stopAccepting() {
        this.shuttingDown = true;
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            entry.res.removeListener('close', entry.onClose);
            entry.controller.abort();
            if (!entry.res.headersSent) {
                sendError(entry.res, new AppError('SERVER_SHUTTING_DOWN'), entry.req);
            } else if (!entry.res.destroyed) {
                entry.res.destroy();
            }
        }
    }

    abortAll() {
        for (const entry of this.activeEntries) {
            entry.controller.abort();
        }
    }
}

// small semaphore so playlist metadata lookups do not spawn without a global limit
class MetadataSemaphore {
    constructor(concurrency = METADATA_CONCURRENCY, maxQueued = MAX_QUEUED_DOWNLOADS) {
        this.concurrency = concurrency;
        this.maxQueued = maxQueued;
        this.running = 0;
        this.queue = [];
    }

    tryAcquire() {
        if (this.running < this.concurrency) {
            this.running++;
            const acquisition = Promise.resolve(this.createRelease());
            acquisition.cancel = () => { };
            return acquisition;
        }
        if (this.queue.length >= this.maxQueued) return null;

        let resolveAcquisition;
        let rejectAcquisition;
        const acquisition = new Promise((resolve, reject) => {
            resolveAcquisition = resolve;
            rejectAcquisition = reject;
        });
        const waiter = { resolve: resolveAcquisition, reject: rejectAcquisition, cancelled: false };
        acquisition.cancel = () => {
            if (waiter.cancelled) return;
            waiter.cancelled = true;
            this.queue = this.queue.filter(queued => queued !== waiter);
            waiter.reject(new Error('Metadata request cancelled.'));
        };
        this.queue.push(waiter);
        return acquisition;
    }

    createRelease() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.running--;
            while (this.queue.length > 0) {
                const waiter = this.queue.shift();
                if (waiter.cancelled) continue;
                this.running++;
                waiter.resolve(this.createRelease());
                break;
            }
        };
    }
}

class Semaphore {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    async acquire(signal) {
        if (signal?.aborted) throw new Error('Request cancelled.');
        if (this.running < this.concurrency) {
            this.running++;
            return;
        }

        await new Promise((resolve, reject) => {
            let waiter;
            const onAbort = () => {
                const idx = this.queue.indexOf(waiter);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                    reject(new Error('Request cancelled.'));
                }
            };

            waiter = {
                resolve: () => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve();
                },
                reject: (err) => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    reject(err);
                }
            };

            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this.queue.push(waiter);
        });
    }

    release() {
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            next.resolve();
            return;
        }
        this.running = Math.max(0, this.running - 1);
    }
}

class AsyncBoundedQueue {
    constructor(capacity) {
        this.capacity = capacity;
        this.items = [];
        this.readers = [];
        this.writers = [];
        this.closed = false;
    }

    async push(value) {
        if (this.closed) throw new Error('Queue is closed.');
        if (this.readers.length > 0) {
            this.readers.shift()(value);
            return;
        }
        if (this.items.length < this.capacity) {
            this.items.push(value);
            return;
        }
        await new Promise((resolve, reject) => this.writers.push({ value, resolve, reject }));
    }

    async shift() {
        if (this.items.length > 0) {
            const value = this.items.shift();
            const writer = this.writers.shift();
            if (writer) {
                this.items.push(writer.value);
                writer.resolve();
            }
            return value;
        }
        if (this.writers.length > 0) {
            const writer = this.writers.shift();
            writer.resolve();
            return writer.value;
        }
        if (this.closed) return null;
        return new Promise(resolve => this.readers.push(resolve));
    }

    close(error = new Error('Queue is closed.')) {
        if (this.closed) return;
        this.closed = true;
        while (this.readers.length > 0) this.readers.shift()(null);
        while (this.writers.length > 0) this.writers.shift().reject(error);
    }
}

const downloadQueue = new DownloadQueue();
const metadataSemaphore = new MetadataSemaphore();
const ytdlpSemaphore = new Semaphore(DOWNLOAD_CONCURRENCY);
const ffmpegSemaphore = new Semaphore(ENCODE_CONCURRENCY);

// set up the express app
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);

// Attach request ID, logger, and response header to every request early
app.use((req, res, next) => {
    const rawHeader = req.headers['x-request-id'];
    const validHeader = typeof rawHeader === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(rawHeader);
    req.id = validHeader ? rawHeader : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    req.logger = Logger.child({ requestId: req.id });
    next();
});

let isShuttingDown = false;
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
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            imgSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            upgradeInsecureRequests: null
        }
    }
}));

function createRateLimiter(limit, message) {
    return rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => sendError(res, new AppError('RATE_LIMITED', { userMessage: message }), req)
    });
}

app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
// per-track progress for collection downloads, keyed by a client-generated job id
const JOB_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const MAX_TRACKED_JOBS = 200;
const downloadJobs = new Map();

function computeJobSummary(job) {
    if (!job || !Array.isArray(job.tracks)) return { total: 0, ok: 0, failed: [] };
    const total = job.tracks.length;
    const failed = [];
    let ok = 0;

    job.tracks.forEach((t, i) => {
        if (t.state === 'done') {
            ok++;
        } else if (t.state === 'failed') {
            failed.push({
                index: i,
                title: t.title || 'Unknown Track',
                artist: t.artist || '',
                code: t.code || 'UNKNOWN',
                error: t.error || 'Track could not be downloaded.'
            });
        }
    });

    if (job.status && job.status !== 'running') {
        job.tracks.forEach((t, i) => {
            if (t.state !== 'done' && t.state !== 'failed') {
                failed.push({
                    index: i,
                    title: t.title || 'Unknown Track',
                    artist: t.artist || '',
                    code: t.code || 'UNKNOWN',
                    error: t.error || 'Track could not be processed.'
                });
            }
        });
        ok = Math.max(0, total - failed.length);
    }

    return { total, ok, failed };
}

function createJob(jobId, tracks) {
    if (!jobId) return null;
    if (downloadJobs.size >= MAX_TRACKED_JOBS) downloadJobs.delete(downloadJobs.keys().next().value);
    const job = {
        status: 'running',
        error: null,
        code: null,
        tracks: tracks.map(track => ({
            title: String(track.title || 'Unknown Track').slice(0, 200),
            artist: String(track.artist || '').slice(0, 200),
            state: 'queued',
            progress: 0,
            code: null,
            error: null
        }))
    };
    job.summary = computeJobSummary(job);
    downloadJobs.set(jobId, job);
    return job;
}

function endJob(jobId, status, errorInfo = null) {
    const job = jobId && downloadJobs.get(jobId);
    if (!job) return;
    job.status = status;
    if (errorInfo) {
        if (errorInfo instanceof AppError) {
            job.error = errorInfo.userMessage;
            job.code = errorInfo.code;
        } else if (typeof errorInfo === 'string') {
            job.error = errorInfo;
            job.code = errorInfo === 'cancelled' ? 'CANCELLED' : 'INTERNAL';
        } else if (errorInfo && typeof errorInfo === 'object') {
            job.error = errorInfo.userMessage || errorInfo.error || errorInfo.message || null;
            job.code = errorInfo.code || null;
        }
    }
    job.summary = computeJobSummary(job);
    setTimeout(() => { if (downloadJobs.get(jobId) === job) downloadJobs.delete(jobId); }, 2 * 60 * 1000).unref();
}

// polled about once a second, so it gets its own budget instead of the main API limit
app.get('/api/progress/:id', createRateLimiter(Math.max(API_RATE_LIMIT_MAX * 20, 2000), 'Too many progress requests.'), rejectCrossSiteRequests, (req, res) => {
    const job = JOB_ID_PATTERN.test(req.params.id) ? downloadJobs.get(req.params.id) : null;
    if (!job) return res.status(404).json({ status: 'pending' });
    const summary = job.summary || computeJobSummary(job);
    res.json({ ...job, summary });
});

app.use('/api', createRateLimiter(API_RATE_LIMIT_MAX, 'Too many requests. Please wait before trying again.'));

function rejectCrossSiteRequests(req, res, next) {
    if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
        return sendError(res, new AppError('INVALID_URL', { httpStatus: 403, userMessage: 'Cross-site requests are not allowed.' }), req);
    }

    const origin = req.get('origin');
    const requestHost = req.get('host');
    if (origin && requestHost) {
        try {
            const originUrl = new URL(origin);
            const hostUrl = new URL(`http://${requestHost}`);
            if (originUrl.hostname.toLowerCase() !== hostUrl.hostname.toLowerCase()) {
                return sendError(res, new AppError('INVALID_URL', { httpStatus: 403, userMessage: 'Cross-site requests are not allowed.' }), req);
            }
        } catch (e) {
            // Ignore malformed origin or host headers and preserve non-browser client compatibility.
        }
    }
    next();
}

// serve static files only after every API path has passed common protections
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const SPOTIFY_HOSTS = new Set(['open.spotify.com']);

// Only accept canonical provider links, never arbitrary hosts that merely contain a provider name.
function isSafeUrl(urlString) {
    if (typeof urlString !== 'string' || urlString.length === 0 || urlString.length > 2048) return false;

    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;

        const host = parsed.hostname.toLowerCase();
        if (YOUTUBE_HOSTS.has(host)) {
            if (host === 'youtu.be') return /^\/[A-Za-z0-9_-]{11}\/?$/.test(parsed.pathname);
            return /^\/(?:watch|playlist|shorts\/[A-Za-z0-9_-]{11}|embed\/[A-Za-z0-9_-]{11}|live\/[A-Za-z0-9_-]{11})\/?$/.test(parsed.pathname);
        }

        return SPOTIFY_HOSTS.has(host) && /^\/(?:track|album|playlist)\/[A-Za-z0-9]+\/?$/.test(parsed.pathname);
    } catch (e) {
        return false;
    }
}

function parseCoverUrl(urlString) {
    if (typeof urlString !== 'string' || urlString.length === 0 || urlString.length > 2048) return null;
    try {
        const parsed = new URL(urlString);
        const host = parsed.hostname.toLowerCase();
        const allowed = ['ytimg.com', 'spotifycdn.com', 'scdn.co', 'googleusercontent.com']
            .some(domain => host === domain || host.endsWith(`.${domain}`));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed) return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

class SpotifyCoverCache {
    constructor(maxSize = 500, ttlMs = 24 * 60 * 60 * 1000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.cache = new Map();
    }

    get(key) {
        if (!key) return null;
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.url;
    }

    set(key, url) {
        if (!key || !url) return;
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, { url, expiresAt: Date.now() + this.ttlMs });
    }
}
const spotifyCoverCache = new SpotifyCoverCache(500, 24 * 60 * 60 * 1000);
const spotifyOembedSemaphore = new Semaphore(4);

async function fetchSpotifyTrackCoverUrl(trackUriOrId, signal = null, logger = Logger) {
    if (!trackUriOrId) return null;
    let trackId = '';
    if (trackUriOrId.includes(':')) {
        const parts = trackUriOrId.split(':');
        trackId = parts[parts.length - 1];
    } else {
        trackId = trackUriOrId;
    }
    if (!/^[A-Za-z0-9]{15,30}$/.test(trackId)) return null;

    const cached = spotifyCoverCache.get(trackId);
    if (cached) return cached;

    await spotifyOembedSemaphore.acquire(signal);
    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}&format=json`;
        const res = await axios.get(oembedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 3000,
            maxRedirects: 0,
            maxContentLength: 512 * 1024,
            signal
        });
        if (res.status === 200 && res.data?.thumbnail_url) {
            const parsed = parseCoverUrl(res.data.thumbnail_url);
            if (parsed) {
                const coverUrl = parsed.href;
                spotifyCoverCache.set(trackId, coverUrl);
                return coverUrl;
            }
        }
    } catch (e) {
        logger.debug(`Spotify oEmbed track art lookup failed for ${trackId}: ${e.message}`);
    } finally {
        spotifyOembedSemaphore.release();
    }
    return null;
}

async function fetchYouTubeThumbnailBuffer(videoId, signal = null) {
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const candidates = [
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
    ];
    for (const url of candidates) {
        if (signal?.aborted) return null;
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 5000,
                maxRedirects: 0,
                maxContentLength: MAX_COVER_BYTES,
                signal
            });
            if (res.status === 200 && res.data && res.data.length > 1000) {
                return { buffer: Buffer.from(res.data), url };
            }
        } catch {
            // try next candidate
        }
    }
    return null;
}

async function fetchCoverBuffer(urlString, signal = null) {
    const safeUrl = parseCoverUrl(urlString);
    if (!safeUrl) return null;
    try {
        const res = await axios.get(safeUrl.href, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 6000,
            maxRedirects: 0,
            maxContentLength: MAX_COVER_BYTES,
            signal
        });
        if (res.status === 200 && res.data && res.data.length > 500) {
            return Buffer.from(res.data);
        }
    } catch {
        return null;
    }
    return null;
}

async function cropToSquareJpeg(inputPath, outputPath, logger = Logger) {
    return new Promise(resolve => {
        const proc = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
            '-i', inputPath,
            '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=600:600:flags=lanczos',
            '-q:v', '2',
            outputPath
        ], { windowsHide: true });
        const timer = setTimeout(() => proc.kill('SIGKILL'), 10000);
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

function spotifyLinkDetails(urlString) {
    if (!isSafeUrl(urlString)) return null;
    const parsed = new URL(urlString);
    const match = parsed.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)\/?$/);
    return match ? { type: match[1], id: match[2] } : null;
}

function safeMetadataText(value, fallback = '') {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return text.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || fallback;
}

function getSpotifyDurationMs(track) {
    const raw = track?.duration_ms ?? track?.durationMs ?? track?.duration?.totalMilliseconds ?? track?.duration?.milliseconds ?? track?.duration;
    const duration = Number(raw);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    // Spotify embed payloads usually use milliseconds; tolerate second-based variants.
    return duration < 1000 ? Math.round(duration * 1000) : Math.round(duration);
}

// ==================== Spotify -> YouTube Matching Engine ====================

const ARTIST_SPLIT_REGEX = /\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|×|\/|;)\s*/i;
const TITLE_FEAT_REGEX = /(?:[\(\[]|\s*-\s*|\s)(?:feat\.?|ft\.?|featuring|with)\s+([^()\[\]\-]+)(?:[\)\]])?/gi;

function normalizeText(text) {
    if (typeof text !== 'string' && typeof text !== 'number') return '';
    return String(text)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[øØ]/g, 'o')
        .replace(/[æÆ]/g, 'ae')
        .replace(/[œŒ]/g, 'oe')
        .replace(/[ß]/g, 'ss')
        .replace(/[łŁ]/g, 'l')
        .replace(/[đĐ]/g, 'd')
        .replace(/(?:\p{L}\.){2,}\p{L}?/gu, m => m.replace(/\./g, ''))
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/[\u2018\u2019\u00B4`]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/&/g, ' and ')
        .replace(/\s*\+\s*/g, ' and ')
        .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeToAlphaNumeric(text) {
    return normalizeText(text).replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeArtistName(name) {
    let normalized = normalizeText(name);
    if (normalized.startsWith('the ')) normalized = normalized.slice(4).trim();
    return normalized;
}

function extractVersionInfo(title) {
    const raw = typeof title === 'string' ? title : String(title || '');
    const normalizedRaw = normalizeText(raw);

    const version = {
        isRemix: false,
        remixDetails: null,
        isLive: false,
        liveDetails: null,
        isAcoustic: false,
        isInstrumental: false,
        isKaraoke: false,
        isRadioEdit: false,
        isExtended: false,
        isRemastered: false,
        remasterYear: null,
        isClean: false,
        isExplicit: false,
        isCover: false,
        isReaction: false,
        isTutorial: false,
        isSlowedOrSpedUp: false,
        isNightcore: false,
        isBassBoosted: false,
        is8D: false,
        isAiCover: false,
        isLyricVideo: false,
        isOfficialAudio: false,
        isOfficialVideo: false,
        isTopic: false
    };

    if (/\bremix(?:ed)?\b|\bvip mix\b|\bdub mix\b|\bbootleg\b|\bflip\b/i.test(normalizedRaw)) {
        version.isRemix = true;
        const match = normalizedRaw.match(/([a-z0-9 ]+?\s+(?:remix|vip mix|dub mix|bootleg))/i);
        if (match) version.remixDetails = match[1].trim();
    }
    if (/\b(?:live|in concert|tour|unplugged)\b/i.test(normalizedRaw)) {
        version.isLive = true;
        const match = normalizedRaw.match(/\b(live(?:\s+(?:at|from|in)\s+[a-z0-9 ]+)?)\b/i);
        if (match) version.liveDetails = match[1].trim();
    }
    if (/\bacoustic\b|\bacoustic version\b|\bacoustic mix\b|\bpiano version\b/i.test(normalizedRaw)) {
        version.isAcoustic = true;
    }
    if (/\binstrumental\b|\boff vocal\b|\bbacking track\b|\bno vocal\b/i.test(normalizedRaw)) {
        version.isInstrumental = true;
    }
    if (/\bkaraoke\b/i.test(normalizedRaw)) version.isKaraoke = true;
    if (/\bradio edit\b|\bradio mix\b|\bradio version\b|\bsingle version\b/i.test(normalizedRaw)) version.isRadioEdit = true;
    if (/\bextended mix\b|\bextended version\b|\bextended\b|\bclub mix\b/i.test(normalizedRaw)) version.isExtended = true;
    if (/\bremaster(?:ed)?\b|\bdigital remaster\b|\bdeluxe edition\b|\banniversary edition\b/i.test(normalizedRaw)) {
        version.isRemastered = true;
        const yearMatch = normalizedRaw.match(/\b(19\d{2}|20\d{2})\s+remaster\b|\bremaster(?:ed)?\s+(19\d{2}|20\d{2})\b/i);
        if (yearMatch) version.remasterYear = Number(yearMatch[1] || yearMatch[2]);
    }
    if (/\bclean version\b|\bclean edit\b|\bclean\b/i.test(normalizedRaw)) version.isClean = true;
    if (/\bexplicit\b|\bexplicit version\b/i.test(normalizedRaw)) version.isExplicit = true;

    if (/\bcover\b|\bcover version\b|\btribute\b/i.test(normalizedRaw)) version.isCover = true;
    if (/\breaction\b|\breacts\b/i.test(normalizedRaw)) version.isReaction = true;
    if (/\btutorial\b|\bhow to play\b|\bguitar lesson\b|\bpiano tutorial\b/i.test(normalizedRaw)) version.isTutorial = true;
    if (/\bsped up\b|\bspeed up\b|\bslowed\b|\bslowed \+ reverb\b|\bslowed and reverb\b/i.test(normalizedRaw)) version.isSlowedOrSpedUp = true;
    if (/\bnightcore\b/i.test(normalizedRaw)) version.isNightcore = true;
    if (/\bbass boosted\b|\bbassboosted\b/i.test(normalizedRaw)) version.isBassBoosted = true;
    if (/\b8d\b|\b8d audio\b/i.test(normalizedRaw)) version.is8D = true;
    if (/\bai cover\b|\bai voice\b|\bai version\b/i.test(normalizedRaw)) version.isAiCover = true;
    if (/\blyrics?\b|\blyric video\b/i.test(normalizedRaw)) version.isLyricVideo = true;

    if (/\bofficial audio\b|\baudio\b/i.test(normalizedRaw)) version.isOfficialAudio = true;
    if (/\bofficial (?:music )?video\b|\bmusic video\b/i.test(normalizedRaw)) version.isOfficialVideo = true;
    if (/\btopic\b/i.test(normalizedRaw)) version.isTopic = true;

    const videoFluffRegex = /\s*[\(\[](?:official\s+(?:music\s+)?video|official\s+audio|official\s+visualizer|audio|video|visualizer|hd|4k|hq|lyrics?|lyric\s+video|color\s+coded|stream|music\s+video|official)[\)\]]\s*/gi;
    let clean = raw.replace(videoFluffRegex, ' ').trim();

    const versionNoiseRegex = /\s*[\(\[](?:remaster(?:ed)?.*?|\d{4}\s+remaster.*?|live.*?|acoustic.*?|radio\s+(?:edit|mix|version)|extended.*?|club\s+mix.*?|remix.*?|.*?remix|instrumental.*?|karaoke.*?|deluxe.*?|clean.*?|explicit.*?|single\s+version|album\s+version|original\s+mix)[\)\]]\s*/gi;
    let base = clean.replace(versionNoiseRegex, ' ').trim();
    base = base.replace(/\s*-\s*(?:live|remaster(?:ed)?(?:\s+\d{4})?|acoustic|instrumental|radio\s+edit|extended\s+mix|deluxe\s+edition)\b.*$/i, '').trim();

    base = base.replace(TITLE_FEAT_REGEX, '').trim();
    clean = clean.replace(TITLE_FEAT_REGEX, '').trim();

    base = base.replace(/\s+/g, ' ').replace(/\s+-\s*$/, '').trim();
    clean = clean.replace(/\s+/g, ' ').replace(/\s+-\s*$/, '').trim();

    return {
        rawTitle: raw,
        baseTitle: base || raw,
        cleanTitle: clean || raw,
        normalizedBase: normalizeText(base || raw),
        version
    };
}

function parseArtists(artistString, titleString = '') {
    const rawArtists = typeof artistString === 'string' ? artistString : String(artistString || '');
    const tokens = new Set();
    const list = [];

    function addArtist(name) {
        if (!name) return;
        const cleaned = name.replace(/^[\s,;&\-]+|[\s,;&\-]+$/g, '').trim();
        if (!cleaned || cleaned.toLowerCase() === 'unknown artist') return;
        const norm = normalizeArtistName(cleaned);
        if (norm && !tokens.has(norm)) {
            tokens.add(norm);
            list.push(cleaned);
        }
    }

    if (rawArtists) {
        for (const part of rawArtists.split(ARTIST_SPLIT_REGEX)) addArtist(part);
    }

    if (titleString) {
        let match;
        const regex = new RegExp(TITLE_FEAT_REGEX.source, 'gi');
        while ((match = regex.exec(titleString)) !== null) {
            if (match[1]) {
                for (const fp of match[1].split(ARTIST_SPLIT_REGEX)) addArtist(fp);
            }
        }
    }

    const primary = list[0] || 'Unknown Artist';
    const featured = list.slice(1);

    return {
        raw: rawArtists,
        primary,
        featured,
        all: list,
        normalizedPrimary: normalizeArtistName(primary),
        normalizedFeatured: featured.map(normalizeArtistName),
        normalizedAll: list.map(normalizeArtistName)
    };
}

function parseYouTubeCandidate(candidate) {
    const rawTitle = String(candidate?.title || '');
    const uploader = String(candidate?.uploader || candidate?.channel || '');
    const channelId = String(candidate?.channel_id || candidate?.uploader_id || '');
    const duration = Number(candidate?.duration) > 0 ? Number(candidate?.duration) : null;
    const durationMs = duration ? Math.round(duration * 1000) : null;
    const album = String(candidate?.album || '').trim();

    const titleInfo = extractVersionInfo(rawTitle);
    const normUploader = normalizeText(uploader);
    const isTopicChannel = normUploader.endsWith('topic') || normUploader.endsWith('- topic') || /release - topic/i.test(uploader);
    const isVevoChannel = /vevo\b/i.test(uploader);

    if (isTopicChannel) titleInfo.version.isTopic = true;

    let parsedArtist = null;
    let parsedSongTitle = null;
    const dashIndex = rawTitle.search(/\s+[-–—]\s+/);
    if (dashIndex > 0) {
        parsedArtist = rawTitle.slice(0, dashIndex).trim();
        parsedSongTitle = rawTitle.slice(dashIndex).replace(/^\s*[-–—]\s*/, '').trim();
    }
    const parsedTitleInfo = parsedSongTitle ? extractVersionInfo(parsedSongTitle) : null;

    return {
        id: String(candidate?.id || candidate?.url || ''),
        rawTitle,
        uploader,
        channelId,
        duration,
        durationMs,
        album,
        isTopicChannel,
        isVevoChannel,
        titleInfo,
        parsedArtist,
        parsedSongTitle,
        parsedTitleInfo,
        rawCandidate: candidate
    };
}

function matchTokens(value) {
    return new Set(String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[øØ]/g, 'o')
        .replace(/[æÆ]/g, 'ae')
        .replace(/[œŒ]/g, 'oe')
        .replace(/[ß]/g, 'ss')
        .replace(/[łŁ]/g, 'l')
        .replace(/[đĐ]/g, 'd')
        .replace(/(?:\p{L}\.){2,}\p{L}?/gu, m => m.replace(/\./g, ''))
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/vevo\b/g, ' ')
        .replace(/&/g, ' and ')
        .replace(/\b(?:official|audio|video|lyrics?|visualizer|hd|4k|topic)\b/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(token => token.length > 1));
}

function tokenSimilarity(left, right) {
    const a = matchTokens(left);
    const b = matchTokens(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap++;
    return (2 * overlap) / (a.size + b.size);
}

function calculateDurationScore(expectedMs, candidateDurationSec) {
    if (!expectedMs || !candidateDurationSec) return null;
    const expectedSec = expectedMs / 1000;
    const diffSec = Math.abs(expectedSec - candidateDurationSec);
    const allowedCeiling = Math.max(40, expectedSec * 0.25);
    if (diffSec > allowedCeiling) return { score: 0, diffSec, disqualified: true };

    let score;
    if (diffSec <= 2) score = 1.0;
    else if (diffSec <= 5) score = 0.95;
    else if (diffSec <= 10) score = 0.85;
    else if (diffSec <= 20) score = 0.65;
    else if (diffSec <= 35) score = 0.40;
    else score = Math.max(0.05, 1 - (diffSec / allowedCeiling));

    return { score, diffSec, disqualified: false };
}

function containsPhrase(source, target) {
    if (!source || !target) return false;
    return ` ${normalizeToAlphaNumeric(source)} `.includes(` ${normalizeToAlphaNumeric(target)} `);
}

function scoreTitle(spotifyTitleInfo, parsedCandidate, reasons) {
    const spotNormBase = spotifyTitleInfo.normalizedBase;
    const candNormBase = parsedCandidate.titleInfo.normalizedBase;
    const candParsedNormBase = parsedCandidate.parsedTitleInfo?.normalizedBase || '';

    if (spotNormBase === candNormBase || (candParsedNormBase && spotNormBase === candParsedNormBase)) {
        reasons.push('exact_title_match');
        return 1.0;
    }

    if (containsPhrase(parsedCandidate.rawTitle, spotifyTitleInfo.baseTitle) ||
        (parsedCandidate.parsedSongTitle && containsPhrase(parsedCandidate.parsedSongTitle, spotifyTitleInfo.baseTitle))) {
        reasons.push('phrase_title_match');
        const tokenSim = Math.max(
            tokenSimilarity(spotifyTitleInfo.baseTitle, parsedCandidate.parsedSongTitle || ''),
            tokenSimilarity(spotifyTitleInfo.baseTitle, parsedCandidate.rawTitle)
        );
        return Math.max(0.88, tokenSim);
    }

    const simWithParsed = candParsedNormBase ? tokenSimilarity(spotNormBase, candParsedNormBase) : 0;
    const simWithRaw = tokenSimilarity(spotNormBase, candNormBase);
    const bestTokenSim = Math.max(simWithParsed, simWithRaw);

    if (bestTokenSim >= 0.75) reasons.push('strong_title_token_match');
    else if (bestTokenSim >= 0.50) reasons.push('moderate_title_token_match');

    return bestTokenSim;
}

function scoreArtist(spotifyArtists, parsedCandidate, reasons) {
    const primaryNorm = spotifyArtists.normalizedPrimary;
    const candUploader = normalizeArtistName(parsedCandidate.uploader);
    const candParsedArtist = parsedCandidate.parsedArtist ? normalizeArtistName(parsedCandidate.parsedArtist) : '';
    const candRawTitle = normalizeText(parsedCandidate.rawTitle);

    let primaryMatch = false;
    let featuredMatches = 0;

    if (candUploader === primaryNorm ||
        candParsedArtist === primaryNorm ||
        containsPhrase(parsedCandidate.uploader, spotifyArtists.primary) ||
        containsPhrase(parsedCandidate.parsedArtist || '', spotifyArtists.primary) ||
        containsPhrase(candRawTitle, spotifyArtists.primary)) {
        primaryMatch = true;
        reasons.push('primary_artist_match');
    }

    for (const feat of spotifyArtists.featured) {
        const featNorm = normalizeArtistName(feat);
        if (candRawTitle.includes(featNorm) || candParsedArtist.includes(featNorm) || candUploader.includes(featNorm)) {
            featuredMatches++;
        }
    }

    if (spotifyArtists.featured.length > 0 && featuredMatches === spotifyArtists.featured.length) {
        reasons.push('all_featured_artists_match');
    }

    if (primaryMatch) {
        if (spotifyArtists.featured.length === 0) return 1.0;
        return 0.85 + 0.15 * (featuredMatches / spotifyArtists.featured.length);
    }

    for (const feat of spotifyArtists.featured) {
        if (candParsedArtist === normalizeArtistName(feat) || containsPhrase(parsedCandidate.uploader, feat)) {
            if (containsPhrase(candRawTitle, spotifyArtists.primary)) {
                reasons.push('artist_order_invariance_match');
                return 0.95;
            }
        }
    }

    const candidateArtistText = [parsedCandidate.parsedArtist, parsedCandidate.uploader].filter(Boolean).join(' ');
    const maxTokenScore = Math.max(
        tokenSimilarity(spotifyArtists.raw, candidateArtistText),
        tokenSimilarity(spotifyArtists.primary, candidateArtistText),
        tokenSimilarity(spotifyArtists.primary, candRawTitle) * 0.8
    );

    if (maxTokenScore >= 0.70) reasons.push('artist_token_match');
    return maxTokenScore;
}

function evaluateVersionCompatibility(spotVersion, candVersion, reasons) {
    let bonusPenalty = 0;
    let conflict = false;

    if (!spotVersion.isRemix && candVersion.isRemix) {
        bonusPenalty -= 0.60;
        conflict = true;
        reasons.push('unwanted_remix');
    } else if (spotVersion.isRemix && !candVersion.isRemix) {
        bonusPenalty -= 0.50;
        conflict = true;
        reasons.push('missing_remix');
    } else if (spotVersion.isRemix && candVersion.isRemix) {
        if (spotVersion.remixDetails && candVersion.remixDetails) {
            const remixSim = tokenSimilarity(spotVersion.remixDetails, candVersion.remixDetails);
            if (remixSim >= 0.5) {
                bonusPenalty += 0.12;
                reasons.push('remix_details_matched');
            } else {
                bonusPenalty -= 0.40;
                conflict = true;
                reasons.push('conflicting_remix_details');
            }
        } else {
            bonusPenalty += 0.08;
            reasons.push('remix_matched');
        }
    }

    if (!spotVersion.isLive && candVersion.isLive) {
        bonusPenalty -= 0.50;
        conflict = true;
        reasons.push('unwanted_live_recording');
    } else if (spotVersion.isLive && !candVersion.isLive) {
        bonusPenalty -= 0.40;
        conflict = true;
        reasons.push('missing_live_recording');
    } else if (spotVersion.isLive && candVersion.isLive) {
        bonusPenalty += 0.12;
        reasons.push('live_recording_matched');
    }

    if (!spotVersion.isAcoustic && candVersion.isAcoustic) {
        bonusPenalty -= 0.50;
        conflict = true;
        reasons.push('unwanted_acoustic_version');
    } else if (spotVersion.isAcoustic && !candVersion.isAcoustic) {
        bonusPenalty -= 0.40;
        conflict = true;
        reasons.push('missing_acoustic_version');
    } else if (spotVersion.isAcoustic && candVersion.isAcoustic) {
        bonusPenalty += 0.12;
        reasons.push('acoustic_version_matched');
    }

    if (!spotVersion.isInstrumental && candVersion.isInstrumental) {
        bonusPenalty -= 0.55;
        conflict = true;
        reasons.push('unwanted_instrumental');
    }
    if (!spotVersion.isKaraoke && candVersion.isKaraoke) {
        bonusPenalty -= 0.55;
        conflict = true;
        reasons.push('unwanted_karaoke');
    }

    if (spotVersion.isRadioEdit && candVersion.isRadioEdit) {
        bonusPenalty += 0.08;
        reasons.push('radio_edit_matched');
    }
    if (spotVersion.isExtended && candVersion.isExtended) {
        bonusPenalty += 0.08;
        reasons.push('extended_mix_matched');
    }

    if (spotVersion.isRemastered && candVersion.isRemastered) {
        bonusPenalty += 0.06;
        reasons.push('remaster_matched');
    } else if (!spotVersion.isRemastered && candVersion.isRemastered) {
        bonusPenalty += 0.02;
        reasons.push('remaster_audio_acceptable');
    }

    if (!spotVersion.isRemix && !spotVersion.isLive && !spotVersion.isAcoustic &&
        !candVersion.isRemix && !candVersion.isLive && !candVersion.isAcoustic) {
        bonusPenalty += 0.04;
        reasons.push('studio_version_matched');
    }

    return { bonusPenalty, conflict };
}

function scoreSpotifyCandidate(track, candidate, options = {}) {
    const threshold = options.threshold ?? 0.58;
    const reasons = [];

    const spotifyTitleInfo = extractVersionInfo(track?.title || '');
    const spotifyArtists = parseArtists(track?.artist || '', track?.title || '');
    const parsedCandidate = parseYouTubeCandidate(candidate);

    const expectedDurationMs = Number(track?.durationMs) || null;
    let durationScoreObj = null;
    if (expectedDurationMs && parsedCandidate.duration) {
        durationScoreObj = calculateDurationScore(expectedDurationMs, parsedCandidate.duration);
        if (durationScoreObj.disqualified) {
            reasons.push('duration_mismatch_disqualified');
            return null;
        }
        if (durationScoreObj.diffSec <= 2) reasons.push('duration_exact');
        else if (durationScoreObj.diffSec <= 5) reasons.push('duration_very_close');
        else if (durationScoreObj.diffSec <= 10) reasons.push('duration_acceptable');
    }

    const titleScore = scoreTitle(spotifyTitleInfo, parsedCandidate, reasons);
    const artistScore = scoreArtist(spotifyArtists, parsedCandidate, reasons);

    if (titleScore < 0.38 || (artistScore < 0.15 && titleScore < 0.85)) return null;

    const candVersion = parsedCandidate.titleInfo.version;
    const { bonusPenalty: versionBonus, conflict: versionConflict } =
        evaluateVersionCompatibility(spotifyTitleInfo.version, candVersion, reasons);

    let sourceBonus = 0;
    if (parsedCandidate.isTopicChannel || candVersion.isTopic) {
        sourceBonus += 0.12;
        reasons.push('topic_channel_official');
    } else if (candVersion.isOfficialAudio) {
        sourceBonus += 0.08;
        reasons.push('official_audio_signal');
    } else if (parsedCandidate.isVevoChannel || candVersion.isOfficialVideo) {
        sourceBonus += 0.04;
        reasons.push('official_video_signal');
    }

    let albumBonus = 0;
    const expectedAlbum = String(track?.album || '').trim();
    if (expectedAlbum && expectedAlbum.toLowerCase() !== 'spotify collection') {
        const normAlbum = normalizeText(expectedAlbum);
        if (parsedCandidate.album && normalizeText(parsedCandidate.album).includes(normAlbum)) {
            albumBonus = 0.05;
            reasons.push('album_exact_match');
        } else if (containsPhrase(parsedCandidate.rawTitle, expectedAlbum)) {
            albumBonus = 0.03;
            reasons.push('album_title_match');
        }
    }

    let yearBonus = 0;
    const expectedYear = Number(track?.releaseYear);
    if (expectedYear && Number.isSafeInteger(expectedYear)) {
        if (parsedCandidate.rawTitle.includes(String(expectedYear)) ||
            (candVersion.remasterYear && candVersion.remasterYear === expectedYear)) {
            yearBonus = 0.03;
            reasons.push('release_year_match');
        }
    }

    let negativePenalties = 0;
    if (candVersion.isReaction) { negativePenalties -= 0.70; reasons.push('penalty_reaction_video'); }
    if (candVersion.isTutorial) { negativePenalties -= 0.70; reasons.push('penalty_tutorial_video'); }
    if (candVersion.isAiCover) { negativePenalties -= 0.70; reasons.push('penalty_ai_cover'); }
    if (candVersion.isCover && !spotifyTitleInfo.version.isCover) { negativePenalties -= 0.45; reasons.push('penalty_cover_song'); }
    if (candVersion.isSlowedOrSpedUp) { negativePenalties -= 0.50; reasons.push('penalty_tempo_modified'); }
    if (candVersion.isNightcore) { negativePenalties -= 0.50; reasons.push('penalty_nightcore'); }
    if (candVersion.is8D || candVersion.isBassBoosted) { negativePenalties -= 0.40; reasons.push('penalty_audio_effects'); }
    if (candVersion.isLyricVideo) { negativePenalties -= 0.05; reasons.push('lyric_video_slight_penalty'); }

    const durationScore = durationScoreObj?.score ?? null;
    const baseScore = durationScore === null
        ? titleScore * 0.60 + artistScore * 0.40
        : titleScore * 0.48 + artistScore * 0.32 + durationScore * 0.20;

    let finalScore = baseScore + versionBonus + sourceBonus + albumBonus + yearBonus + negativePenalties;
    finalScore = Math.max(0, Math.min(1, Math.round(finalScore * 1000) / 1000));

    if (finalScore < threshold || (versionConflict && finalScore < 0.75)) return null;

    let confidence = 'low';
    const hasNegativeSignals = negativePenalties < -0.10;
    if (finalScore >= 0.78 && titleScore >= 0.65 && artistScore >= 0.60 && !hasNegativeSignals &&
        (durationScore === null || durationScore >= 0.70)) {
        confidence = 'high';
    } else if (finalScore >= threshold && titleScore >= 0.42 && artistScore >= 0.20) {
        confidence = 'medium';
    }

    return {
        confidence,
        score: finalScore,
        titleScore: Math.round(titleScore * 1000) / 1000,
        artistScore: Math.round(artistScore * 1000) / 1000,
        durationScore: durationScore !== null ? Math.round(durationScore * 1000) / 1000 : null,
        durationDifference: durationScoreObj?.diffSec ?? null,
        reasons,
        matchedTitle: parsedCandidate.rawTitle,
        matchedArtist: parsedCandidate.parsedArtist || parsedCandidate.uploader,
        videoId: parsedCandidate.id
    };
}

function generateSearchQueries(track, maxSearches = 2) {
    const titleInfo = extractVersionInfo(track?.title || '');
    const artists = parseArtists(track?.artist || '', track?.title || '');
    const primary = artists.primary === 'Unknown Artist' ? '' : artists.primary;
    const cleanTitle = titleInfo.cleanTitle;

    const queries = [];
    const seen = new Set();
    function addQuery(str) {
        if (!str) return;
        const cleaned = str.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        const lower = cleaned.toLowerCase();
        if (cleaned && !seen.has(lower)) {
            seen.add(lower);
            queries.push(cleaned);
        }
    }

    addQuery([primary, cleanTitle].filter(Boolean).join(' '));

    if (titleInfo.version.isLive) {
        addQuery([primary, titleInfo.baseTitle, 'live'].filter(Boolean).join(' '));
    } else if (titleInfo.version.isAcoustic) {
        addQuery([primary, titleInfo.baseTitle, 'acoustic'].filter(Boolean).join(' '));
    } else if (titleInfo.version.isRemix) {
        addQuery([primary, titleInfo.baseTitle, 'remix'].filter(Boolean).join(' '));
    } else {
        addQuery([primary, titleInfo.baseTitle, 'official audio'].filter(Boolean).join(' '));
    }

    addQuery([primary, cleanTitle, 'topic'].filter(Boolean).join(' '));

    if (artists.featured.length > 0) {
        addQuery([artists.all.join(' '), cleanTitle].filter(Boolean).join(' '));
    }

    return queries.slice(0, maxSearches);
}

function rankCandidates(track, candidates, options = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    const evaluated = [];
    const seenIds = new Set();

    for (const candidate of candidates) {
        const videoId = String(candidate?.id || candidate?.url || '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
        if (seenIds.has(videoId)) continue;
        seenIds.add(videoId);

        const evaluation = scoreSpotifyCandidate(track, candidate, options);
        if (evaluation) {
            evaluated.push({
                candidate,
                videoId,
                score: evaluation.score,
                confidence: evaluation.confidence,
                titleScore: evaluation.titleScore,
                artistScore: evaluation.artistScore,
                durationScore: evaluation.durationScore,
                durationDifference: evaluation.durationDifference,
                reasons: evaluation.reasons,
                matchedTitle: evaluation.matchedTitle,
                matchedArtist: evaluation.matchedArtist
            });
        }
    }

    evaluated.sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (Math.abs(scoreDiff) > 0.02) return scoreDiff;
        const aHasTopic = a.reasons.includes('topic_channel_official');
        const bHasTopic = b.reasons.includes('topic_channel_official');
        if (aHasTopic !== bHasTopic) return aHasTopic ? -1 : 1;
        const aHasAudio = a.reasons.includes('official_audio_signal');
        const bHasAudio = b.reasons.includes('official_audio_signal');
        if (aHasAudio !== bHasAudio) return aHasAudio ? -1 : 1;
        return scoreDiff;
    });

    return evaluated;
}

async function searchYouTubeCandidates(query, maxCandidates, signal, logger = Logger) {
    const stageTimer = startStage(logger, 'search');
    const searchTarget = `ytsearch${maxCandidates}:${query}`;
    const args = [
        '--ignore-config',
        '--js-runtimes', 'node',
        '--dump-single-json', '--flat-playlist', '--skip-download', '--no-warnings'
    ];
    if (COOKIES_PATH) {
        args.push('--cookies', COOKIES_PATH);
    } else {
        args.push('--extractor-args', 'youtube:player_client=android,web');
    }
    args.push('--', searchTarget);

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            stageTimer.end('failed', { code: 'CANCELLED' });
            return reject(new AppError('CANCELLED'));
        }
        const ytdlp = spawn('yt-dlp', args);
        let output = '';
        let outputBytes = 0;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            ytdlp.kill('SIGKILL');
        }, 30000);
        const onAbort = () => ytdlp.kill('SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });
        ytdlp.stdout.on('data', chunk => {
            outputBytes += chunk.length;
            if (outputBytes > 2 * 1024 * 1024) ytdlp.kill('SIGKILL');
            else output += chunk.toString();
        });
        let stderr = '';
        ytdlp.stderr.on('data', data => {
            const text = data.toString();
            stderr = (stderr + text).slice(-8000);
            logger.warn(`Spotify match search: ${text.trim()}`);
        });
        ytdlp.on('error', error => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            stageTimer.end('failed', { code: 'INTERNAL' });
            reject(error);
        });
        ytdlp.on('close', code => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                stageTimer.end('failed', { code: 'CANCELLED' });
                return reject(new AppError('CANCELLED'));
            }
            if (timedOut) {
                stageTimer.end('failed', { code: 'TIMEOUT' });
                return reject(new AppError('TIMEOUT', { userMessage: 'Spotify match search timed out.' }));
            }
            if (outputBytes > 2 * 1024 * 1024) {
                stageTimer.end('failed', { code: 'TOO_LARGE' });
                return reject(new AppError('TOO_LARGE', { userMessage: 'Spotify match search returned too much data.' }));
            }
            if (code !== 0 || !output.trim()) {
                stageTimer.end('failed', { code: 'NO_MATCH' });
                return resolve([]);
            }
            try {
                const data = JSON.parse(output);
                stageTimer.end('ok');
                resolve(Array.isArray(data.entries) ? data.entries : [data]);
            } catch {
                stageTimer.end('failed', { code: 'INTERNAL' });
                resolve([]);
            }
        });
    });
}

// In-memory 24h LRU cache of age-restricted video IDs across jobs
class AgeGateLruCache {
    constructor(maxSize = 1000, ttlMs = 24 * 60 * 60 * 1000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.cache = new Map(); // videoId -> timestamp
    }

    has(videoId) {
        if (!videoId || !this.cache.has(videoId)) return false;
        const entryTime = this.cache.get(videoId);
        if (Date.now() - entryTime > this.ttlMs) {
            this.cache.delete(videoId);
            return false;
        }
        // Refresh position in Map for LRU order
        this.cache.delete(videoId);
        this.cache.set(videoId, entryTime);
        return true;
    }

    add(videoId) {
        if (!videoId) return;
        if (this.cache.has(videoId)) {
            this.cache.delete(videoId);
        } else if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) this.cache.delete(oldestKey);
        }
        this.cache.set(videoId, Date.now());
    }

    clear() {
        this.cache.clear();
    }
}

const ageRestrictedCache = new AgeGateLruCache(1000, 24 * 60 * 60 * 1000);

async function findSpotifyCandidates(track, signal, logger = Logger, excludedVideoIds = new Set()) {
    const MATCH_THRESHOLD = 0.58;       // Minimum confidence score required
    const MAX_SEARCH_QUERIES = 2;       // Maximum search query variations attempted per track
    const MAX_CANDIDATES_PER_QUERY = 5; // Maximum YouTube candidates fetched per search query

    const queries = generateSearchQueries(track, MAX_SEARCH_QUERIES);
    const collectedCandidates = [];
    const seenIds = new Set();

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const entries = await searchYouTubeCandidates(query, MAX_CANDIDATES_PER_QUERY, signal, logger);
        for (const entry of entries) {
            const id = entry?.id || entry?.url;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                collectedCandidates.push(entry);
            }
        }
    }

    const ranked = rankCandidates(track, collectedCandidates, { threshold: MATCH_THRESHOLD });

    // Filter out candidates that are known to be age-restricted or failed in this job
    const filtered = ranked.filter(c => {
        if (!c.videoId) return false;
        if (excludedVideoIds && excludedVideoIds.has(c.videoId)) return false;
        if (ageRestrictedCache.has(c.videoId)) return false;
        return true;
    });

    // Prefer auto-generated "Topic" audio uploads, then other candidates above threshold
    filtered.sort((a, b) => {
        const aIsTopic = a.reasons.includes('topic_channel_official') || String(a.candidate?.uploader || '').endsWith(' - Topic');
        const bIsTopic = b.reasons.includes('topic_channel_official') || String(b.candidate?.uploader || '').endsWith(' - Topic');
        if (aIsTopic !== bIsTopic) return aIsTopic ? -1 : 1;
        return b.score - a.score;
    });

    return filtered;
}

async function findSpotifyMatch(track, signal, logger = Logger, excludedVideoIds = new Set()) {
    const candidates = await findSpotifyCandidates(track, signal, logger, excludedVideoIds);
    if (!candidates || candidates.length === 0) {
        throw new AppError('NO_MATCH', { userMessage: 'No search result matched the Spotify title, artist, and duration closely enough.' });
    }
    const bestCandidate = candidates[0];
    logger.info(`[Spotify match] ${sanitizeAsciiHeader(track.title)} - ${sanitizeAsciiHeader(track.artist)} -> ${sanitizeAsciiHeader(bestCandidate.matchedTitle || '')} (confidence ${(bestCandidate.score * 100).toFixed(0)}%)`);
    return `https://www.youtube.com/watch?v=${bestCandidate.videoId}`;
}

async function downloadSpotifyAudioWithFallback({
    track,
    audioFormat,
    signal,
    onProgress,
    logger = Logger,
    jobExcludedVideoIds = new Set(),
    onNote = null
}) {
    const candidates = await findSpotifyCandidates(track, signal, logger, jobExcludedVideoIds);
    if (!candidates || candidates.length === 0) {
        throw new AppError('NO_MATCH', { userMessage: 'No search result matched the Spotify title, artist, and duration closely enough.' });
    }

    const maxAttempts = Math.min(3, candidates.length);
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) throw new AppError('CANCELLED');
        const candidate = candidates[attempt];
        const candidateUrl = `https://www.youtube.com/watch?v=${candidate.videoId}`;
        const isAlternate = attempt > 0;

        if (isAlternate) {
            logger.info(`Spotify age-gate fallback: attempting candidate ${attempt + 1}/${maxAttempts} [${candidate.videoId}] "${sanitizeAsciiHeader(candidate.matchedTitle || '')}"`);
        } else {
            logger.info(`[Spotify match] ${sanitizeAsciiHeader(track.title)} - ${sanitizeAsciiHeader(track.artist)} -> ${sanitizeAsciiHeader(candidate.matchedTitle || '')} (confidence ${(candidate.score * 100).toFixed(0)}%)`);
        }

        try {
            const tempAudioPath = await downloadToTemp(
                candidateUrl,
                audioFormat === 'm4a' ? 'm4a' : 'webm',
                signal,
                audioFormat,
                onProgress,
                logger
            );

            if (isAlternate) {
                logger.info(`Spotify age-gate fallback: alternate candidate ${candidate.videoId} succeeded ("alternate version used")`);
                onNote?.('alternate version used');
            }

            return { tempAudioPath, candidate, alternateUsed: isAlternate };
        } catch (err) {
            lastError = err;
            if (err?.code === 'AGE_RESTRICTED') {
                logger.warn(`Spotify age-gate fallback: candidate ${candidate.videoId} failed with AGE_RESTRICTED. Adding to 24h cache and job excluded set.`);
                ageRestrictedCache.add(candidate.videoId);
                jobExcludedVideoIds?.add(candidate.videoId);
                if (attempt + 1 < maxAttempts) {
                    continue; // try next candidate
                }
            }
            throw err;
        }
    }

    if (ageGateCookiePool.isEnabled() && lastError?.code === 'AGE_RESTRICTED') {
        const topCandidate = candidates[0];
        logger.info(`Spotify age-gate fallback: all non-cookie attempts failed; retrying top candidate [${topCandidate.videoId}] with age-gate cookie account`);
        const lease = await ageGateCookiePool.acquire();
        if (lease) {
            try {
                const candidateUrl = `https://www.youtube.com/watch?v=${topCandidate.videoId}`;
                const tempAudioPath = await downloadToTemp(
                    candidateUrl,
                    audioFormat === 'm4a' ? 'm4a' : 'webm',
                    signal,
                    audioFormat,
                    onProgress,
                    logger,
                    lease.cookiePath
                );
                lease.release(true);
                return { tempAudioPath, candidate: topCandidate, alternateUsed: false };
            } catch (cookieErr) {
                lease.release(false, cookieErr);
                throw cookieErr;
            }
        }
    }

    throw lastError || new AppError('AGE_RESTRICTED');
}



// clean up filenames so they do not break the filesystem
function sanitizeFilename(name) {
    if (typeof name !== 'string' || !name) return 'audio_track';
    return name.slice(0, 240).replace(/<[^>]*>|&nbsp;|&[a-z]+;|[\$`'";|&]|\.\.[/\\]|[\x00-\x1F\x7F]/g, '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/^\.+/, '')
        .replace(/\s+/g, ' ')
        .trim().slice(0, 120) || 'audio_track';
}

function sanitizeAsciiHeader(name) {
    const ascii = String(name || '').replace(/[^\x20-\x7E]/g, '').replace(/["\\;]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return ascii || 'download';
}

function buildContentDisposition(baseName, extension) {
    const ext = extension ? (extension.startsWith('.') ? extension.slice(1) : extension).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    let name = String(baseName || '').trim();
    if (ext && name.toLowerCase().endsWith(`.${ext}`)) {
        name = name.slice(0, -(ext.length + 1)).trim();
    }
    const cleanExt = ext ? `.${ext}` : '';
    const safeUtf8 = sanitizeFilename(name);
    const finalUtf8 = safeUtf8 && safeUtf8 !== 'audio_track'
        ? `${safeUtf8}${cleanExt}`
        : (ext === 'zip' ? 'ripcord-playlist.zip' : `ripcord${cleanExt}`);

    const encodedUtf8 = encodeURIComponent(finalUtf8)
        .replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/\*/g, '%2A');

    let ascii = sanitizeFilename(name)
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/["\\;]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!ascii || ascii === 'audio_track') {
        ascii = ext === 'zip' ? 'ripcord-playlist' : 'ripcord';
    }
    const asciiFilename = `${ascii.slice(0, 100)}${cleanExt}`;

    return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedUtf8}`;
}

// helper to delete temp files when we are done with them
function cleanupFiles(files) {
    if (!Array.isArray(files)) return;
    files.forEach(file => {
        try {
            if (file && fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch (e) {
            // ignore errors if the file is already gone
        }
    });
}

function extractSingleVideoId(parsed) {
    const host = parsed.hostname.toLowerCase();
    let id = null;
    if (host === 'youtu.be') id = parsed.pathname.slice(1);
    else if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
    else id = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

// grab the 11 character id from a youtube link
function getYouTubeVideoId(url) {
    try {
        let value = typeof url === 'string' ? url.trim() : '';
        if (!value) return null;
        const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        const singleId = extractSingleVideoId(parsed);
        if (singleId) return singleId;
        if (parsed.pathname === '/playlist') {
            const list = parsed.searchParams.get('list');
            const match = list?.match(/^RD(?:AMVM|MM)?([A-Za-z0-9_-]{11})$/i);
            if (match) return match[1];
        }
        return null;
    } catch (e) {
        return null;
    }
}

function isYouTubeUrl(url) {
    try {
        let value = typeof url === 'string' ? url.trim() : '';
        if (!value) return false;
        const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
    } catch (e) {
        return false;
    }
}

function normalizeYouTubeUrl(url) {
    try {
        let value = typeof url === 'string' ? url.trim() : '';
        if (!value) return url;
        const hasProtocol = /^https?:\/\//i.test(value);
        const parsed = new URL(hasProtocol ? value : `https://${value}`);
        const host = parsed.hostname.toLowerCase();
        if (!YOUTUBE_HOSTS.has(host)) return url;

        const list = parsed.searchParams.get('list');
        if (parsed.pathname === '/playlist' && list) {
            const match = list.match(/^RD(?:AMVM|MM)?([A-Za-z0-9_-]{11})$/i);
            if (match) {
                parsed.pathname = '/watch';
                parsed.searchParams.set('v', match[1]);
            }
        }

        if (extractSingleVideoId(parsed)) {
            parsed.searchParams.delete('list');
            parsed.searchParams.delete('index');
            parsed.searchParams.delete('start_radio');
            parsed.searchParams.delete('pp');
        }

        return parsed.href;
    } catch {
        return url;
    }
}

function isYouTubePlaylist(url) {
    try {
        let value = typeof url === 'string' ? url.trim() : '';
        if (!value) return false;
        const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        const host = parsed.hostname.toLowerCase();
        if (!YOUTUBE_HOSTS.has(host)) return false;

        if (extractSingleVideoId(parsed)) {
            return false;
        }

        const list = parsed.searchParams.get('list');
        if (list && (list.toUpperCase().startsWith('RD') || list.toUpperCase().startsWith('UL') || parsed.searchParams.get('start_radio') === '1')) {
            return false;
        }

        return (parsed.pathname === '/playlist' || Boolean(list)) && Boolean(list);
    } catch (e) {
        return false;
    }
}

// fetch youtube video info using oembed first
async function getYoutubeInfo(url, signal) {
    const videoId = getYouTubeVideoId(url);
    const thumbnail = videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '';
    let title = 'Unknown Title';
    let author = 'Unknown Channel';

    if (videoId) {
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const response = await axios.get(oembedUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 5000,
                maxRedirects: 0,
                maxContentLength: 1024 * 1024,
                signal
            });
            if (response.status === 200 && response.data) {
                title = safeMetadataText(response.data.title, title);
                author = safeMetadataText(response.data.author_name, author);
            }
        } catch (error) {
            Logger.warn(`YouTube oEmbed warning for ${videoId}: ${error.message}`);
        }
    }
    return { title, author, thumbnail };
}

// list all songs in a youtube playlist without downloading them yet
async function getYoutubePlaylistData(url, signal, cookiePathOverride = null) {
    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--ignore-config',
            '--js-runtimes', 'node',
            '--flat-playlist',
            '--print', '%(playlist_title)s:::%(id)s:::%(title)s:::%(uploader)s',
            '--ignore-errors',
            '--no-abort-on-error',
            '--no-warnings',
            '--playlist-end', String(MAX_PLAYLIST_TRACKS)
        ];

        if (cookiePathOverride) {
            ytdlpArgs.push('--cookies', cookiePathOverride);
        } else if (COOKIES_PATH) {
            ytdlpArgs.push('--cookies', COOKIES_PATH);
        }

        ytdlpArgs.push('--', url);

        const ytdlp = spawn('yt-dlp', ytdlpArgs);
        let output = '';
        let timedOut = false;

        const timeout = setTimeout(() => {
            timedOut = true;
            ytdlp.kill('SIGKILL');
        }, 30000);
        const onAbort = () => ytdlp.kill('SIGKILL');
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });

        let outputBytes = 0;
        ytdlp.stdout.on('data', (data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_PLAYLIST_OUTPUT_BYTES) {
                ytdlp.kill('SIGKILL');
                return;
            }
            output += data.toString();
        });
        let stderr = '';
        ytdlp.stderr.on('data', (data) => {
            const text = data.toString();
            stderr = (stderr + text).slice(-8000);
            Logger.warn(`yt-dlp playlist stderr: ${text.trim()}`);
        });

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                reject(new AppError('CANCELLED'));
            } else if (timedOut) {
                reject(new AppError('TIMEOUT', { userMessage: 'Playlist metadata fetch timed out.' }));
            } else if (outputBytes > MAX_PLAYLIST_OUTPUT_BYTES) {
                reject(new AppError('TOO_LARGE', { userMessage: 'Playlist metadata exceeds the allowed size.' }));
            } else if (code === 0 || output.length > 0) {
                const lines = output.trim().split('\n').filter(Boolean);
                let playlistName = 'YouTube Playlist';

                const tracks = lines.map((line, index) => {
                    const parts = line.split(':::');
                    const pName = parts[0];
                    const id = parts[1];

                    if (index === 0 && pName && pName !== 'NA') {
                        playlistName = safeMetadataText(pName, playlistName);
                    }

                    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) return null;

                    return {
                        title: safeMetadataText(parts[2], 'Unknown Track'),
                        artist: safeMetadataText(parts[3], 'Unknown Artist'),
                        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                        playlistCover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                        videoId: id,
                        url: `https://www.youtube.com/watch?v=${id}`
                    };
                }).filter(Boolean);

                if (tracks.length === 0) {
                    reject(classifyError(new Error('Playlist is empty or videos are unavailable/private.'), stderr));
                } else {
                    resolve({ type: 'collection', name: playlistName, tracks });
                }
            } else {
                const err = new Error('Failed to fetch YouTube playlist tracks.');
                err.stderr = stderr;
                err.exitCode = code;
                reject(classifyError(err, stderr));
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            err.stderr = stderr;
            reject(classifyError(err, stderr));
        });
    });
}

// grab song or playlist info by reading the spotify embed page
async function getSpotifyData(url, signal) {
    const link = spotifyLinkDetails(url);
    if (!link) throw new Error('Invalid Spotify link.');

    const { type, id } = link;

    let coverImage = '';
    let collectionName = 'Spotify Collection';

    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}&format=json`;
        const oembedRes = await axios.get(oembedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 5000,
            maxRedirects: 0,
            maxContentLength: 1024 * 1024,
            signal
        });
        if (oembedRes.status === 200 && oembedRes.data) {
            coverImage = parseCoverUrl(oembedRes.data.thumbnail_url)?.href || '';
            collectionName = safeMetadataText(oembedRes.data.title, collectionName);
        }
    } catch (e) {
        Logger.warn(`Spotify oEmbed note: ${e.message}`);
    }

    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
    const response = await axios.get(embedUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 10000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        signal
    });

    const html = response.data;
    const jsonStrMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);

    const tracks = [];

    if (jsonStrMatch) {
        try {
            const data = JSON.parse(jsonStrMatch[1]);

            function findTracks(obj) {
                if (!obj || typeof obj !== 'object') return null;
                if (Array.isArray(obj.trackList) && obj.trackList.length > 0) return obj.trackList;
                if (obj.tracks && Array.isArray(obj.tracks.items) && obj.tracks.items.length > 0) {
                    return obj.tracks.items.map(i => i.track || i);
                }
                if (Array.isArray(obj.tracks) && obj.tracks.length > 0) return obj.tracks;
                for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                        const found = findTracks(obj[key]);
                        if (found) return found;
                    }
                }
                return null;
            }

            if (type === 'track') {
                const entity = data?.props?.pageProps?.state?.data?.entity;
                const artistName = (entity?.artists && Array.isArray(entity.artists))
                    ? entity.artists.map(a => a.name).join(', ')
                    : 'Unknown Artist';
                const albumName = entity?.album?.name || '';
                const releaseDate = entity?.album?.release_date || entity?.release_date || '';
                const releaseYear = releaseDate ? Number(String(releaseDate).slice(0, 4)) : null;
                tracks.push({
                    title: safeMetadataText(entity?.name, 'Unknown Track'),
                    artist: safeMetadataText(artistName, 'Unknown Artist'),
                    album: safeMetadataText(albumName, ''),
                    releaseYear: Number.isSafeInteger(releaseYear) ? releaseYear : null,
                    thumbnail: coverImage,
                    playlistCover: coverImage,
                    uri: `spotify:track:${id}`,
                    durationMs: getSpotifyDurationMs(entity)
                });
            } else {
                const rawTracks = findTracks(data)?.slice(0, MAX_PLAYLIST_TRACKS);
                if (rawTracks && rawTracks.length > 0) {
                    rawTracks.forEach(t => {
                        const trackData = t.track || t;
                        const title = safeMetadataText(trackData.title || trackData.name, 'Unknown Track');
                        let trackArtists = 'Unknown Artist';
                        if (Array.isArray(trackData.artists) && trackData.artists.length > 0) {
                            trackArtists = safeMetadataText(trackData.artists.map(a => (typeof a === 'string' ? a : a?.profile?.name || a?.name)).filter(Boolean).join(', '), 'Unknown Artist');
                        } else if (Array.isArray(trackData.artists?.items) && trackData.artists.items.length > 0) {
                            trackArtists = safeMetadataText(trackData.artists.items.map(a => a?.profile?.name || a?.name).filter(Boolean).join(', '), 'Unknown Artist');
                        } else if (typeof trackData.subtitle === 'string' && trackData.subtitle.trim()) {
                            // Embed trackList entries (playlists/albums) carry the artist(s) in `subtitle`.
                            trackArtists = safeMetadataText(trackData.subtitle.replace(/\u00a0/g, ' '), 'Unknown Artist');
                        }
                        const albumName = trackData.album?.name || (type === 'album' ? collectionName : '');
                        const releaseDate = trackData.album?.release_date || '';
                        const releaseYear = releaseDate ? Number(String(releaseDate).slice(0, 4)) : null;

                        const trackThumb = parseCoverUrl(trackData.coverArt?.sources?.[0]?.url || trackData.thumbnail || trackData.images?.[0]?.url)?.href || coverImage;
                        const trackUri = trackData.uri || (trackData.id ? `spotify:track:${trackData.id}` : null);

                        tracks.push({
                            title,
                            artist: trackArtists,
                            album: safeMetadataText(albumName, ''),
                            releaseYear: Number.isSafeInteger(releaseYear) ? releaseYear : null,
                            thumbnail: trackThumb,
                            playlistCover: coverImage,
                            uri: trackUri,
                            durationMs: getSpotifyDurationMs(trackData)
                        });
                    });
                }
            }
        } catch (parseErr) {
            Logger.warn(`JSON parse in Spotify failed, using meta fallback: ${parseErr.message}`);
        }
    }

    // fallback to regular meta tags if spotify's json data was empty
    if (tracks.length === 0 && type === 'track') {
        const titleMatch = html.match(/<meta property="og:title" content="(.*?)"/i) || html.match(/<title>(.*?)<\/title>/i);
        const descMatch = html.match(/<meta property="og:description" content="(.*?)"/i);
        const imageMatch = html.match(/<meta property="og:image" content="(.*?)"/i);

        let parsedTitle = titleMatch ? titleMatch[1] : 'Unknown Track';
        let parsedArtist = descMatch ? descMatch[1] : 'Unknown Artist';
        if (imageMatch && !coverImage) coverImage = parseCoverUrl(imageMatch[1])?.href || '';

        // spotify titles usually look like Title · Artist
        if (parsedTitle.includes(' · ')) {
            const parts = parsedTitle.split(' · ');
            parsedTitle = parts[0];
            parsedArtist = parts[1];
        }

        tracks.push({
            title: safeMetadataText(parsedTitle.replace(/ - song and lyrics by.*$/i, ''), 'Unknown Track'),
            artist: safeMetadataText(parsedArtist.replace(/Listen to.*on Spotify.*$/i, ''), 'Unknown Artist'),
            thumbnail: coverImage
        });
    }

    if (tracks.length === 0) {
        throw new Error('Unable to extract Spotify metadata. The track/playlist may be private or restricted.');
    }

    return { type, name: collectionName, tracks, thumbnail: coverImage };
}

// download the raw audio stream to a temp file using yt-dlp
async function downloadToTemp(targetUrl, extension = 'webm', signal, targetFormat, onProgress, logger = Logger, cookiePathOverride = null) {
    const stageTimer = startStage(logger, 'download');
    const tempPath = path.join(WORK_DIR, `ripcord_${randomUUID()}.${extension}`);
    await ytdlpSemaphore.acquire(signal);

    const ytId = getYouTubeVideoId(targetUrl);
    const canonicalTarget = ytId ? `https://www.youtube.com/watch?v=${ytId}` : targetUrl;

    try {
        return await new Promise((resolve, reject) => {
            const formatSelector = targetFormat === 'ogg'
                ? 'bestaudio[acodec=opus]/bestaudio/best'
                : targetFormat === 'm4a' ? 'bestaudio[acodec=aac]/bestaudio/best' : 'bestaudio/best';
            const ytdlpArgs = [
                '--ignore-config',
                '--js-runtimes', 'node',
                '-f', formatSelector,
                '--no-playlist',
                '--no-warnings',
                '--max-filesize', `${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))}M`,
                '--concurrent-fragments', String(YTDLP_CONCURRENT_FRAGMENTS)
            ];

            const activeCookiePath = cookiePathOverride || COOKIES_PATH;
            if (activeCookiePath) {
                ytdlpArgs.push('--cookies', activeCookiePath);
            } else {
                ytdlpArgs.push('--extractor-args', 'youtube:player_client=android,web');
            }

            if (YTDLP_USE_ARIA2C && aria2cAvailable) ytdlpArgs.push('--downloader', 'aria2c');

            if (onProgress) {
                ytdlpArgs.push('--newline', '--progress', '--progress-template',
                    'download:RIPCORD_PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s');
            }

            ytdlpArgs.push('-o', tempPath, '--', canonicalTarget);

            const ytdlp = spawn('yt-dlp', ytdlpArgs);
            ytdlp.stdout.on('data', chunk => {
                if (!onProgress) return;
                const matches = [...chunk.toString().matchAll(/RIPCORD_PROGRESS (\d+) (\d+(?:\.\d+)?)/g)];
                const last = matches[matches.length - 1];
                if (last && Number(last[2]) > 0) onProgress(Math.min(1, Number(last[1]) / Number(last[2])));
            });
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                ytdlp.kill('SIGKILL');
            }, 90000);
            const onAbort = () => ytdlp.kill('SIGKILL');
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });

            let stderr = '';
            ytdlp.stderr.on('data', (data) => {
                const text = data.toString();
                stderr = (stderr + text).slice(-8000);
                logger.warn(`yt-dlp: ${text.trim()}`);
            });

            ytdlp.on('close', (code) => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                if (signal?.aborted) {
                    cleanupFiles([tempPath]);
                    stageTimer.end('failed', { code: 'CANCELLED' });
                    reject(new AppError('CANCELLED'));
                } else if (timedOut) {
                    cleanupFiles([tempPath]);
                    stageTimer.end('failed', { code: 'TIMEOUT' });
                    reject(new AppError('TIMEOUT', { userMessage: 'Audio download timed out.' }));
                } else if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size <= MAX_DOWNLOAD_BYTES) {
                    stageTimer.end('ok');
                    resolve(tempPath);
                } else {
                    cleanupFiles([tempPath]);
                    const err = new Error('yt-dlp was unable to extract this audio source.');
                    err.stderr = stderr;
                    err.exitCode = code;
                    const appErr = classifyError(err, stderr);
                    stageTimer.end('failed', { code: appErr.code });
                    reject(appErr);
                }
            });

            ytdlp.on('error', (err) => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                cleanupFiles([tempPath]);
                err.stderr = stderr;
                const appErr = classifyError(err, stderr);
                stageTimer.end('failed', { code: appErr.code });
                reject(appErr);
            });
        });
    } finally {
        ytdlpSemaphore.release();
    }
}

async function runFfmpeg(args, timeoutMessage, signal, logger = Logger) {
    const stageTimer = startStage(logger, 'encode');
    await ffmpegSemaphore.acquire(signal);
    try {
        return await new Promise((resolve, reject) => {
            if (signal?.aborted) {
                stageTimer.end('failed', { code: 'CANCELLED' });
                return reject(new AppError('CANCELLED'));
            }

            const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
            let timedOut = false;
            let stderr = '';
            const timeout = setTimeout(() => {
                timedOut = true;
                ff.kill('SIGKILL');
            }, 60000);
            const onAbort = () => ff.kill('SIGKILL');
            signal?.addEventListener('abort', onAbort, { once: true });
            ff.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
            ff.on('error', error => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                error.stderr = stderr;
                const appErr = classifyError(error, stderr);
                stageTimer.end('failed', { code: appErr.code });
                reject(appErr);
            });
            ff.on('close', code => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                if (signal?.aborted) {
                    stageTimer.end('failed', { code: 'CANCELLED' });
                    reject(new AppError('CANCELLED'));
                } else if (timedOut) {
                    stageTimer.end('failed', { code: 'TIMEOUT' });
                    reject(new AppError('TIMEOUT', { userMessage: timeoutMessage }));
                } else if (code !== 0) {
                    const err = new Error('FFmpeg encoding failed.');
                    err.stderr = stderr;
                    err.exitCode = code;
                    const appErr = classifyError(err, stderr);
                    stageTimer.end('failed', { code: appErr.code });
                    reject(appErr);
                } else {
                    stageTimer.end('ok');
                    resolve();
                }
            });
        });
    } finally {
        ffmpegSemaphore.release();
    }
}

function ffmpegEncodeArgs(audioPath, outputPath, format, bitrate, coverPath, title, artist, maxBytes, copyAudio = false) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', audioPath];
    const embedsCover = coverPath && ['mp3', 'm4a', 'flac'].includes(format);
    if (embedsCover) args.push('-i', coverPath);
    args.push('-map', '0:a:0');
    if (embedsCover) args.push('-map', '1:v:0');

    if (copyAudio) args.push('-c:a', 'copy');
    else if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`);
    else if (format === 'm4a') args.push('-c:a', 'aac', '-b:a', `${bitrate}k`);
    else if (format === 'ogg') args.push('-c:a', 'libvorbis', '-b:a', `${bitrate}k`);
    else if (format === 'wav') args.push('-c:a', 'pcm_s16le');
    else if (format === 'flac') args.push('-c:a', 'flac', '-compression_level', '0');

    if (title) args.push('-metadata', `title=${title}`);
    if (artist) args.push('-metadata', `artist=${artist}`);
    if (embedsCover) {
        args.push('-c:v', 'copy');
        if (format === 'mp3') {
            args.push('-id3v2_version', '3', '-metadata:s:v', 'title=Album cover');
        }
        args.push('-disposition:v', 'attached_pic');
    }
    args.push('-fs', String(maxBytes), outputPath);
    return args;
}

function probeAudioCodec(filePath, logger = Logger) {
    const stageTimer = startStage(logger, 'probe');
    return new Promise(resolve => {
        const proc = spawn(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { windowsHide: true });

        let output = '';
        const timer = setTimeout(() => proc.kill('SIGKILL'), 10000);
        proc.stdout.on('data', data => { output += data.toString(); });
        proc.on('error', () => {
            clearTimeout(timer);
            stageTimer.end('failed');
            resolve(null);
        });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) {
                stageTimer.end('ok');
                resolve(output.trim() || null);
            } else {
                stageTimer.end('failed');
                resolve(null);
            }
        });
    });
}

// attach album cover art to ogg files
async function injectVorbisCoverArt(filePath, imgPath, format, logger = Logger) {
    if (format !== 'ogg') return false;
    if (!fs.existsSync(imgPath) || !fs.existsSync(filePath)) return false;
    const stageTimer = startStage(logger, 'tag');

    try {
        const imgBuffer = fs.readFileSync(imgPath);
        const mimeType = 'image/jpeg';
        const mimeBuf = Buffer.from(mimeType, 'utf8');
        const descBuf = Buffer.from('', 'utf8');

        const picType = Buffer.alloc(4); picType.writeUInt32BE(3, 0);
        const mimeLen = Buffer.alloc(4); mimeLen.writeUInt32BE(mimeBuf.length, 0);
        const descLen = Buffer.alloc(4); descLen.writeUInt32BE(descBuf.length, 0);
        const width = Buffer.alloc(4); width.writeUInt32BE(0, 0);
        const height = Buffer.alloc(4); height.writeUInt32BE(0, 0);
        const depth = Buffer.alloc(4); depth.writeUInt32BE(0, 0);
        const colors = Buffer.alloc(4); colors.writeUInt32BE(0, 0);
        const imgLen = Buffer.alloc(4); imgLen.writeUInt32BE(imgBuffer.length, 0);

        const block = Buffer.concat([picType, mimeLen, mimeBuf, descLen, descBuf, width, height, depth, colors, imgLen, imgBuffer]);
        const base64Block = block.toString('base64');

        const stdout = await new Promise((resolve, reject) => {
            const proc = spawn('vorbiscomment', ['-l', '-R', filePath], { windowsHide: true });
            let out = '';
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 15000);
            proc.stdout.on('data', d => { out += d.toString(); });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (timedOut || code !== 0) reject(new Error('vorbiscomment read failed'));
                else resolve(out);
            });
        });

        let comments = stdout.split('\n');
        comments = comments.filter(c => c && !c.startsWith('metadata_block_picture='));
        comments.push(`metadata_block_picture=${base64Block}\n`);

        await new Promise((resolve, reject) => {
            const proc = spawn('vorbiscomment', ['-w', '-R', filePath], { windowsHide: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 15000);
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (timedOut || code !== 0) reject(new Error('vorbiscomment write failed'));
                else resolve();
            });
            proc.stdin.write(comments.join('\n'));
            proc.stdin.end();
        });

        stageTimer.end('ok');
        return true;
    } catch {
        stageTimer.end('failed');
        return false;
    }
}

// transcode the audio with ffmpeg and stream it directly to the user
async function processAndStreamAudio(target, bitrate, format, thumbnailUrl, res, filename = '', artist = '', signal, req = null, logger = Logger, isTempFile = false) {
    const tempFiles = [];

    // clean up temp files if the user closes their browser or cancels
    const onDisconnect = () => cleanupFiles(tempFiles);
    res.on('close', onDisconnect);

    try {
        let tempAudioPath;
        if (isTempFile) {
            tempAudioPath = target;
            tempFiles.push(tempAudioPath);
        } else {
            logger.info('Downloading validated audio source');
            try {
                tempAudioPath = await downloadToTemp(target, format === 'm4a' ? 'm4a' : 'webm', signal, format, undefined, logger);
                tempFiles.push(tempAudioPath);
            } catch (err) {
                if (err?.code === 'AGE_RESTRICTED' && ageGateCookiePool.isEnabled()) {
                    logger.info('Track is age-restricted, acquiring age-gate cookie account for automatic retry');
                    const lease = await ageGateCookiePool.acquire();
                    if (!lease) {
                        throw new AppError('AGE_RESTRICTED');
                    }
                    try {
                        tempAudioPath = await downloadToTemp(target, format === 'm4a' ? 'm4a' : 'webm', signal, format, undefined, logger, lease.cookiePath);
                        tempFiles.push(tempAudioPath);
                        lease.release(true);
                    } catch (cookieErr) {
                        lease.release(false, cookieErr);
                        throw cookieErr;
                    }
                } else {
                    throw err;
                }
            }
        }

        let tempImgPath = '';
        const safeThumbnail = parseCoverUrl(thumbnailUrl);
        if (safeThumbnail) {
            try {
                const imgRes = await axios.get(safeThumbnail.href, {
                    responseType: 'arraybuffer',
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 6000,
                    maxRedirects: 0,
                    maxContentLength: MAX_COVER_BYTES,
                    signal
                });
                if (imgRes.status === 200 && imgRes.data && imgRes.data.length > 500) {
                    const tempRawPath = path.join(WORK_DIR, `cover_raw_${randomUUID()}.img`);
                    fs.writeFileSync(tempRawPath, Buffer.from(imgRes.data));
                    tempFiles.push(tempRawPath);

                    const isYouTube = safeThumbnail.hostname.includes('ytimg.com');
                    if (isYouTube) {
                        const tempSquarePath = path.join(WORK_DIR, `cover_sq_${randomUUID()}.img`);
                        tempFiles.push(tempSquarePath);
                        const ok = await cropToSquareJpeg(tempRawPath, tempSquarePath, logger);
                        tempImgPath = ok ? tempSquarePath : tempRawPath;
                    } else {
                        tempImgPath = tempRawPath;
                    }
                }
            } catch (imgErr) {
                logger.warn(`Cover art fetch omitted: ${imgErr.message}`);
            }
        }

        const tempOutPath = path.join(WORK_DIR, `out_${randomUUID()}.${format}`);
        tempFiles.push(tempOutPath);

        const sourceCodec = await probeAudioCodec(tempAudioPath, logger);
        const copyAudio = (format === 'ogg' && sourceCodec === 'opus') || (format === 'm4a' && sourceCodec === 'aac');
        logger.info(copyAudio
            ? `Remuxing ${sourceCodec} audio into [${format.toUpperCase()}]`
            : `Encoding audio to [${format.toUpperCase()}] at ${bitrate} kbps`);
        const args = ffmpegEncodeArgs(tempAudioPath, tempOutPath, format, bitrate, tempImgPath, filename || 'Track', artist || 'Unknown Artist', MAX_AUDIO_OUTPUT_BYTES, copyAudio);
        await runFfmpeg(args, 'Audio encoding timed out.', signal, logger);
        if (signal?.aborted) throw new AppError('CANCELLED');
        if (fs.statSync(tempOutPath).size >= MAX_AUDIO_OUTPUT_BYTES) throw new AppError('TOO_LARGE', { userMessage: 'Audio output exceeds the allowed size.' });

        if (tempImgPath && fs.existsSync(tempOutPath) && format === 'ogg') {
            await injectVorbisCoverArt(tempOutPath, tempImgPath, format, logger);
        }

        logger.success(`Encoding complete. Streaming ${format.toUpperCase()} to client`);
        const fileStat = fs.statSync(tempOutPath);
        if (fileStat.size > MAX_AUDIO_OUTPUT_BYTES) throw new AppError('TOO_LARGE', { userMessage: 'Audio output exceeds the allowed size.' });
        res.setHeader('Content-Length', fileStat.size);

        const readStream = fs.createReadStream(tempOutPath);
        readStream.pipe(res);
        readStream.on('error', () => res.destroy());

        readStream.on('end', () => {
            res.removeListener('close', onDisconnect);
            cleanupFiles(tempFiles);
        });

    } catch (error) {
        const appErr = classifyError(error, error?.stderr || '');
        logger.error(`Audio processing error: [${appErr.code}] ${appErr.message}`);
        res.removeListener('close', onDisconnect);
        cleanupFiles(tempFiles);
        if (!res.headersSent) {
            sendError(res, appErr, req);
        } else if (!res.destroyed) res.destroy();
        throw appErr;
    }
}

async function downloadPlaylistTrack(track, index, audioFormat, signal, report = () => { }, logger = Logger, jobExcludedVideoIds = new Set()) {
    const trackLogger = logger.child({ trackIndex: index });
    const tempFiles = [];

    try {
        report(index, { state: 'matching', progress: 0 });
        const title = String(track.title || 'Unknown Track').slice(0, 200);
        const artist = String(track.artist || 'Unknown Artist').slice(0, 200);
        trackLogger.info(`Downloading track: ${sanitizeAsciiHeader(`${title} - ${artist}`)}`);

        let tempAudioPath;
        let note = null;
        let tempImgPath = '';
        let coverSource = 'none';

        // Start Spotify track art fetch concurrently if this is a Spotify track with URI
        const spotifyCoverPromise = (async () => {
            if (track.uri) {
                const coverUrl = await fetchSpotifyTrackCoverUrl(track.uri, signal, trackLogger);
                if (coverUrl) {
                    const buf = await fetchCoverBuffer(coverUrl, signal);
                    if (buf) return { buffer: buf, source: 'spotify', isSquare: true };
                }
            }
            return null;
        })();

        if (track.url) {
            if (!isSafeUrl(track.url)) throw new Error('Invalid playlist track URL.');
            report(index, { state: 'downloading', progress: 0 });
            const matchedVideoId = track.videoId || extractSingleVideoId(new URL(track.url));

            const ytCoverPromise = (async () => {
                if (matchedVideoId) {
                    const res = await fetchYouTubeThumbnailBuffer(matchedVideoId, signal);
                    if (res) return { buffer: res.buffer, source: 'youtube', isSquare: false };
                }
                return null;
            })();

            try {
                const downloadPromise = downloadToTemp(track.url, audioFormat === 'm4a' ? 'm4a' : 'webm', signal, audioFormat,
                    fraction => report(index, { state: 'downloading', progress: fraction }), trackLogger);
                const [dlPath, ytCover] = await Promise.all([downloadPromise, ytCoverPromise]);
                tempAudioPath = dlPath;
                tempFiles.push(tempAudioPath);

                let coverInfo = ytCover;
                if (!coverInfo && track.playlistCover) {
                    const buf = await fetchCoverBuffer(track.playlistCover, signal);
                    if (buf) coverInfo = { buffer: buf, source: 'playlist', isSquare: false };
                }
                if (coverInfo) {
                    coverSource = coverInfo.source;
                    const tempRawPath = path.join(WORK_DIR, `cover_raw_${randomUUID()}.img`);
                    fs.writeFileSync(tempRawPath, coverInfo.buffer);
                    tempFiles.push(tempRawPath);

                    if (!coverInfo.isSquare) {
                        const tempSquarePath = path.join(WORK_DIR, `cover_sq_${randomUUID()}.img`);
                        tempFiles.push(tempSquarePath);
                        const ok = await cropToSquareJpeg(tempRawPath, tempSquarePath, trackLogger);
                        tempImgPath = ok ? tempSquarePath : tempRawPath;
                    } else {
                        tempImgPath = tempRawPath;
                    }
                }
            } catch (err) {
                if (err?.code === 'AGE_RESTRICTED' && ageGateCookiePool.isEnabled()) {
                    trackLogger.info('Track is age-restricted, acquiring age-gate cookie account for automatic retry');
                    const lease = await ageGateCookiePool.acquire();
                    if (!lease) throw err;
                    try {
                        tempAudioPath = await downloadToTemp(track.url, audioFormat === 'm4a' ? 'm4a' : 'webm', signal, audioFormat,
                            fraction => report(index, { state: 'downloading', progress: fraction }), trackLogger, lease.cookiePath);
                        tempFiles.push(tempAudioPath);
                        lease.release(true);
                    } catch (cookieErr) {
                        lease.release(false, cookieErr);
                        throw cookieErr;
                    }
                } else {
                    throw err;
                }
            }
        } else {
            // Spotify track: run candidate fallback
            const downloadPromise = downloadSpotifyAudioWithFallback({
                track: { ...track, title, artist },
                audioFormat,
                signal,
                onProgress: fraction => report(index, { state: 'downloading', progress: fraction }),
                logger: trackLogger,
                jobExcludedVideoIds,
                onNote: n => {
                    note = n;
                    report(index, { note: n });
                }
            });
            const [downloadResult, spCover] = await Promise.all([downloadPromise, spotifyCoverPromise]);
            tempAudioPath = downloadResult.tempAudioPath;
            tempFiles.push(tempAudioPath);
            if (downloadResult.alternateUsed) {
                note = 'alternate version used';
                report(index, { note });
            }

            // Fallback chain for Spotify track:
            // 1. Spotify track art
            let coverInfo = spCover;

            // 2. Matched YouTube thumb
            if (!coverInfo && downloadResult.candidate?.videoId) {
                const ytThumb = await fetchYouTubeThumbnailBuffer(downloadResult.candidate.videoId, signal);
                if (ytThumb) {
                    coverInfo = { buffer: ytThumb.buffer, source: 'youtube', isSquare: false };
                }
            }

            // 3. Playlist cover
            if (!coverInfo && (track.thumbnail || track.playlistCover)) {
                const coverUrl = track.playlistCover || track.thumbnail;
                const buf = await fetchCoverBuffer(coverUrl, signal);
                if (buf) {
                    coverInfo = { buffer: buf, source: 'playlist', isSquare: true };
                }
            }

            if (coverInfo) {
                coverSource = coverInfo.source;
                const tempRawPath = path.join(WORK_DIR, `cover_raw_${randomUUID()}.img`);
                fs.writeFileSync(tempRawPath, coverInfo.buffer);
                tempFiles.push(tempRawPath);

                if (!coverInfo.isSquare) {
                    const tempSquarePath = path.join(WORK_DIR, `cover_sq_${randomUUID()}.img`);
                    tempFiles.push(tempSquarePath);
                    const ok = await cropToSquareJpeg(tempRawPath, tempSquarePath, trackLogger);
                    tempImgPath = ok ? tempSquarePath : tempRawPath;
                } else {
                    tempImgPath = tempRawPath;
                }
            }
        }

        trackLogger.info(`Cover art applied: [${coverSource}] for "${sanitizeAsciiHeader(title)}"`);

        return { track, index, title, artist, tempAudioPath, tempImgPath, note };
    } catch (err) {
        const appErr = classifyError(err, err?.stderr || '');
        trackLogger.error(`Track failed: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - [${appErr.code}] ${appErr.message}`);
        report(index, { state: 'failed', progress: 1, error: appErr.userMessage, code: appErr.code });
        cleanupFiles(tempFiles);
        return null;
    }
}

// convert one downloaded song so it can be added to the zip file
async function processPlaylistTrack(source, audioBitrate, audioFormat, signal, report = () => { }, logger = Logger) {
    const { track, index, title, artist, tempAudioPath, tempImgPath } = source;
    const trackLogger = logger.child({ trackIndex: index });
    const tempFiles = [tempAudioPath, tempImgPath].filter(Boolean);

    try {
        report(index, { state: 'encoding', progress: 0 });
        trackLogger.info(`Encoding track: ${sanitizeAsciiHeader(`${title} - ${artist}`)}`);
        const tempOutPath = path.join(WORK_DIR, `track_${randomUUID()}.${audioFormat}`);
        tempFiles.push(tempOutPath);

        const sourceCodec = await probeAudioCodec(tempAudioPath, trackLogger);
        const copyAudio = (audioFormat === 'ogg' && sourceCodec === 'opus') || (audioFormat === 'm4a' && sourceCodec === 'aac');
        trackLogger.info(copyAudio
            ? `Remuxing ${sourceCodec} audio into [${audioFormat.toUpperCase()}]`
            : `Encoding audio to [${audioFormat.toUpperCase()}] at ${audioBitrate} kbps`);
        const args = ffmpegEncodeArgs(tempAudioPath, tempOutPath, audioFormat, audioBitrate, tempImgPath, title, artist, zipTrackLimit(audioFormat), copyAudio);
        await runFfmpeg(args, 'Track encoding timed out.', signal, trackLogger);
        if (signal?.aborted) throw new AppError('CANCELLED');
        if (fs.statSync(tempOutPath).size >= zipTrackLimit(audioFormat)) throw new AppError('TOO_LARGE', { userMessage: 'Playlist track exceeds the allowed size.' });

        if (tempImgPath && fs.existsSync(tempOutPath) && audioFormat === 'ogg') {
            await injectVorbisCoverArt(tempOutPath, tempImgPath, audioFormat, trackLogger);
        }

        if (fs.statSync(tempOutPath).size > zipTrackLimit(audioFormat)) throw new AppError('TOO_LARGE', { userMessage: 'Playlist track exceeds the allowed size.' });
        const safeName = sanitizeFilename(`${String(index + 1).padStart(2, '0')} - ${title} - ${artist}.${audioFormat}`);

        cleanupFiles(tempFiles.filter(file => file !== tempOutPath));
        report(index, { state: 'done', progress: 1 });
        return { name: safeName, filePath: tempOutPath };

    } catch (err) {
        const appErr = classifyError(err, err?.stderr || '');
        trackLogger.error(`Track encode failed: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - [${appErr.code}] ${appErr.message}`);
        report(index, { state: 'failed', progress: 1, error: appErr.userMessage, code: appErr.code });
        cleanupFiles(tempFiles);
        return null;
    }
}

// worker function that processes the actual download request
async function executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res, signal, jobId = null, customTitle = '', req = null) {
    const taskLogger = (req?.logger || Logger).child({ jobId: jobId || randomUUID() });
    const jobStartTime = Date.now();
    let job = null;
    const jobExcludedVideoIds = new Set();

    try {
        taskLogger.info(`Task started (${audioFormat.toUpperCase()})`);
        if (signal.aborted) return;

        const spotifyLink = spotifyLinkDetails(url);

        const mimeTypes = {
            mp3: 'audio/mpeg',
            m4a: 'audio/mp4',
            ogg: 'audio/ogg',
            wav: 'audio/wav',
            flac: 'audio/flac'
        };
        const mimeType = mimeTypes[audioFormat] || 'audio/mpeg';
        const asciiFilename = sanitizeAsciiHeader(safeFilename);

        // download a single youtube video
        if (isYouTubeUrl(url) && !isYouTubePlaylist(url)) {
            res.setHeader('Content-Disposition', buildContentDisposition(customTitle || safeFilename, audioFormat));
            res.setHeader('Content-Type', mimeType);
            const info = await getYoutubeInfo(url, signal);
            const trackTitle = customTitle || info.title;
            await processAndStreamAudio(url, audioBitrate, audioFormat, info.thumbnail, res, trackTitle, info.author, signal, req, taskLogger, false);
            return;
        }

        // download a single spotify track
        if (spotifyLink?.type === 'track') {
            res.setHeader('Content-Disposition', buildContentDisposition(customTitle || safeFilename, audioFormat));
            res.setHeader('Content-Type', mimeType);
            const spotifyData = await getSpotifyData(url, signal);
            const track = spotifyData.tracks[0];
            const trackTitle = customTitle || track.title;
            const downloaded = await downloadSpotifyAudioWithFallback({
                track,
                audioFormat,
                signal,
                onProgress: undefined,
                logger: taskLogger,
                jobExcludedVideoIds,
                onNote: (note) => {
                    res.setHeader('X-Ripcord-Note', note);
                }
            });
            await processAndStreamAudio(downloaded.tempAudioPath, audioBitrate, audioFormat, track.thumbnail, res, trackTitle, track.artist, signal, req, taskLogger, true);
            return;
        }

        // download full playlists or albums as a zip
        let collectionData = null;
        if (isYouTubePlaylist(url)) {
            taskLogger.info('Fetching YouTube playlist items');
            try {
                collectionData = await getYoutubePlaylistData(url, signal);
            } catch (err) {
                if (err?.code === 'AGE_RESTRICTED' && ageGateCookiePool.isEnabled()) {
                    const lease = await ageGateCookiePool.acquire();
                    if (!lease) throw err;
                    try {
                        collectionData = await getYoutubePlaylistData(url, signal, lease.cookiePath);
                        lease.release(true);
                    } catch (cookieErr) {
                        lease.release(false, cookieErr);
                        throw cookieErr;
                    }
                } else {
                    throw err;
                }
            }
        } else if (spotifyLink && spotifyLink.type !== 'track') {
            taskLogger.info('Fetching Spotify collection items');
            collectionData = await getSpotifyData(url, signal);
        }

        if (collectionData && collectionData.tracks && collectionData.tracks.length > 0) {
            const zipBase = collectionData.name || customTitle || safeFilename || 'ripcord-playlist';
            res.setHeader('Content-Disposition', buildContentDisposition(zipBase, 'zip'));
            res.setHeader('Content-Type', 'application/zip');

            const { ZipArchive } = await import('archiver');
            const archive = new ZipArchive({ store: true });
            archive.pipe(res);

            archive.on('warning', (err) => taskLogger.warn(`ZIP archive warning: ${err.message}`));
            const trackFilePaths = new Set();
            const archiveFilePaths = new Map();
            const cleanupTrackFiles = () => {
                cleanupFiles([...trackFilePaths]);
                trackFilePaths.clear();
                archiveFilePaths.clear();
            };
            archive.on('entry', entry => {
                const filePath = archiveFilePaths.get(entry.name);
                if (filePath) {
                    cleanupFiles([filePath]);
                    trackFilePaths.delete(filePath);
                    archiveFilePaths.delete(entry.name);
                }
            });
            archive.on('error', (err) => {
                taskLogger.error(`ZIP archive error: ${err.message}`);
                cleanupTrackFiles();
                if (!res.destroyed) res.destroy(err);
            });
            const onAbort = () => {
                try {
                    archive.abort();
                } finally {
                    cleanupTrackFiles();
                }
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });

            const tracks = collectionData.tracks.slice(0, MAX_PLAYLIST_TRACKS);
            let addedTracks = 0;
            job = createJob(jobId, tracks);
            const report = (index, patch) => {
                if (job?.tracks[index]) Object.assign(job.tracks[index], patch);
            };

            try {
                const handoffQueue = new AsyncBoundedQueue(4);
                let nextTrack = 0;
                const downloadWorker = async () => {
                    while (!signal.aborted) {
                        const index = nextTrack++;
                        if (index >= tracks.length) return;
                        const downloaded = await downloadPlaylistTrack(tracks[index], index, audioFormat, signal, report, taskLogger, jobExcludedVideoIds);
                        if (!downloaded) continue;
                        try {
                            await handoffQueue.push(downloaded);
                        } catch {
                            cleanupFiles([downloaded.tempAudioPath, downloaded.tempImgPath]);
                            return;
                        }
                    }
                };
                const encodeWorker = async () => {
                    while (!signal.aborted) {
                        const downloaded = await handoffQueue.shift();
                        if (!downloaded) return;
                        const result = await processPlaylistTrack(downloaded, audioBitrate, audioFormat, signal, report, taskLogger);
                        if (signal.aborted) {
                            if (result?.filePath) cleanupFiles([result.filePath]);
                            return;
                        }
                        if (result?.filePath) {
                            trackFilePaths.add(result.filePath);
                            archiveFilePaths.set(result.name, result.filePath);
                            archive.file(result.filePath, { name: result.name });
                            addedTracks++;
                        }
                    }
                };

                const encodeWorkers = Array.from({ length: ENCODE_CONCURRENCY }, () => encodeWorker());
                const downloadWorkers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, () => downloadWorker());
                await Promise.all(downloadWorkers);
                handoffQueue.close();
                await Promise.all(encodeWorkers);

                if (signal.aborted) throw new AppError('CANCELLED');
                if (addedTracks === 0) {
                    const noMatchErr = new AppError('NO_MATCH', { userMessage: 'No tracks could be processed.' });
                    endJob(jobId, 'failed', noMatchErr);
                    throw noMatchErr;
                }

                const zipTimer = startStage(taskLogger, 'zip');
                await archive.finalize();
                zipTimer.end('ok');

                endJob(jobId, 'finished');
                taskLogger.success(`Archive completed: ${zipBase}`);
            } catch (jobErr) {
                const appErr = classifyError(jobErr, jobErr?.stderr || '');
                if (job?.status === 'running') endJob(jobId, signal.aborted ? 'cancelled' : 'failed', appErr);
                throw appErr;
            } finally {
                signal.removeEventListener('abort', onAbort);
                cleanupTrackFiles();
                if (job?.status === 'running') endJob(jobId, signal.aborted ? 'cancelled' : 'failed', new AppError(signal.aborted ? 'CANCELLED' : 'INTERNAL'));
            }
            return;
        }

        if (!res.headersSent) {
            sendError(res, new AppError('UNSUPPORTED_URL', { userMessage: 'Unsupported or unreadable URL format.' }), req);
        }

    } catch (error) {
        const appErr = classifyError(error, error?.stderr || '');
        taskLogger.error(`Queue execution error: [${appErr.code}] ${appErr.message}`);
        if (!res.headersSent) {
            sendError(res, appErr, req);
        } else if (!res.destroyed) res.destroy();
    } finally {
        if (job) {
            const jobTotalMs = Date.now() - jobStartTime;
            const okCount = job.tracks.filter(t => t.state === 'done').length;
            const failedTracks = job.tracks.filter(t => t.state === 'failed');
            const failedCount = failedTracks.length;
            const failedByCode = {};
            for (const t of failedTracks) {
                const c = t.code || 'UNKNOWN';
                failedByCode[c] = (failedByCode[c] || 0) + 1;
            }
            const failureDetail = Object.entries(failedByCode).map(([c, n]) => `${n} ${c}`).join(', ');
            taskLogger.info(`Job summary: ${okCount} ok, ${failedCount} failed${failureDetail ? `: ${failureDetail}` : ''} (${jobTotalMs}ms total)`, {
                stage: 'job_summary',
                durationMs: jobTotalMs,
                okCount,
                failedCount,
                failures: failedByCode
            });
        }
    }
}

// health check route so uptime monitors know the server is running
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// inspect a link and return title, artist, and cover art
app.get('/api/fetch-info', rejectCrossSiteRequests, async (req, res) => {
    try {
        const rawUrl = req.query.url;
        if (!isSafeUrl(rawUrl)) {
            return sendError(res, new AppError('INVALID_URL', { userMessage: 'Please enter a valid Spotify or YouTube URL.' }), req);
        }
        const parsedUrl = new URL(rawUrl);
        parsedUrl.hash = '';
        const url = normalizeYouTubeUrl(parsedUrl.href);
        const controller = new AbortController();
        let metadataAcquisition = null;
        res.once('close', () => {
            if (!res.writableEnded) {
                controller.abort();
                metadataAcquisition?.cancel();
            }
        });

        Logger.info(`Metadata requested from ${new URL(url).hostname}`);

        if (isYouTubeUrl(url) && !isYouTubePlaylist(url) && !getYouTubeVideoId(url)) {
            return sendError(res, new AppError('MIX_NOT_SUPPORTED'), req);
        }

        if (isYouTubePlaylist(url)) {
            metadataAcquisition = metadataSemaphore.tryAcquire();
            if (!metadataAcquisition) {
                return sendError(res, new AppError('QUEUE_FULL', { userMessage: 'The metadata queue is full. Please try again shortly.' }), req);
            }
            let release;
            try {
                release = await metadataAcquisition;
                if (controller.signal.aborted) return;
                let ytData;
                try {
                    ytData = await getYoutubePlaylistData(url, controller.signal);
                } catch (err) {
                    const appErr = classifyError(err, err?.stderr || '');
                    if (appErr.code === 'AGE_RESTRICTED' && ageGateCookiePool.isEnabled()) {
                        const lease = await ageGateCookiePool.acquire();
                        if (lease) {
                            try {
                                ytData = await getYoutubePlaylistData(url, controller.signal, lease.cookiePath);
                                lease.release(true);
                            } catch (cookieErr) {
                                lease.release(false, cookieErr);
                                throw cookieErr;
                            }
                        } else {
                            throw appErr;
                        }
                    } else {
                        throw err;
                    }
                }
                return res.json({
                    type: 'collection',
                    title: ytData.name,
                    trackCount: ytData.tracks.length,
                    tracks: ytData.tracks.map(t => ({ title: t.title, artist: t.artist || '' })),
                    thumbnail: ytData.tracks[0]?.thumbnail || '',
                    url
                });
            } finally {
                release?.();
                metadataAcquisition.cancel();
            }
        } else if (isYouTubeUrl(url)) {
            const info = await getYoutubeInfo(url, controller.signal);
            return res.json({
                type: 'track',
                title: info.title,
                artist: info.author,
                thumbnail: info.thumbnail,
                url
            });
        } else if (spotifyLinkDetails(url)?.type === 'track') {
            const spotifyData = await getSpotifyData(url, controller.signal);
            const track = spotifyData.tracks[0];
            return res.json({
                type: 'track',
                title: track.title,
                artist: track.artist,
                thumbnail: track.thumbnail,
                url
            });
        } else if (spotifyLinkDetails(url)) {
            const spotifyData = await getSpotifyData(url, controller.signal);
            return res.json({
                type: 'collection',
                title: spotifyData.name,
                trackCount: spotifyData.tracks.length,
                tracks: spotifyData.tracks.map(t => ({ title: t.title, artist: t.artist === 'Unknown Artist' ? '' : t.artist })),
                thumbnail: spotifyData.thumbnail,
                url
            });
        } else {
            return sendError(res, new AppError('UNSUPPORTED_URL', { userMessage: 'Unsupported URL. Please provide a Spotify or YouTube link.' }), req);
        }
    } catch (error) {
        const appErr = classifyError(error, error?.stderr || '');
        Logger.error(`Fetch info error: [${appErr.code}] ${appErr.message}`);
        if (!res.destroyed && !res.headersSent) sendError(res, appErr, req);
    }
});

// api endpoint to start downloading the audio
app.get('/api/download', rejectCrossSiteRequests, (req, res) => {
    const rawUrl = req.query.url;
    const bitrate = req.query.bitrate;
    const filename = req.query.filename;
    const format = req.query.format;
    const title = req.query.title;
    const audioBitrate = bitrate === undefined
        ? 128
        : typeof bitrate === 'string' && /^\d{2,3}$/.test(bitrate) ? Number(bitrate) : NaN;
    const audioFormat = format === undefined ? 'mp3' : format;

    if (!isSafeUrl(rawUrl)) {
        return sendError(res, new AppError('INVALID_URL', { userMessage: 'Invalid URL provided.' }), req);
    }
    if (typeof audioFormat !== 'string' || !['mp3', 'm4a', 'flac', 'wav', 'ogg'].includes(audioFormat)) {
        return sendError(res, new AppError('UNSUPPORTED_FORMAT', { userMessage: 'Unsupported audio format.' }), req);
    }
    if (typeof audioBitrate !== 'number' || ![128, 192, 320].includes(audioBitrate)) {
        return sendError(res, new AppError('UNSUPPORTED_FORMAT', { userMessage: 'Unsupported audio bitrate.' }), req);
    }
    if (filename !== undefined && (typeof filename !== 'string' || filename.length > 120)) {
        return sendError(res, new AppError('INVALID_URL', { userMessage: 'Filename is invalid or too long.' }), req);
    }
    if (title !== undefined && (typeof title !== 'string' || title.length > 120)) {
        return sendError(res, new AppError('INVALID_URL', { userMessage: 'Title is invalid or too long.' }), req);
    }

    const parsedUrl = new URL(rawUrl);
    parsedUrl.hash = '';
    const url = normalizeYouTubeUrl(parsedUrl.href);
    const safeFilename = sanitizeFilename(filename);
    const customTitle = title !== undefined ? safeMetadataText(title) : '';

    const jobId = typeof req.query.job === 'string' && JOB_ID_PATTERN.test(req.query.job) ? req.query.job : null;

    const accepted = downloadQueue.addTask(
        signal => executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res, signal, jobId, customTitle, req),
        res,
        req
    );
    if (!accepted) {
        return sendError(res, new AppError('QUEUE_FULL', { userMessage: 'The download queue is full. Please try again shortly.' }), req);
    }
});

// image proxy so the frontend can read album cover pixels without cors errors
app.get('/api/cover', rejectCrossSiteRequests, async (req, res) => {
    const target = parseCoverUrl(req.query.url);
    if (!target) {
        return sendError(res, new AppError('INVALID_URL', { userMessage: 'Image host not allowed.' }), req);
    }

    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
        const upstream = await axios.get(target.href, {
            responseType: 'stream',
            timeout: 6000,
            maxRedirects: 0,
            maxContentLength: MAX_COVER_BYTES,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal
        });
        const type = String(upstream.headers['content-type'] || '');
        const contentLength = Number(upstream.headers['content-length']);
        const contentType = type.split(';', 1)[0].trim().toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)
            || (Number.isFinite(contentLength) && contentLength > MAX_COVER_BYTES)) {
            upstream.data.destroy();
            return sendError(res, new AppError('INVALID_URL', { httpStatus: 502, userMessage: 'Not an image.' }), req);
        }
        let receivedBytes = 0;
        const sizeLimit = new Transform({
            transform(chunk, encoding, callback) {
                receivedBytes += chunk.length;
                if (receivedBytes > MAX_COVER_BYTES) callback(new Error('Cover image exceeds size limit.'));
                else callback(null, chunk);
            }
        });
        const streamError = () => {
            upstream.data.destroy();
            if (res.destroyed) return;
            if (res.headersSent) res.destroy();
            else sendError(res, new AppError('INTERNAL', { httpStatus: 502, userMessage: 'Could not load image.' }), req);
        };
        upstream.data.on('error', streamError);
        sizeLimit.on('error', streamError);
        res.set('Content-Type', type.split(';', 1)[0]);
        res.set('Cache-Control', 'public, max-age=86400');
        upstream.data.pipe(sizeLimit).pipe(res);
    } catch {
        if (!res.destroyed && !res.headersSent) sendError(res, new AppError('INTERNAL', { httpStatus: 502, userMessage: 'Could not load image.' }), req);
    }
});

app.use('/api', (req, res) => sendError(res, new AppError('INVALID_URL', { httpStatus: 404, userMessage: 'API endpoint not found.' }), req));

// send index.html for any other GET route
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
    Logger.error(`Unhandled request error: ${err.message}`);
    if (res.headersSent) return res.destroy();
    sendError(res, classifyError(err), req);
});

process.on('unhandledRejection', (reason) => {
    Logger.error(`Unhandled Rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`);
});

process.on('uncaughtException', (err) => {
    Logger.error(`Uncaught Exception: ${err.stack || err.message}`);
    gracefulShutdown('uncaughtException');
});

let serverInstance = null;
let shutdownPromise = null;

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

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
    const PORT = positiveIntegerEnv('PORT', 5224, 65535);
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
        Logger.success(`Ripcord server live at http://localhost:${PORT}`);
        Logger.info('Ready for requests under domain');
    });
    serverInstance.headersTimeout = 15000;
    serverInstance.requestTimeout = 30000;
    serverInstance.keepAliveTimeout = 5000;
}

module.exports = {
    app,
    isSafeUrl,
    normalizeYouTubeUrl,
    isYouTubePlaylist,
    MetadataSemaphore,
    Semaphore,
    DownloadQueue,
    sweepWorkDir,
    cleanupStaleWorkFiles,
    gracefulShutdown,
    AppError,
    ERROR_DEFINITIONS,
    classifyError,
    sendError,
    StructuredLogger,
    Logger,
    redactLog,
    AgeGateLruCache,
    ageRestrictedCache,
    findSpotifyCandidates,
    downloadSpotifyAudioWithFallback,
    AgeGateCookiePool,
    buildContentDisposition,
    SpotifyCoverCache,
    spotifyCoverCache,
    fetchSpotifyTrackCoverUrl,
    fetchYouTubeThumbnailBuffer,
    fetchCoverBuffer,
    cropToSquareJpeg,
    parseCoverUrl,
    computeJobSummary
};

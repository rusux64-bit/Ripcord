const path = require('path');
const { COOKIES_PATH } = require('./config');

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

function sanitizeAsciiHeader(name) {
    const ascii = String(name || '').replace(/[^\x20-\x7E]/g, '').replace(/["\\;]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    return ascii || 'download';
}

function safeMetadataText(value, fallback = '') {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return text.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || fallback;
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
            } else if (extra?.code === 'CANCELLED') {
                stageLogger.info(`Stage cancelled: ${stage}`, { durationMs, ...extra });
            } else {
                stageLogger.warn(`Stage failed: ${stage}`, { durationMs, ...extra });
            }
            return durationMs;
        }
    };
}

module.exports = {
    redactLog,
    sanitizeAsciiHeader,
    safeMetadataText,
    LOG_LEVELS,
    CURRENT_LOG_LEVEL,
    LOG_FORMAT,
    StructuredLogger,
    Logger,
    startStage
};

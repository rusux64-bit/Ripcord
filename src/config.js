const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

try {
    require('dotenv').config();
} catch {}

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
            } catch (e) {}
        }
    }
    return null;
}

let ffmpegStatic = null;
try {
    ffmpegStatic = require('ffmpeg-static');
} catch {}

const ffmpegPath = findExecutableInPath('ffmpeg') || ffmpegStatic || 'ffmpeg';
const ffprobePath = findExecutableInPath('ffprobe') || 'ffprobe';

const checkYtdlp = spawnSync('yt-dlp', ['--version']);
const ytdlpAvailable = checkYtdlp.status === 0;
const ytdlpVersion = ytdlpAvailable ? checkYtdlp.stdout.toString().trim() : 'NOT INSTALLED';

function resolveCookiesPath() {
    const raw = (process.env.YTDLP_COOKIES_PATH || '').trim();
    if (raw && raw.toLowerCase() !== 'none' && raw.toLowerCase() !== 'false' && fs.existsSync(raw)) {
        return raw;
    }
    const defaultFile = path.resolve(path.join(__dirname, '..', 'cookies.txt'));
    if (fs.existsSync(defaultFile)) {
        return defaultFile;
    }
    return null;
}
const COOKIES_PATH = resolveCookiesPath();

function booleanEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const lower = String(raw).toLowerCase().trim();
    if (['1', 'true', 'on', 'yes'].includes(lower)) return true;
    if (['0', 'false', 'off', 'no'].includes(lower)) return false;
    throw new Error(`${name} must be a boolean (on/off, true/false, 1/0).`);
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

function nonNegativeIntegerEnv(name, fallback, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
        throw new Error(`${name} must be an integer between 0 and ${max}.`);
    }
    return value;
}

function scoreEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) {
        throw new Error(`${name} must be a number between 0.5 and 2 (above 1 disables it).`);
    }
    return value;
}

const PORT = positiveIntegerEnv('PORT', 5224, 65535);
const RATE_LIMIT_WINDOW_MS = positiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000, 24 * 60 * 60 * 1000);
const API_RATE_LIMIT_MAX = positiveIntegerEnv('RATE_LIMIT_MAX', 120, 10000);
const DOWNLOAD_CONCURRENCY = positiveIntegerEnv('DOWNLOAD_CONCURRENCY', 4, 8);
const METADATA_CONCURRENCY = positiveIntegerEnv('METADATA_CONCURRENCY', DOWNLOAD_CONCURRENCY, 8);
const SPOTIFY_SEARCH_CONCURRENCY = positiveIntegerEnv('SPOTIFY_SEARCH_CONCURRENCY', 6, 16);
// stop after the first yt-dlp search when its best match scores at least this (set above 1 to always run both)
const SPOTIFY_SEARCH_EARLY_EXIT_SCORE = scoreEnv('SPOTIFY_SEARCH_EARLY_EXIT_SCORE', 0.9);
// start matching Spotify tracks in the background as soon as the link is inspected (0 disables)
const SPOTIFY_PREWARM_MAX_TRACKS = nonNegativeIntegerEnv('SPOTIFY_PREWARM_MAX_TRACKS', 6, 30);
const SPOTIFY_PREWARM_CONCURRENCY = positiveIntegerEnv('SPOTIFY_PREWARM_CONCURRENCY', 2, 4);
const SPOTIFY_MATCH_CACHE_FILE = process.env.SPOTIFY_MATCH_CACHE_FILE || path.resolve(path.join(__dirname, '..', 'cache', 'spotify_matches.json'));
const SPOTIFY_MATCH_CACHE_MAX_SIZE = positiveIntegerEnv('SPOTIFY_MATCH_CACHE_MAX_SIZE', 10000, 100000);
const SPOTIFY_MATCH_CACHE_TTL_DAYS = positiveIntegerEnv('SPOTIFY_MATCH_CACHE_TTL_DAYS', 30, 365);
const SPOTIFY_MATCH_CACHE_TTL_MS = SPOTIFY_MATCH_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const MAX_QUEUED_DOWNLOADS = positiveIntegerEnv('MAX_QUEUED_DOWNLOADS', 8, 100);
const MAX_PLAYLIST_TRACKS = positiveIntegerEnv('MAX_PLAYLIST_TRACKS', 30, 100);
const MAX_PLAYLIST_OUTPUT_BYTES = positiveIntegerEnv('MAX_PLAYLIST_OUTPUT_BYTES', 2 * 1024 * 1024, 16 * 1024 * 1024);
const MAX_COVER_BYTES = positiveIntegerEnv('MAX_COVER_BYTES', 5 * 1024 * 1024, 20 * 1024 * 1024);
const MAX_DOWNLOAD_BYTES = positiveIntegerEnv('MAX_DOWNLOAD_BYTES', 100 * 1024 * 1024, 512 * 1024 * 1024);
const MAX_AUDIO_OUTPUT_BYTES = positiveIntegerEnv('MAX_AUDIO_OUTPUT_BYTES', 150 * 1024 * 1024, 512 * 1024 * 1024);
const MAX_ZIP_TRACK_BYTES = positiveIntegerEnv('MAX_ZIP_TRACK_BYTES', 40 * 1024 * 1024, 128 * 1024 * 1024);
const zipTrackLimit = format => (format === 'flac' || format === 'wav') ? Math.max(MAX_ZIP_TRACK_BYTES, MAX_AUDIO_OUTPUT_BYTES) : MAX_ZIP_TRACK_BYTES;
const ENCODE_CONCURRENCY = positiveIntegerEnv('ENCODE_CONCURRENCY', Math.max(1, Math.min(2, os.cpus().length)), 8);
const YTDLP_CONCURRENT_FRAGMENTS = positiveIntegerEnv('YTDLP_CONCURRENT_FRAGMENTS', 4, 16);
const WORK_DIR = process.env.WORK_DIR || os.tmpdir();
if (!path.isAbsolute(WORK_DIR)) throw new Error('WORK_DIR must be an absolute path.');
fs.mkdirSync(WORK_DIR, { recursive: true });

const PUBLIC_DIR = path.resolve(path.join(__dirname, '..', 'public'));
const STATIC_CACHE_ENABLED = booleanEnv('STATIC_CACHE', process.env.NODE_ENV === 'production');
const YTDLP_USE_ARIA2C = String(process.env.YTDLP_USE_ARIA2C || '').toLowerCase() === 'true';

const TRUST_PROXY_HOPS_VALUE = process.env.TRUST_PROXY_HOPS === undefined || process.env.TRUST_PROXY_HOPS === ''
    ? 0
    : Number(process.env.TRUST_PROXY_HOPS);
if (!Number.isSafeInteger(TRUST_PROXY_HOPS_VALUE) || TRUST_PROXY_HOPS_VALUE < 0 || TRUST_PROXY_HOPS_VALUE > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5.');
}
const TRUST_PROXY_HOPS = TRUST_PROXY_HOPS_VALUE || false;

const checkAria2c = spawnSync('aria2c', ['--version']);
const aria2cAvailable = checkAria2c.status === 0;

const YTDLP_AUTHED_CLIENTS = (process.env.YTDLP_AUTHED_CLIENTS || 'web_embedded,web').trim();
const AGE_GATE_COOKIES_ENABLED = ['1', 'true', 'on', 'yes'].includes(String(process.env.AGE_GATE_COOKIES || 'off').toLowerCase().trim());
const YTDLP_AGE_COOKIES_DIR = process.env.YTDLP_AGE_COOKIES_DIR || '';
const COOKIE_BUDGET_CACHE_FILE = process.env.COOKIE_BUDGET_CACHE_FILE || path.resolve(path.join(__dirname, '..', 'cache', 'cookie_budgets.json'));
const COOKIE_GUARD_SECRET_FILE = process.env.COOKIE_GUARD_SECRET_FILE || path.resolve(path.join(path.dirname(COOKIE_BUDGET_CACHE_FILE), 'cookie_guard.secret'));
const COOKIE_GUARD_SOURCE_CACHE_MAX_MB = positiveIntegerEnv('COOKIE_GUARD_SOURCE_CACHE_MAX_MB', 128, 4096);
const COOKIE_GUARD_SOURCE_CACHE_MAX_BYTES = COOKIE_GUARD_SOURCE_CACHE_MAX_MB * 1024 * 1024;
const COOKIE_GUARD_PER_ACCOUNT_HOURLY = positiveIntegerEnv('COOKIE_GUARD_PER_ACCOUNT_HOURLY', 6, 100);
const COOKIE_GUARD_PER_ACCOUNT_DAILY = positiveIntegerEnv('COOKIE_GUARD_PER_ACCOUNT_DAILY', 30, 500);
const COOKIE_GUARD_GLOBAL_HOURLY = positiveIntegerEnv('COOKIE_GUARD_GLOBAL_HOURLY', 15, 500);

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

module.exports = {
    findExecutableInPath,
    ffmpegPath,
    ffprobePath,
    ytdlpAvailable,
    ytdlpVersion,
    resolveCookiesPath,
    COOKIES_PATH,
    positiveIntegerEnv,
    booleanEnv,
    STATIC_CACHE_ENABLED,
    PORT,
    RATE_LIMIT_WINDOW_MS,
    API_RATE_LIMIT_MAX,
    DOWNLOAD_CONCURRENCY,
    METADATA_CONCURRENCY,
    SPOTIFY_SEARCH_CONCURRENCY,
    SPOTIFY_SEARCH_EARLY_EXIT_SCORE,
    SPOTIFY_PREWARM_MAX_TRACKS,
    SPOTIFY_PREWARM_CONCURRENCY,
    SPOTIFY_MATCH_CACHE_FILE,
    SPOTIFY_MATCH_CACHE_MAX_SIZE,
    SPOTIFY_MATCH_CACHE_TTL_DAYS,
    SPOTIFY_MATCH_CACHE_TTL_MS,
    MAX_QUEUED_DOWNLOADS,
    MAX_PLAYLIST_TRACKS,
    MAX_PLAYLIST_OUTPUT_BYTES,
    MAX_COVER_BYTES,
    MAX_DOWNLOAD_BYTES,
    MAX_AUDIO_OUTPUT_BYTES,
    MAX_ZIP_TRACK_BYTES,
    zipTrackLimit,
    ENCODE_CONCURRENCY,
    YTDLP_CONCURRENT_FRAGMENTS,
    WORK_DIR,
    PUBLIC_DIR,
    YTDLP_USE_ARIA2C,
    TRUST_PROXY_HOPS,
    aria2cAvailable,
    YTDLP_AUTHED_CLIENTS,
    AGE_GATE_COOKIES_ENABLED,
    YTDLP_AGE_COOKIES_DIR,
    COOKIE_BUDGET_CACHE_FILE,
    COOKIE_GUARD_SECRET_FILE,
    COOKIE_GUARD_SOURCE_CACHE_MAX_MB,
    COOKIE_GUARD_SOURCE_CACHE_MAX_BYTES,
    COOKIE_GUARD_PER_ACCOUNT_HOURLY,
    COOKIE_GUARD_PER_ACCOUNT_DAILY,
    COOKIE_GUARD_GLOBAL_HOURLY,
    JOB_ID_PATTERN
};

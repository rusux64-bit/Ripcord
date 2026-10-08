require('dotenv').config();
process.umask(0o077);
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { spawn, spawnSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
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
ffmpeg.setFfmpegPath(ffmpegPath);

// make sure yt-dlp is installed and in the system path
const checkYtdlp = spawnSync('yt-dlp', ['--version']);
const ytdlpAvailable = checkYtdlp.status === 0;
const ytdlpVersion = ytdlpAvailable ? checkYtdlp.stdout.toString().trim() : 'NOT INSTALLED';

// simple logger with timestamps and colors
const Logger = {
    _format: (level, msg) => {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const safeMessage = String(msg).replace(/[\x00-\x1F\x7F]/g, ' ').slice(0, 2000);
        const colors = {
            INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', RESET: '\x1b[0m'
        };
        return `${colors[level] || ''}[${time}] [${level}]${colors.RESET} ${safeMessage}`;
    },
    info: (msg) => console.log(Logger._format('INFO', msg)),
    success: (msg) => console.log(Logger._format('SUCCESS', msg)),
    warn: (msg) => console.log(Logger._format('WARN', msg)),
    error: (msg) => console.error(Logger._format('ERROR', msg))
};

Logger.info('Ripcord audio engine initializing');
Logger.info(`yt-dlp version: ${ytdlpVersion}`);
Logger.info(`ffmpeg path: ${ffmpegPath}`);

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

function cleanupStaleWorkFiles() {
    const staleBefore = Date.now() - 6 * 60 * 60 * 1000;
    const prefixes = ['ripcord_', 'out_', 'track_', 'cover_', 'tagged_', 'comments_'];
    let removed = 0;
    try {
        for (const entry of fs.readdirSync(WORK_DIR, { withFileTypes: true })) {
            if (!entry.isFile() || !prefixes.some(prefix => entry.name.startsWith(prefix))) continue;
            const filePath = path.join(WORK_DIR, entry.name);
            try {
                if (fs.statSync(filePath).mtimeMs < staleBefore) {
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
    Logger.info(`Temporary file sweep removed ${removed} stale file(s) from ${WORK_DIR}`);
}

cleanupStaleWorkFiles();

// optional cookies file if youtube starts blocking downloads
const COOKIES_PATH = process.env.YTDLP_COOKIES_PATH || (fs.existsSync(path.join(__dirname, 'cookies.txt')) ? path.join(__dirname, 'cookies.txt') : null);
if (COOKIES_PATH) {
    Logger.info(`Using yt-dlp cookies from: ${COOKIES_PATH}`);
}

// simple download queue so we don't melt the cpu with too many conversions
class DownloadQueue {
    constructor(concurrency = DOWNLOAD_CONCURRENCY, maxQueued = MAX_QUEUED_DOWNLOADS) {
        this.concurrency = concurrency;
        this.maxQueued = maxQueued;
        this.running = 0;
        this.queue = [];
    }

    addTask(task, res) {
        if (this.running >= this.concurrency && this.queue.length >= this.maxQueued) return false;

        const entry = { task, res, controller: new AbortController(), started: false };
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
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const entry = this.queue.shift();
        entry.started = true;

        if (entry.controller.signal.aborted || entry.res.destroyed) {
            entry.res.removeListener('close', entry.onClose);
            this.running--;
            this.process();
            return;
        }

        Promise.resolve(entry.task(entry.controller.signal))
            .catch(err => Logger.error(`[Queue] Task failed: ${err.message}`))
            .finally(() => {
                entry.res.removeListener('close', entry.onClose);
                this.running--;
                this.process();
            });
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

// set up the express app
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);
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
        handler: (req, res) => res.status(429).json({ error: message })
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

function createJob(jobId, tracks) {
    if (!jobId) return null;
    if (downloadJobs.size >= MAX_TRACKED_JOBS) downloadJobs.delete(downloadJobs.keys().next().value);
    const job = {
        status: 'running',
        tracks: tracks.map(track => ({
            title: String(track.title || 'Unknown Track').slice(0, 200),
            artist: String(track.artist || '').slice(0, 200),
            state: 'queued',
            progress: 0
        }))
    };
    downloadJobs.set(jobId, job);
    return job;
}

function endJob(jobId, status) {
    const job = jobId && downloadJobs.get(jobId);
    if (!job) return;
    job.status = status;
    setTimeout(() => { if (downloadJobs.get(jobId) === job) downloadJobs.delete(jobId); }, 2 * 60 * 1000).unref();
}

// polled about once a second, so it gets its own budget instead of the main API limit
app.get('/api/progress/:id', createRateLimiter(Math.max(API_RATE_LIMIT_MAX * 20, 2000), 'Too many progress requests.'), rejectCrossSiteRequests, (req, res) => {
    const job = JOB_ID_PATTERN.test(req.params.id) ? downloadJobs.get(req.params.id) : null;
    if (!job) return res.status(404).json({ status: 'pending' });
    res.json(job);
});

app.use('/api', createRateLimiter(API_RATE_LIMIT_MAX, 'Too many requests. Please wait before trying again.'));

function rejectCrossSiteRequests(req, res, next) {
    if (String(req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site') {
        return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }

    const origin = req.get('origin');
    const requestHost = req.get('host');
    if (origin && requestHost) {
        try {
            const originUrl = new URL(origin);
            const hostUrl = new URL(`http://${requestHost}`);
            if (originUrl.hostname.toLowerCase() !== hostUrl.hostname.toLowerCase()) {
                return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
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
        const allowed = ['ytimg.com', 'spotifycdn.com', 'scdn.co']
            .some(domain => host === domain || host.endsWith(`.${domain}`));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed) return null;
        return parsed;
    } catch (e) {
        return null;
    }
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

async function searchYouTubeCandidates(query, maxCandidates, signal) {
    const searchTarget = `ytsearch${maxCandidates}:${query}`;
    const args = [
        '--dump-single-json', '--flat-playlist', '--skip-download', '--no-warnings',
        '--extractor-args', 'youtube:player_client=android,web'
    ];
    if (COOKIES_PATH) args.push('--cookies', COOKIES_PATH);
    args.push('--', searchTarget);

    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Request cancelled.'));
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
        ytdlp.stderr.on('data', data => Logger.warn(`Spotify match search: ${data.toString().trim()}`));
        ytdlp.on('error', error => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            reject(error);
        });
        ytdlp.on('close', code => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) return reject(new Error('Request cancelled.'));
            if (timedOut) return reject(new Error('Spotify match search timed out.'));
            if (outputBytes > 2 * 1024 * 1024) return reject(new Error('Spotify match search returned too much data.'));
            if (code !== 0 || !output.trim()) return resolve([]);
            try {
                const data = JSON.parse(output);
                resolve(Array.isArray(data.entries) ? data.entries : [data]);
            } catch {
                resolve([]);
            }
        });
    });
}

async function findSpotifyMatch(track, signal) {
    // Spotify to YouTube matching configuration:
    // Declared here for easy tuning without environment variables
    const MATCH_THRESHOLD = 0.58;       // Minimum confidence score (0.0 - 1.0) required to accept a YouTube candidate
    const MAX_SEARCH_QUERIES = 2;       // Maximum search query variations attempted per track
    const MAX_CANDIDATES_PER_QUERY = 5; // Maximum YouTube candidates fetched per search query

    const queries = generateSearchQueries(track, MAX_SEARCH_QUERIES);
    const collectedCandidates = [];
    const seenIds = new Set();
    let bestCandidate = null;

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const entries = await searchYouTubeCandidates(query, MAX_CANDIDATES_PER_QUERY, signal);
        for (const entry of entries) {
            const id = entry?.id || entry?.url;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                collectedCandidates.push(entry);
            }
        }

        const ranked = rankCandidates(track, collectedCandidates, { threshold: MATCH_THRESHOLD });
        if (ranked.length > 0) {
            bestCandidate = ranked[0];
            if (bestCandidate.confidence === 'high' && bestCandidate.score >= 0.85) {
                break;
            }
        }
    }

    if (!bestCandidate) {
        throw new Error('No search result matched the Spotify title, artist, and duration closely enough.');
    }

    Logger.info(`[Spotify match] ${sanitizeAsciiHeader(track.title)} - ${sanitizeAsciiHeader(track.artist)} -> ${sanitizeAsciiHeader(bestCandidate.matchedTitle || '')} (confidence ${(bestCandidate.score * 100).toFixed(0)}%)`);
    return `https://www.youtube.com/watch?v=${bestCandidate.videoId}`;
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

// grab the 11 character id from a youtube link
function getYouTubeVideoId(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        let id = null;
        if (host === 'youtu.be') id = parsed.pathname.slice(1);
        else if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
        else if (parsed.pathname === '/playlist') {
            const list = parsed.searchParams.get('list');
            const match = list?.match(/^RD(?:AMVM|MM)?([A-Za-z0-9_-]{11})$/i);
            if (match) id = match[1];
        }
        else id = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
        return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
    } catch (e) {
        return null;
    }
}

function isYouTubeUrl(url) {
    try {
        const parsed = new URL(url);
        return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
    } catch (e) {
        return false;
    }
}

function normalizeYouTubeUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (!YOUTUBE_HOSTS.has(host)) return url;

        const list = parsed.searchParams.get('list');
        const isRadio = (list && list.toUpperCase().startsWith('RD')) ||
            (list && list.toUpperCase().startsWith('UL')) ||
            parsed.searchParams.get('start_radio') === '1';

        if (isRadio) {
            parsed.searchParams.delete('list');
            parsed.searchParams.delete('start_radio');
            parsed.searchParams.delete('index');

            if (parsed.pathname === '/playlist' && list) {
                const match = list.match(/^RD(?:AMVM|MM)?([A-Za-z0-9_-]{11})$/i);
                if (match) {
                    parsed.pathname = '/watch';
                    parsed.searchParams.set('v', match[1]);
                }
            }
        }
        return parsed.href;
    } catch {
        return url;
    }
}

function isYouTubePlaylist(url) {
    try {
        const parsed = new URL(url);
        if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return false;

        const list = parsed.searchParams.get('list');
        if (!list && parsed.pathname !== '/playlist') return false;

        // Auto-generated YouTube Mixes / Radios (starting with RD or UL) are dynamic recommendation feeds, not downloadable static playlists.
        if (list && (list.toUpperCase().startsWith('RD') || list.toUpperCase().startsWith('UL') || parsed.searchParams.get('start_radio') === '1')) {
            return false;
        }

        return parsed.pathname === '/playlist' || Boolean(list);
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
async function getYoutubePlaylistData(url, signal) {
    return new Promise((resolve, reject) => {
        const ytdlpArgs = [
            '--flat-playlist',
            '--print', '%(playlist_title)s:::%(id)s:::%(title)s:::%(uploader)s',
            '--ignore-errors',
            '--no-abort-on-error',
            '--no-warnings',
            '--playlist-end', String(MAX_PLAYLIST_TRACKS)
        ];

        if (COOKIES_PATH) {
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
        ytdlp.stderr.on('data', (data) => Logger.warn(`yt-dlp playlist stderr: ${data.toString().trim()}`));

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                reject(new Error('Request cancelled.'));
            } else if (timedOut) {
                reject(new Error('Playlist metadata fetch timed out.'));
            } else if (outputBytes > MAX_PLAYLIST_OUTPUT_BYTES) {
                reject(new Error('Playlist metadata exceeds the allowed size.'));
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
                        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
                        url: `https://www.youtube.com/watch?v=${id}`
                    };
                }).filter(Boolean);

                if (tracks.length === 0) {
                    reject(new Error('Playlist is empty or videos are unavailable/private.'));
                } else {
                    resolve({ type: 'collection', name: playlistName, tracks });
                }
            } else {
                reject(new Error('Failed to fetch YouTube playlist tracks.'));
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            reject(err);
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
                        tracks.push({
                            title,
                            artist: trackArtists,
                            album: safeMetadataText(albumName, ''),
                            releaseYear: Number.isSafeInteger(releaseYear) ? releaseYear : null,
                            thumbnail: coverImage,
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
async function downloadToTemp(targetUrl, extension = 'webm', signal, targetFormat, onProgress) {
    const tempPath = path.join(WORK_DIR, `ripcord_${randomUUID()}.${extension}`);

    return new Promise((resolve, reject) => {
        const formatSelector = targetFormat === 'ogg'
            ? 'bestaudio[acodec=opus]/bestaudio/best'
            : targetFormat === 'm4a' ? 'bestaudio[acodec=aac]/bestaudio/best' : 'bestaudio/best';
        const ytdlpArgs = [
            '-f', formatSelector,
            '--no-playlist',
            '--no-warnings',
            '--max-filesize', `${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))}M`,
            '--concurrent-fragments', String(YTDLP_CONCURRENT_FRAGMENTS),
            '--extractor-args', 'youtube:player_client=android,web'
        ];

        if (YTDLP_USE_ARIA2C && aria2cAvailable) ytdlpArgs.push('--downloader', 'aria2c');

        if (COOKIES_PATH) {
            ytdlpArgs.push('--cookies', COOKIES_PATH);
        }

        if (onProgress) {
            ytdlpArgs.push('--newline', '--progress', '--progress-template',
                'download:RIPCORD_PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s');
        }

        ytdlpArgs.push('-o', tempPath, '--', targetUrl);

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

        ytdlp.stderr.on('data', (data) => Logger.warn(`yt-dlp: ${data.toString().trim()}`));

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
                cleanupFiles([tempPath]);
                reject(new Error('Request cancelled.'));
            } else if (timedOut) {
                cleanupFiles([tempPath]);
                reject(new Error('Audio download timed out.'));
            } else if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size <= MAX_DOWNLOAD_BYTES) {
                resolve(tempPath);
            } else {
                cleanupFiles([tempPath]);
                reject(new Error('yt-dlp was unable to extract this audio source.'));
            }
        });

        ytdlp.on('error', (err) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            cleanupFiles([tempPath]);
            reject(err);
        });
    });
}

function runFfmpeg(args, timeoutMessage, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Request cancelled.'));

        const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let timedOut = false;
        let stderr = '';
        const timeout = setTimeout(() => {
            timedOut = true;
            ff.kill('SIGKILL');
        }, 60000);
        const onAbort = () => ff.kill('SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });
        ff.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
        ff.on('error', error => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            reject(error);
        });
        ff.on('close', code => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) reject(new Error('Request cancelled.'));
            else if (timedOut) reject(new Error(timeoutMessage));
            else if (code !== 0) reject(new Error(stderr.trim().slice(-1000) || 'FFmpeg encoding failed.'));
            else resolve();
        });
    });
}

function ffmpegEncodeArgs(audioPath, outputPath, format, bitrate, coverPath, title, artist, maxBytes, copyAudio = false) {
    const args = ['-y', '-i', audioPath];
    const embedsCover = coverPath && ['mp3', 'm4a'].includes(format);
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
        args.push('-c:v', 'mjpeg');
        if (format === 'mp3') {
            args.push('-id3v2_version', '3', '-metadata:s:v', 'title=Album cover');
        }
        args.push('-disposition:v', 'attached_pic');
    }
    args.push('-fs', String(maxBytes), outputPath);
    return args;
}

function probeAudioCodec(filePath) {
    return new Promise(resolve => {
        ffmpeg.ffprobe(filePath, (error, metadata) => {
            if (error) return resolve(null);
            const audioStream = metadata?.streams?.find(stream => stream.codec_type === 'audio');
            resolve(audioStream?.codec_name || null);
        });
    });
}

// attach album cover art to flac or ogg files
function injectVorbisCoverArt(filePath, imgPath, format) {
    if (!fs.existsSync(imgPath) || !fs.existsSync(filePath)) return false;

    if (format === 'ogg') {
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

            const readResult = spawnSync('vorbiscomment', ['-l', '-R', filePath], { timeout: 15000, windowsHide: true });
            if (readResult.error || readResult.status !== 0) return false;

            let comments = readResult.stdout.toString().split('\n');
            comments = comments.filter(c => c && !c.startsWith('metadata_block_picture='));
            comments.push(`metadata_block_picture=${base64Block}`);

            const tempCommentsFile = path.join(WORK_DIR, `comments_${randomUUID()}.txt`);
            fs.writeFileSync(tempCommentsFile, comments.join('\n'));
            try {
                const writeResult = spawnSync('vorbiscomment', ['-w', '-R', '-c', tempCommentsFile, filePath], { timeout: 15000, windowsHide: true });
                return !writeResult.error && writeResult.status === 0;
            } finally {
                cleanupFiles([tempCommentsFile]);
            }
        } catch (e) {
            return false;
        }
    } else if (format === 'flac') {
        try {
            spawnSync('metaflac', ['--remove', '--block-type=PICTURE', '--except-block-type=STREAMINFO', filePath], { timeout: 15000, windowsHide: true });
            const spec = `3||Front Cover||${imgPath}`;
            const writeResult = spawnSync('metaflac', [`--import-picture-from=${spec}`, filePath], { timeout: 15000, windowsHide: true });
            return !writeResult.error && writeResult.status === 0;
        } catch (e) {
            return false;
        }
    }
    return false;
}

// transcode the audio with ffmpeg and stream it directly to the user
async function processAndStreamAudio(target, bitrate, format, thumbnailUrl, res, filename = '', artist = '', signal) {
    const tempFiles = [];

    // clean up temp files if the user closes their browser or cancels
    const onDisconnect = () => cleanupFiles(tempFiles);
    res.on('close', onDisconnect);

    try {
        Logger.info('Downloading validated audio source');
        const tempAudioPath = await downloadToTemp(target, format === 'm4a' ? 'm4a' : 'webm', signal, format);
        tempFiles.push(tempAudioPath);

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
                if (imgRes.status === 200 && String(imgRes.headers['content-type'] || '').toLowerCase().startsWith('image/jpeg')) {
                    tempImgPath = path.join(WORK_DIR, `cover_${randomUUID()}.img`);
                    fs.writeFileSync(tempImgPath, Buffer.from(imgRes.data));
                    tempFiles.push(tempImgPath);
                }
            } catch (imgErr) {
                Logger.warn(`Cover art fetch omitted: ${imgErr.message}`);
            }
        }

        const tempOutPath = path.join(WORK_DIR, `out_${randomUUID()}.${format}`);
        tempFiles.push(tempOutPath);

        const sourceCodec = await probeAudioCodec(tempAudioPath);
        const copyAudio = (format === 'ogg' && sourceCodec === 'opus') || (format === 'm4a' && sourceCodec === 'aac');
        Logger.info(copyAudio
            ? `Remuxing ${sourceCodec} audio into [${format.toUpperCase()}]`
            : `Encoding audio to [${format.toUpperCase()}] at ${bitrate} kbps`);
        const args = ffmpegEncodeArgs(tempAudioPath, tempOutPath, format, bitrate, tempImgPath, filename || 'Track', artist || 'Unknown Artist', MAX_AUDIO_OUTPUT_BYTES, copyAudio);
        await runFfmpeg(args, 'Audio encoding timed out.', signal);
        if (signal?.aborted) throw new Error('Request cancelled.');
        if (fs.statSync(tempOutPath).size >= MAX_AUDIO_OUTPUT_BYTES) throw new Error('Audio output exceeds the allowed size.');

        if (tempImgPath && fs.existsSync(tempOutPath) && (format === 'ogg' || format === 'flac')) {
            injectVorbisCoverArt(tempOutPath, tempImgPath, format);
        }

        Logger.success(`Encoding complete. Streaming ${format.toUpperCase()} to client`);
        const fileStat = fs.statSync(tempOutPath);
        if (fileStat.size > MAX_AUDIO_OUTPUT_BYTES) throw new Error('Audio output exceeds the allowed size.');
        res.setHeader('Content-Length', fileStat.size);

        const readStream = fs.createReadStream(tempOutPath);
        readStream.pipe(res);
        readStream.on('error', () => res.destroy());

        readStream.on('end', () => {
            res.removeListener('close', onDisconnect);
            cleanupFiles(tempFiles);
        });

    } catch (error) {
        Logger.error(`Audio processing error: ${error.message}`);
        res.removeListener('close', onDisconnect);
        cleanupFiles(tempFiles);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Unable to process this audio request.' });
        } else res.destroy();
    }
}

async function downloadPlaylistTrack(track, index, audioFormat, signal, report = () => { }) {
    const tempFiles = [];

    try {
        report(index, { state: 'matching', progress: 0 });
        const title = String(track.title || 'Unknown Track').slice(0, 200);
        const artist = String(track.artist || 'Unknown Artist').slice(0, 200);
        Logger.info(`[Track ${index + 1}] Downloading: ${sanitizeAsciiHeader(`${title} - ${artist}`)}`);

        let downloadTarget;
        if (track.url) {
            if (!isSafeUrl(track.url)) throw new Error('Invalid playlist track URL.');
            downloadTarget = track.url;
        } else {
            downloadTarget = await findSpotifyMatch({ ...track, title, artist }, signal);
        }

        report(index, { state: 'downloading', progress: 0 });
        const downloadPromise = downloadToTemp(downloadTarget, audioFormat === 'm4a' ? 'm4a' : 'webm', signal, audioFormat,
            fraction => report(index, { state: 'downloading', progress: fraction }));
        let tempImgPath = '';
        const safeThumbnail = parseCoverUrl(track.thumbnail);

        const coverPromise = safeThumbnail
            ? axios.get(safeThumbnail.href, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 6000,
                maxRedirects: 0,
                maxContentLength: MAX_COVER_BYTES,
                signal
            })
                .then(imgRes => {
                    if (imgRes.status === 200 && String(imgRes.headers['content-type'] || '').toLowerCase().startsWith('image/jpeg')) {
                        tempImgPath = path.join(WORK_DIR, `cover_zip_${randomUUID()}.img`);
                        fs.writeFileSync(tempImgPath, Buffer.from(imgRes.data));
                        tempFiles.push(tempImgPath);
                    }
                }).catch(() => { })
            : Promise.resolve();

        const [tempAudioPath] = await Promise.all([downloadPromise, coverPromise]);
        tempFiles.push(tempAudioPath);
        return { track, index, title, artist, tempAudioPath, tempImgPath };
    } catch (err) {
        Logger.error(`[Track ${index + 1}] FAILED: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - ${err.message}`);
        report(index, { state: 'failed', progress: 1, error: /search result/i.test(err.message) ? 'No match found' : 'Download failed' });
        cleanupFiles(tempFiles);
        return null;
    }
}

// convert one downloaded song so it can be added to the zip file
async function processPlaylistTrack(source, audioBitrate, audioFormat, signal, report = () => { }) {
    const { track, index, title, artist, tempAudioPath, tempImgPath } = source;
    const tempFiles = [tempAudioPath, tempImgPath].filter(Boolean);

    try {
        report(index, { state: 'encoding', progress: 0 });
        Logger.info(`[Track ${index + 1}] Encoding: ${sanitizeAsciiHeader(`${title} - ${artist}`)}`);
        const tempOutPath = path.join(WORK_DIR, `track_${randomUUID()}.${audioFormat}`);
        tempFiles.push(tempOutPath);

        const sourceCodec = await probeAudioCodec(tempAudioPath);
        const copyAudio = (audioFormat === 'ogg' && sourceCodec === 'opus') || (audioFormat === 'm4a' && sourceCodec === 'aac');
        Logger.info(copyAudio
            ? `[Track ${index + 1}] Remuxing ${sourceCodec} audio into [${audioFormat.toUpperCase()}]`
            : `[Track ${index + 1}] Encoding audio to [${audioFormat.toUpperCase()}] at ${audioBitrate} kbps`);
        const args = ffmpegEncodeArgs(tempAudioPath, tempOutPath, audioFormat, audioBitrate, tempImgPath, title, artist, zipTrackLimit(audioFormat), copyAudio);
        await runFfmpeg(args, 'Track encoding timed out.', signal);
        if (signal?.aborted) throw new Error('Request cancelled.');
        if (fs.statSync(tempOutPath).size >= zipTrackLimit(audioFormat)) throw new Error('Playlist track exceeds the allowed size.');

        if (tempImgPath && fs.existsSync(tempOutPath) && (audioFormat === 'ogg' || audioFormat === 'flac')) {
            injectVorbisCoverArt(tempOutPath, tempImgPath, audioFormat);
        }

        if (fs.statSync(tempOutPath).size > zipTrackLimit(audioFormat)) throw new Error('Playlist track exceeds the allowed size.');
        const safeName = sanitizeFilename(`${String(index + 1).padStart(2, '0')} - ${title} - ${artist}.${audioFormat}`);

        cleanupFiles(tempFiles.filter(file => file !== tempOutPath));
        report(index, { state: 'done', progress: 1 });
        return { name: safeName, filePath: tempOutPath };

    } catch (err) {
        Logger.error(`[Track ${index + 1}] FAILED: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - ${err.message}`);
        report(index, { state: 'failed', progress: 1, error: /size/i.test(err.message) ? 'Too large' : 'Encoding failed' });
        cleanupFiles(tempFiles);
        return null;
    }
}

// worker function that processes the actual download request
async function executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res, signal, jobId = null) {
    try {
        Logger.info(`Task started (${audioFormat.toUpperCase()})`);
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
            res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}.${audioFormat}"`);
            res.setHeader('Content-Type', mimeType);
            const info = await getYoutubeInfo(url, signal);
            await processAndStreamAudio(url, audioBitrate, audioFormat, info.thumbnail, res, info.title, info.author, signal);
            return;
        }

        // download a single spotify track
        if (spotifyLink?.type === 'track') {
            res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}.${audioFormat}"`);
            res.setHeader('Content-Type', mimeType);
            const spotifyData = await getSpotifyData(url, signal);
            const track = spotifyData.tracks[0];
            const matchUrl = await findSpotifyMatch(track, signal);
            await processAndStreamAudio(matchUrl, audioBitrate, audioFormat, track.thumbnail, res, track.title, track.artist, signal);
            return;
        }

        // download full playlists or albums as a zip
        let collectionData = null;
        if (isYouTubePlaylist(url)) {
            Logger.info('Fetching YouTube playlist items');
            collectionData = await getYoutubePlaylistData(url, signal);
        } else if (spotifyLink && spotifyLink.type !== 'track') {
            Logger.info('Fetching Spotify collection items');
            collectionData = await getSpotifyData(url, signal);
        }

        if (collectionData && collectionData.tracks && collectionData.tracks.length > 0) {
            const zipName = sanitizeAsciiHeader(`${collectionData.name}.zip`);
            res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
            res.setHeader('Content-Type', 'application/zip');

            const { ZipArchive } = await import('archiver');
            const archive = new ZipArchive({ zlib: { level: 6 } });
            archive.pipe(res);

            archive.on('warning', (err) => Logger.warn(`ZIP archive warning: ${err.message}`));
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
                Logger.error(`ZIP archive error: ${err.message}`);
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
            const job = createJob(jobId, tracks);
            const report = (index, patch) => {
                if (job?.tracks[index]) Object.assign(job.tracks[index], patch);
            };

            try {
                const handoffQueue = new AsyncBoundedQueue(4);
                const encodedResults = new Array(tracks.length);
                let nextTrack = 0;
                const downloadWorker = async () => {
                    while (!signal.aborted) {
                        const index = nextTrack++;
                        if (index >= tracks.length) return;
                        const downloaded = await downloadPlaylistTrack(tracks[index], index, audioFormat, signal, report);
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
                        const result = await processPlaylistTrack(downloaded, audioBitrate, audioFormat, signal, report);
                        if (signal.aborted && result?.filePath) cleanupFiles([result.filePath]);
                        else if (result) encodedResults[downloaded.index] = result;
                    }
                };

                const encodeWorkers = Array.from({ length: ENCODE_CONCURRENCY }, () => encodeWorker());
                const downloadWorkers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, () => downloadWorker());
                await Promise.all(downloadWorkers);
                handoffQueue.close();
                await Promise.all(encodeWorkers);

                for (const result of encodedResults) {
                    if (!result?.filePath) continue;
                    if (signal.aborted) {
                        cleanupFiles([result.filePath]);
                        continue;
                    }
                    trackFilePaths.add(result.filePath);
                    archiveFilePaths.set(result.name, result.filePath);
                    archive.file(result.filePath, { name: result.name });
                    addedTracks++;
                }

                if (signal.aborted) throw new Error('Request cancelled.');
                if (addedTracks === 0) throw new Error('No tracks could be processed.');
                await archive.finalize();
                endJob(jobId, 'finished');
                Logger.success(`Archive completed: ${zipName}`);
            } finally {
                signal.removeEventListener('abort', onAbort);
                cleanupTrackFiles();
                if (job?.status === 'running') endJob(jobId, signal.aborted ? 'cancelled' : 'failed');
            }
            return;
        }

        if (!res.headersSent) {
            res.status(400).json({ error: 'Unsupported or unreadable URL format.' });
        }

    } catch (error) {
        Logger.error(`Queue execution error: ${error.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Unable to complete this download request.' });
        } else if (!res.destroyed) res.destroy();
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
            return res.status(400).json({ error: 'Please enter a valid Spotify or YouTube URL.' });
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
            return res.status(400).json({ error: 'YouTube Mix/Radio playlists are dynamic and cannot be downloaded as collections. Please link a specific track or curated playlist.' });
        }

        if (isYouTubePlaylist(url)) {
            metadataAcquisition = metadataSemaphore.tryAcquire();
            if (!metadataAcquisition) {
                return res.status(503).json({ error: 'The metadata queue is full. Please try again shortly.' });
            }
            let release;
            try {
                release = await metadataAcquisition;
                if (controller.signal.aborted) return;
                const ytData = await getYoutubePlaylistData(url, controller.signal);
                return res.json({
                    type: 'collection',
                    title: ytData.name,
                    trackCount: ytData.tracks.length,
                    tracks: ytData.tracks.map(t => ({ title: t.title, artist: t.artist || '' })),
                    thumbnail: ytData.tracks[0]?.thumbnail || ''
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
                thumbnail: info.thumbnail
            });
        } else if (spotifyLinkDetails(url)?.type === 'track') {
            const spotifyData = await getSpotifyData(url, controller.signal);
            const track = spotifyData.tracks[0];
            return res.json({
                type: 'track',
                title: track.title,
                artist: track.artist,
                thumbnail: track.thumbnail
            });
        } else if (spotifyLinkDetails(url)) {
            const spotifyData = await getSpotifyData(url, controller.signal);
            return res.json({
                type: 'collection',
                title: spotifyData.name,
                trackCount: spotifyData.tracks.length,
                tracks: spotifyData.tracks.map(t => ({ title: t.title, artist: t.artist === 'Unknown Artist' ? '' : t.artist })),
                thumbnail: spotifyData.thumbnail
            });
        } else {
            return res.status(400).json({ error: 'Unsupported URL. Please provide a Spotify or YouTube link.' });
        }
    } catch (error) {
        Logger.error(`Fetch info error: ${error.message}`);
        if (!res.destroyed && !res.headersSent) res.status(502).json({ error: 'Unable to inspect this media link.' });
    }
});

// api endpoint to start downloading the audio
app.get('/api/download', rejectCrossSiteRequests, (req, res) => {
    const rawUrl = req.query.url;
    const bitrate = req.query.bitrate;
    const filename = req.query.filename;
    const format = req.query.format;
        const audioBitrate = bitrate === undefined
            ? 128
            : typeof bitrate === 'string' && /^\d{2,3}$/.test(bitrate) ? Number(bitrate) : NaN;
    const audioFormat = format === undefined ? 'mp3' : format;

    if (!isSafeUrl(rawUrl)) {
        return res.status(400).json({ error: 'Invalid URL provided.' });
    }
    if (typeof audioFormat !== 'string' || !['mp3', 'm4a', 'flac', 'wav', 'ogg'].includes(audioFormat)) {
        return res.status(400).json({ error: 'Unsupported audio format.' });
    }
    if (typeof audioBitrate !== 'number' || ![128, 192, 320].includes(audioBitrate)) {
        return res.status(400).json({ error: 'Unsupported audio bitrate.' });
    }
    if (filename !== undefined && (typeof filename !== 'string' || filename.length > 120)) {
        return res.status(400).json({ error: 'Filename is invalid or too long.' });
    }

    const parsedUrl = new URL(rawUrl);
    parsedUrl.hash = '';
    const url = normalizeYouTubeUrl(parsedUrl.href);
    const safeFilename = sanitizeFilename(filename);

    const jobId = typeof req.query.job === 'string' && JOB_ID_PATTERN.test(req.query.job) ? req.query.job : null;

    const accepted = downloadQueue.addTask(
        signal => executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res, signal, jobId),
        res
    );
    if (!accepted) {
        return res.status(503).json({ error: 'The download queue is full. Please try again shortly.' });
    }
});

// image proxy so the frontend can read album cover pixels without cors errors
app.get('/api/cover', rejectCrossSiteRequests, async (req, res) => {
    const target = parseCoverUrl(req.query.url);
    if (!target) {
        return res.status(400).json({ error: 'Image host not allowed.' });
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
            return res.status(502).json({ error: 'Not an image.' });
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
            else res.status(502).json({ error: 'Could not load image.' });
        };
        upstream.data.on('error', streamError);
        sizeLimit.on('error', streamError);
        res.set('Content-Type', type.split(';', 1)[0]);
        res.set('Cache-Control', 'public, max-age=86400');
        upstream.data.pipe(sizeLimit).pipe(res);
    } catch {
        if (!res.destroyed && !res.headersSent) res.status(502).json({ error: 'Could not load image.' });
    }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

// send index.html for any other GET route
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
    Logger.error(`Unhandled request error: ${err.message}`);
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'Internal server error.' });
});

if (require.main === module) {
    const PORT = positiveIntegerEnv('PORT', 5224, 65535);
    const server = app.listen(PORT, '0.0.0.0', () => {
        Logger.success(`Ripcord server live at http://localhost:${PORT}`);
        Logger.info('Ready for requests under domain');
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
}

module.exports = { app, isSafeUrl, normalizeYouTubeUrl, isYouTubePlaylist, MetadataSemaphore };

// frontend logic for ripcord
// handles fetching track metadata, showing screens, and downloading audio

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const root = document.documentElement;
const body = document.body;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// client logger: console-only in development, no-op in production
const isDev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.protocol === 'file:';
function logClientEvent(type, msg, detail = null) {
    if (isDev) {
        console.log(`[ripcord:${type}] ${msg}`, detail || '');
    }
}

window.addEventListener('error', (event) => {
    logClientEvent('error', event.message || 'Window error', {
        filename: event.filename ? event.filename.split('/').pop() : '',
        lineno: event.lineno,
        colno: event.colno
    });
});

window.addEventListener('unhandledrejection', (event) => {
    logClientEvent('error', 'Unhandled promise rejection', {
        reason: event.reason instanceof Error ? event.reason.message : String(event.reason)
    });
});

const el = {
    url: $('#url'),
    search: $('#search'),
    help: $('#url-help'),
    form: $('#fetch-form'),
    fetchBtn: $('#fetch-btn'),
    fetchIcon: $('#fetch-icon'),
    fetchLabel: $('#fetch-label'),
    pasteBtn: $('#paste-btn'),
    pasteIcon: $('#paste-icon'),
    recent: $('#recent'),
    recentList: $('#recent-list'),
    cover: $('#cover'),
    coverImg: $('#cover-img'),
    badge: $('#media-badge'),
    badgeText: $('#media-badge-text'),
    mediaTitle: $('#media-title'),
    mediaArtist: $('#media-artist'),
    formatHint: $('#format-hint'),
    qualityGroup: $('#quality-group'),
    bitrate: $('#bitrate'),
    bitrateOut: $('#bitrate-out'),
    clean: $('#clean'),
    nameGroup: $('#name-group'),
    filename: $('#filename'),
    ext: $('#ext'),
    spotifyNote: $('#spotify-note'),
    backBtn: $('#back-btn'),
    downloadBtn: $('#download-btn'),
    downloadLabel: $('#download-label'),
    workingTitle: $('#working-title'),
    wavy: $('#wavy'),
    metaLeft: $('#meta-left'),
    metaRight: $('#meta-right'),
    workingHint: $('#working-hint'),
    tracklistWrap: $('#tracklist-wrap'),
    tracklist: $('#tracklist'),
    cancelBtn: $('#cancel-btn'),
    doneTitle: $('#done-title'),
    doneSub: $('#done-sub'),
    doneBurst: $('#done-burst'),
    againBtn: $('#again-btn'),
    saveBtn: $('#save-btn'),
    snackbar: $('#snackbar'),
    snackbarText: $('#snackbar-text'),
    snackbarClose: $('#snackbar-close'),
    themeBtn: $('#theme-btn'),
    themeIcon: $('#theme-icon'),
    aboutBtn: $('#about-btn'),
    aboutClose: $('#about-close'),
    about: $('#about'),
    greeting: $('#greeting'),
    inputError: $('#input-error'),
    inputErrorMsg: $('#input-error-msg'),
    inputErrorRef: $('#input-error-ref'),
    inputErrorActions: $('#input-error-actions'),
    optionsError: $('#options-error'),
    optionsErrorMsg: $('#options-error-msg'),
    optionsErrorRef: $('#options-error-ref'),
    optionsErrorActions: $('#options-error-actions'),
    doneSkipped: $('#done-skipped'),
    doneSkippedToggle: $('#done-skipped-toggle'),
    doneSkippedToggleText: $('#done-skipped-toggle-text'),
    doneSkippedPanel: $('#done-skipped-panel'),
    doneSkippedList: $('#done-skipped-list'),
    screenOptions: $('#screen-options'),
    playlistCallout: $('#playlist-callout'),
    playlistCalloutText: $('#playlist-callout-text'),
    playlistCalloutCap: $('#playlist-callout-cap'),
    playlistToggleBtn: $('#playlist-toggle-btn')
};

const state = {
    stage: 'input',
    mode: 'track',
    playlistContext: null,
    info: null,
    url: '',
    xhr: null,
    blob: null,
    blobName: '',
    timer: 0,
    startedAt: 0,
    jobId: '',
    poll: 0,
    rows: [],
    activeRow: -1,
    lastJob: null,
    countdownTimer: null,
    currentError: null
};

const BITRATES = [128, 192, 320];
const LOSSLESS = new Set(['flac', 'wav']);
const FORMAT_HINTS = {
    mp3: 'Plays everywhere. A good default.',
    m4a: 'Small and clean, lovely on Apple devices.',
    flac: 'A lossless container. The source audio is still lossy, so expect the same sound in a bigger file.',
    wav: 'Uncompressed and big. Same note as FLAC about the source.',
    ogg: 'Open format with good quality at small sizes.'
};

// small helper functions

const store = {
    get(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked */ }
    }
};

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
}

function formatMB(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function safeName(text) {
    return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim();
}

function resolveDownloadName(dispositionHeader, info, isCollection, format = 'mp3') {
    const cleanFmt = String(format || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
    const expectedExt = isCollection ? 'zip' : cleanFmt;
    const extSuffix = `.${expectedExt}`;

    const ensureExtension = name => {
        if (!name) return '';
        if (name.toLowerCase().endsWith(extSuffix.toLowerCase())) {
            return name.slice(0, -extSuffix.length) + extSuffix;
        }
        return `${name}${extSuffix}`;
    };

    // 1. Content-Disposition: prefer RFC 5987 filename*=UTF-8''..., fall back to filename="..."
    if (dispositionHeader && typeof dispositionHeader === 'string') {
        let candidate = '';

        // Match RFC 5987: filename*=UTF-8''<encoded> or filename*=charset'lang'<encoded>
        const rfcMatch = dispositionHeader.match(/filename\*\s*=\s*(?:[A-Za-z0-9_-]+)'[^']*'([^;]+)/i);
        if (rfcMatch && rfcMatch[1]) {
            try {
                const rawVal = rfcMatch[1].trim().replace(/^["']|["']$/g, '');
                const decoded = decodeURIComponent(rawVal);
                if (decoded) candidate = decoded;
            } catch { /* ignore and fall through */ }
        }

        // Match standard filename="..." or filename=token
        if (!candidate) {
            const stdMatch = dispositionHeader.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
            if (stdMatch) {
                candidate = (stdMatch[1] || stdMatch[2] || '').trim();
            }
        }

        if (candidate) {
            candidate = candidate.replace(/^.*[\\/]/, '');
            const sanitized = safeName(candidate);
            if (sanitized && sanitized !== extSuffix && sanitized !== `.${expectedExt}`) {
                return ensureExtension(sanitized);
            }
        }
    }

    // 2. Collection or track title from state.info (sanitized)
    if (info) {
        const rawTitle = info.title || info.name || '';
        const sanitizedTitle = safeName(rawTitle);
        if (sanitizedTitle) {
            return ensureExtension(sanitizedTitle);
        }
    }

    // 3. Generic fallback
    if (isCollection) {
        const dateStr = new Date().toISOString().slice(0, 10);
        return `ripcord-playlist-${dateStr}.zip`;
    }
    return `ripcord.${cleanFmt}`;
}

// Multilingual title cleaner patterns.
// Adding a language is a single one-line entry in LANG_PATTERNS with an array of junk phrases/tokens.
// Matching lowers, NFKD-normalizes, strips combining marks, and folds ё->е for the test only.
// Word-based languages use Unicode lookarounds (?<![\p{L}\p{N}]) ... (?![\p{L}\p{N}]), while CJK terms match anywhere.
// Compiled once at startup with zero per-keystroke RegExp creation and no catastrophic backtracking.
function normForTest(s) {
    return s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/ё/g, 'е')
        .replace(/['’ʼ]/g, "'");
}

const LANG_PATTERNS = {
    en: ['official music video', 'official video', 'music video', 'official audio', 'official visualizer', 'lyric video', 'lyrics video', 'lyrics', 'lyric', 'visualizer', 'audio', 'remastered', 'remaster', 'explicit', 'clean version', 'hq', 'hd', '4k', '1080p', '720p'],
    ro: ['videoclip oficial', 'clip oficial', 'audio oficial', 'versuri oficiale', 'versuri', 'videoclip'],
    fr: ['clip officiel', 'video officielle', 'audio officiel', 'paroles', 'clip video', 'version acoustique', 'clip', 'officiel', 'officielle'],
    ru: ['официальное видео', 'официальный клип', 'официальное аудио', 'официальный звук', 'текст песни', 'слова песни', 'премьера клипа', 'премьера трека', 'премьера', 'клип', 'музыкальное видео'],
    pl: ['oficjalny teledysk', 'oficjalne video', 'oficjalne audio', 'tekst piosenki', 'z tekstem', 'teledysk', 'tekst', 'oficjalny', 'oficjalne'],
    de: ['offizielles musikvideo', 'offizielles video', 'offizielles audio', 'songtext', 'mit text', 'musikvideo', 'offiziell', 'offizielles'],
    es: ['videoclip oficial', 'video oficial', 'audio oficial', 'video con letra', 'letra', 'videoclip', 'oficial'],
    it: ['videoclip ufficiale', 'video ufficiale', 'audio ufficiale', 'testo', 'videoclip', 'ufficiale'],
    pt: ['videoclipe oficial', 'video oficial', 'audio oficial', 'com letra', 'letra', 'videoclipe'],
    nl: ['officiele video', 'officiele audio', 'songtekst', 'met tekst', 'videoclip', 'officieel', 'officiele'],
    tr: ['resmi muzik video', 'resmi video', 'resmi ses', 'resmi klip', 'sarki sozleri', 'sozleri', 'sozler', 'klip', 'resmi'],
    uk: ['офіційне відео', 'офіційний кліп', 'офіційне аудіо', 'текст пісні', "прем'єра кліпу", 'премьера клипу', 'кліп', 'офіційне', 'офіційний'],
    cs: ['oficialni videoklip', 'oficialni video', 'oficialni audio', 'text pisne', 's textem', 'videoklip', 'oficialni'],
    hu: ['hivatalos videoklip', 'hivatalos video', 'hivatalos audio', 'dalszoveg', 'szoveggel', 'hivatalos', 'klip'],
    cjk: ['公式mv', '公式ビデオ', '公式', '歌詞付き', '歌詞', 'ミュージックビデオ', '공식 뮤직비디오', '공식 mv', '공식', '뮤직비디오', '가사', '官方mv', '官方音樂錄影帶', '官方音乐视频', '官方', '歌词', '动态歌词']
};

const rawPhrases = Object.values(LANG_PATTERNS).flat();
const cjkPhrases = [];
const nonCjkPhrases = [];
const isCjk = str => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/u.test(str);

for (const phrase of rawPhrases) {
    const norm = normForTest(phrase);
    if (isCjk(norm)) cjkPhrases.push(norm);
    else nonCjkPhrases.push(norm);
}

cjkPhrases.sort((a, b) => b.length - a.length);
nonCjkPhrases.sort((a, b) => b.length - a.length);

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cjkPattern = cjkPhrases.map(escapeRegExp).join('|');
const nonCjkPattern = `(?<![\\p{L}\\p{N}])(?:${nonCjkPhrases.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`;

const JUNK_TEST_REGEX = new RegExp(`${nonCjkPattern}|${cjkPattern}`, 'u');
const JUNK_STRIP_REGEX = new RegExp(`${nonCjkPattern}|${cjkPattern}`, 'gu');
const BRACKET_PAIR_REGEX = /\s*(\([^\)]*\)|\[[^\]]*\]|\{[^\}]*\}|【[^】]*】|（[^）]*）|［[^］]*］|｛[^｝]*｝|「[^」]*」|『[^』]*』|《[^》]*》|〈[^〉]*〉)/gu;
const TRAILING_SEP_REGEX = /(?:[\s\-_—–−|｜/]+|\s*\/\/\s*)([^|｜/—–−-]+)$/u;

function isJunkBracket(segment) {
    const inner = segment.slice(1, -1).trim();
    if (!inner) return false;
    return JUNK_TEST_REGEX.test(normForTest(inner));
}

function stripTrailingJunk(str) {
    let current = str;
    for (let i = 0; i < 3; i++) {
        const match = current.match(TRAILING_SEP_REGEX);
        if (!match) break;
        const tail = match[1].trim();
        if (!tail) break;
        const normTail = normForTest(tail);
        if (!JUNK_TEST_REGEX.test(normTail)) break;
        const stripped = normTail.replace(JUNK_STRIP_REGEX, '');
        if (/\p{L}/u.test(stripped)) break;
        current = current.slice(0, match.index).trim();
    }
    return current;
}

function tidyTitle(title) {
    if (!title || typeof title !== 'string') return title || '';
    let current = title;
    current = current.replace(BRACKET_PAIR_REGEX, match => (isJunkBracket(match) ? '' : match));
    current = stripTrailingJunk(current);
    const cleaned = current.replace(/\s{2,}/g, ' ').trim();
    return cleaned || title;
}

function extractSingleVideoId(parsed) {
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let id = null;
    if (host === 'youtu.be') id = parsed.pathname.slice(1);
    else if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
    else id = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] || null;
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

function isRealYouTubePlaylistId(list) {
    if (!list || typeof list !== 'string') return false;
    const trimmed = list.trim();
    const upper = trimmed.toUpperCase();
    if (upper.startsWith('RD') || upper.startsWith('UL')) return false;
    // Real playlists on YouTube: PL (curated), OLAK5uy_ (YT Music album), UU (channel uploads), FL (favorites), LP
    return /^(?:PL|OLAK5uy_|UU|FL|LP)[A-Za-z0-9_-]{8,}$/i.test(trimmed);
}

function detectYouTubePlaylistContext(raw) {
    let value = (raw || '').trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }

    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const isYouTube = ['youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be']
        .some(h => host === h || host.endsWith('.' + h));
    if (!isYouTube) {
        return null;
    }

    const videoId = extractSingleVideoId(parsed);
    if (!videoId) {
        return null;
    }

    const list = parsed.searchParams.get('list');
    const startRadio = parsed.searchParams.get('start_radio') === '1';

    if (!list || startRadio || !isRealYouTubePlaylistId(list)) {
        return null;
    }

    const playlistHost = parsed.hostname === 'youtu.be' ? 'www.youtube.com' : parsed.hostname;
    return {
        playlistId: list,
        singleTrackUrl: parsed.hostname === 'youtu.be'
            ? `https://youtu.be/${videoId}`
            : `https://${parsed.hostname}/watch?v=${videoId}`,
        playlistUrl: `https://${playlistHost}/playlist?list=${list}`,
        host: parsed.hostname
    };
}

function normaliseUrl(raw) {
    let value = (raw || '').trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    const host = parsed.hostname.replace(/^www\./, '');
    const ok = ['youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be', 'open.spotify.com', 'spotify.com']
        .some(h => host === h || host.endsWith('.' + h));
    if (!ok) return null;

    if (['youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be'].some(h => host === h || host.endsWith('.' + h))) {
        parsed.hash = '';
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
    }

    return parsed.href;
}

function coverSrc(url) {
    return url ? `/api/cover?url=${encodeURIComponent(url)}` : '';
}

// ripple effect when clicking buttons

document.addEventListener('pointerdown', event => {
    const target = event.target.closest('.btn, .icon-btn, .list-item');
    if (!target || target.disabled) return;
    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.left = `${event.clientX - rect.left - size / 2}px`;
    dot.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.append(dot);
    dot.addEventListener('animationend', () => dot.remove(), { once: true });
});

// slightly move the background blobs when moving the mouse

const backdropEl = document.querySelector('.backdrop');
let parallaxQueued = false;
addEventListener('pointermove', event => {
    if (parallaxQueued || reduceMotion.matches || !backdropEl) return;
    parallaxQueued = true;
    requestAnimationFrame(() => {
        parallaxQueued = false;
        backdropEl.style.setProperty('--px', ((event.clientX / innerWidth) - 0.5).toFixed(3));
        backdropEl.style.setProperty('--py', ((event.clientY / innerHeight) - 0.5).toFixed(3));
    });
}, { passive: true });

// pause animations when tab is hidden to save battery / CPU
document.addEventListener('visibilitychange', () => {
    root.classList.toggle('tab-hidden', document.hidden);
});

// extract theme colors from the album cover art

const TOKENS = [
    'primary', 'on-primary', 'primary-container', 'on-primary-container',
    'secondary', 'on-secondary', 'secondary-container', 'on-secondary-container',
    'tertiary', 'on-tertiary', 'tertiary-container', 'on-tertiary-container',
    'error', 'on-error', 'error-container', 'on-error-container',
    'surface', 'on-surface', 'on-surface-variant',
    'surface-dim', 'surface-bright',
    'surface-container-lowest', 'surface-container-low',
    'surface-container', 'surface-container-high',
    'surface-container-highest',
    'outline', 'outline-variant',
    'inverse-surface', 'inverse-on-surface', 'inverse-primary'
];

let currentSeed = null;
let themeSwitchTimer = 0;

function finishThemeSwitch(event) {
    if (event && (event.target !== document.body || event.propertyName !== 'background-color')) return;
    clearTimeout(themeSwitchTimer);
    root.classList.remove('theme-switching');
}

document.body.addEventListener('transitionend', finishThemeSwitch);

function transitionTheme(updateFn) {
    if (reduceMotion.matches) {
        finishThemeSwitch();
        updateFn();
        return;
    }
    root.classList.add('theme-switching');
    void root.offsetWidth;
    updateFn();
    clearTimeout(themeSwitchTimer);
    themeSwitchTimer = setTimeout(finishThemeSwitch, 1050);
}

function initColourEngine() {
    applyScheme();
}

function isDarkNow() {
    return root.dataset.theme === 'dark';
}

function applyScheme() {
    // remove custom colors if we are back to the default theme
    if (!currentSeed) {
        for (const name of TOKENS) root.style.removeProperty(`--md-sys-color-${name}`);
    } else {
        const dark = isDarkNow();
        const h = currentSeed.h;
        const th = (h + 60) % 360;

        const colors = dark ? {
            'primary': `hsl(${h}, 80%, 75%)`,
            'on-primary': `hsl(${h}, 80%, 15%)`,
            'primary-container': `hsl(${h}, 70%, 25%)`,
            'on-primary-container': `hsl(${h}, 85%, 88%)`,
            'secondary': `hsl(${h}, 30%, 75%)`,
            'on-secondary': `hsl(${h}, 30%, 18%)`,
            'secondary-container': `hsl(${h}, 30%, 28%)`,
            'on-secondary-container': `hsl(${h}, 35%, 88%)`,
            'tertiary': `hsl(${th}, 45%, 72%)`,
            'on-tertiary': `hsl(${th}, 50%, 16%)`,
            'tertiary-container': `hsl(${th}, 45%, 26%)`,
            'on-tertiary-container': `hsl(${th}, 50%, 88%)`,
            'error': '#ffb4ab',
            'on-error': '#690005',
            'error-container': '#93000a',
            'on-error-container': '#ffdad6',
            'surface': `hsl(${h}, 18%, 8%)`,
            'on-surface': `hsl(${h}, 18%, 90%)`,
            'on-surface-variant': `hsl(${h}, 14%, 74%)`,
            'surface-dim': `hsl(${h}, 18%, 6%)`,
            'surface-bright': `hsl(${h}, 18%, 22%)`,
            'surface-container-lowest': `hsl(${h}, 20%, 5%)`,
            'surface-container-low': `hsl(${h}, 18%, 10%)`,
            'surface-container': `hsl(${h}, 18%, 13%)`,
            'surface-container-high': `hsl(${h}, 18%, 17%)`,
            'surface-container-highest': `hsl(${h}, 18%, 22%)`,
            'outline': `hsl(${h}, 12%, 58%)`,
            'outline-variant': `hsl(${h}, 14%, 28%)`,
            'inverse-surface': `hsl(${h}, 20%, 90%)`,
            'inverse-on-surface': `hsl(${h}, 18%, 15%)`,
            'inverse-primary': `hsl(${h}, 75%, 35%)`
        } : {
            'primary': `hsl(${h}, 65%, 34%)`,
            'on-primary': '#ffffff',
            'primary-container': `hsl(${h}, 85%, 88%)`,
            'on-primary-container': `hsl(${h}, 80%, 18%)`,
            'secondary': `hsl(${h}, 25%, 36%)`,
            'on-secondary': '#ffffff',
            'secondary-container': `hsl(${h}, 35%, 88%)`,
            'on-secondary-container': `hsl(${h}, 35%, 18%)`,
            'tertiary': `hsl(${th}, 40%, 34%)`,
            'on-tertiary': '#ffffff',
            'tertiary-container': `hsl(${th}, 45%, 86%)`,
            'on-tertiary-container': `hsl(${th}, 50%, 16%)`,
            'error': '#ba1a1a',
            'on-error': '#ffffff',
            'error-container': '#ffdad6',
            'on-error-container': '#93000a',
            'surface': `hsl(${h}, 25%, 98%)`,
            'on-surface': `hsl(${h}, 20%, 12%)`,
            'on-surface-variant': `hsl(${h}, 15%, 30%)`,
            'surface-dim': `hsl(${h}, 18%, 86%)`,
            'surface-bright': `hsl(${h}, 25%, 98%)`,
            'surface-container-lowest': '#ffffff',
            'surface-container-low': `hsl(${h}, 25%, 95%)`,
            'surface-container': `hsl(${h}, 25%, 92%)`,
            'surface-container-high': `hsl(${h}, 25%, 89%)`,
            'surface-container-highest': `hsl(${h}, 25%, 85%)`,
            'outline': `hsl(${h}, 12%, 46%)`,
            'outline-variant': `hsl(${h}, 18%, 80%)`,
            'inverse-surface': `hsl(${h}, 18%, 20%)`,
            'inverse-on-surface': `hsl(${h}, 25%, 94%)`,
            'inverse-primary': `hsl(${h}, 80%, 75%)`
        };

        for (const [key, val] of Object.entries(colors)) {
            root.style.setProperty(`--md-sys-color-${key}`, val);
        }
    }
    syncThemeColorMeta();
}

function syncThemeColorMeta() {
    const surface = root.style.getPropertyValue('--md-sys-color-surface').trim() || (isDarkNow() ? '#1a120c' : '#fff8f4');
    $$('meta[name="theme-color"]').forEach(meta => {
        meta.removeAttribute('media');
        meta.content = surface;
    });
}

function extractDominantColor(img) {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        const size = 32;
        canvas.width = size;
        canvas.height = size;
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let bestScore = -1;
        let bestHue = null;

        for (let i = 0; i < data.length; i += 16) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 128) continue;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 510;
            if (l < 0.12 || l > 0.90) continue;
            const d = max - min;
            const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) / 255;
            if (s < 0.15) continue;

            let h = 0;
            if (d !== 0) {
                if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
                else if (max === g) h = ((b - r) / d + 2) * 60;
                else h = ((r - g) / d + 4) * 60;
            }
            const score = s * 1.6 + (1 - Math.abs(l - 0.5));
            if (score > bestScore) {
                bestScore = score;
                bestHue = Math.round(h);
            }
        }
        return bestHue !== null ? { h: bestHue } : null;
    } catch {
        return null;
    }
}

async function seedFromCover() {
    try {
        if (!el.coverImg.complete || !el.coverImg.naturalWidth) await el.coverImg.decode();
        const nextSeed = extractDominantColor(el.coverImg);
        transitionTheme(() => {
            currentSeed = nextSeed;
            applyScheme();
        });
    } catch {
        resetSeed();
    }
}

function resetSeed() {
    if (!currentSeed) return;
    transitionTheme(() => {
        currentSeed = null;
        applyScheme();
    });
}

function renderThemeButton() {
    const isDark = isDarkNow();
    el.themeIcon.textContent = isDark ? 'dark_mode' : 'light_mode';
    const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    el.themeBtn.setAttribute('aria-label', label);
    el.themeBtn.setAttribute('title', label);
}

el.themeBtn.addEventListener('click', () => {
    const next = isDarkNow() ? 'light' : 'dark';
    transitionTheme(() => {
        root.dataset.theme = next;
        try {
            localStorage.setItem('ripcord.theme', next);
        } catch { /* ignore */ }
        renderThemeButton();
        applyScheme();
        syncThemeColorMeta();
    });
    toast(next === 'dark' ? 'Theme set to dark.' : 'Theme set to light.');
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let hasStoredChoice = false;
    try {
        const stored = localStorage.getItem('ripcord.theme');
        hasStoredChoice = stored === 'light' || stored === 'dark';
    } catch { /* ignore */ }
    if (!hasStoredChoice) {
        transitionTheme(() => {
            root.dataset.theme = e.matches ? 'dark' : 'light';
            renderThemeButton();
            applyScheme();
            syncThemeColorMeta();
        });
    }
});

// show a small notification toast at the bottom

let toastTimer = 0;
function toast(message, ms = 1000) {
    logClientEvent('toast', message);
    el.snackbarText.textContent = message;
    el.snackbar.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.snackbar.classList.remove('show'), ms);
}
el.snackbarClose.addEventListener('click', () => el.snackbar.classList.remove('show'));

// client error handling and diagnostics subsystem

const ERROR_MESSAGES = {
    INVALID_URL: {
        message: 'Please enter a valid Spotify or YouTube link.',
        action: 'try_another'
    },
    UNSUPPORTED_URL: {
        message: 'This link is not supported. Please use a Spotify or YouTube track or playlist.',
        action: 'try_another'
    },
    UNSUPPORTED_FORMAT: {
        message: 'The requested audio format or bitrate is not supported.',
        action: 'try_another'
    },
    MIX_NOT_SUPPORTED: {
        message: 'YouTube Mix/Radio playlists are dynamic and cannot be downloaded as collections.',
        action: 'try_another'
    },
    QUEUE_FULL: {
        message: 'The server queue is currently full. Please wait a moment and try again.',
        action: 'retry',
        defaultRetrySeconds: 5
    },
    RATE_LIMITED: {
        message: 'Server is busy. Please wait before trying again.',
        action: 'retry',
        defaultRetrySeconds: 60
    },
    SERVER_SHUTTING_DOWN: {
        message: 'The server is restarting. Please try again shortly.',
        action: 'retry',
        defaultRetrySeconds: 10
    },
    AGE_RESTRICTED: {
        message: "This video is age-restricted and can't be downloaded on this server.",
        action: 'try_another'
    },
    LOGIN_REQUIRED: {
        message: 'YouTube requires a login or bot verification to access this audio.',
        action: 'try_another'
    },
    PRIVATE_OR_UNAVAILABLE: {
        message: 'This track is private, deleted, or unavailable.',
        action: 'try_another'
    },
    REGION_BLOCKED: {
        message: 'This content is not available in the server’s region.',
        action: 'try_another'
    },
    MEMBERS_ONLY: {
        message: 'This video is restricted to channel members only.',
        action: 'try_another'
    },
    LIVE_NOT_SUPPORTED: {
        message: 'Live streams cannot be downloaded until they have concluded.',
        action: 'try_another'
    },
    TOO_LARGE: {
        message: 'The resulting audio file exceeds the server’s size limit.',
        action: 'try_another'
    },
    TOO_LONG: {
        message: 'This track exceeds the maximum allowed duration.',
        action: 'try_another'
    },
    NETWORK_TIMEOUT: {
        message: 'The connection to the upstream audio source timed out.',
        action: 'retry',
        defaultRetrySeconds: 5
    },
    NO_MATCH: {
        message: 'Could not find a matching track for this Spotify song.',
        action: 'try_another'
    },
    SPOTIFY_UNREADABLE: {
        message: 'Track metadata is unavailable on Spotify.',
        action: 'try_another'
    },
    ENCODE_FAILED: {
        message: 'Audio encoding failed. Try a different format like MP3 or M4A.',
        action: 'retry'
    },
    TIMEOUT: {
        message: 'Audio processing timed out. Please try again.',
        action: 'retry'
    },
    CANCELLED: {
        message: 'The download was cancelled.',
        action: null
    },
    INTERNAL: {
        message: 'An internal server error occurred. Please try again.',
        action: 'retry'
    },
    NETWORK_ERROR: {
        message: 'Lost the network connection. Check your internet connection.',
        action: 'retry'
    }
};

function formatTrackFailure(code, error) {
    switch (code) {
        case 'AGE_RESTRICTED': return 'Age restricted';
        case 'NO_MATCH': return 'No match found';
        case 'RATE_LIMITED': return 'Rate limited';
        case 'LOGIN_REQUIRED': return 'Bot check / login required';
        case 'PRIVATE_OR_UNAVAILABLE': return 'Unavailable';
        case 'REGION_BLOCKED': return 'Region blocked';
        case 'MEMBERS_ONLY': return 'Members only';
        case 'LIVE_NOT_SUPPORTED': return 'Live stream';
        case 'TOO_LARGE': return 'Too large';
        case 'TOO_LONG': return 'Too long';
        case 'UNSUPPORTED_FORMAT': return 'Format error';
        case 'ENCODE_FAILED': return 'Encode failed';
        case 'NETWORK_TIMEOUT': return 'Network timeout';
        case 'TIMEOUT': return 'Timed out';
        default: return error || code || 'Skipped';
    }
}

function normalizeError(data, httpStatus, requestId) {
    const code = data?.code || (httpStatus === 429 ? 'RATE_LIMITED' : (httpStatus === 503 ? 'QUEUE_FULL' : (httpStatus >= 500 ? 'INTERNAL' : (httpStatus === 0 ? 'NETWORK_ERROR' : 'UNKNOWN'))));
    const def = ERROR_MESSAGES[code] || {};
    const message = def.message || data?.error || (httpStatus === 0 ? 'Lost connection. Check your internet.' : 'An error occurred.');
    const action = data?.action || def.action || (def.defaultRetrySeconds ? 'retry' : 'try_another');
    const retryAfterSeconds = data?.retryAfterSeconds || def.defaultRetrySeconds || null;

    const err = new Error(message);
    err.code = code;
    err.httpStatus = httpStatus;
    err.requestId = data?.requestId || requestId || null;
    err.retryable = Boolean(data?.retryable || def.action === 'retry' || retryAfterSeconds);
    err.action = action;
    err.retryAfterSeconds = retryAfterSeconds;
    return err;
}

function showErrorBanner(prefix, err, onRetry) {
    state.currentError = err;
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;

    const banner = el[`${prefix}Error`];
    const msg = el[`${prefix}ErrorMsg`];
    const ref = el[`${prefix}ErrorRef`];
    const actions = el[`${prefix}ErrorActions`];

    if (!banner) return;

    msg.textContent = err.message || 'An error occurred.';
    if (err.requestId) {
        ref.textContent = `Ref: ${String(err.requestId).slice(0, 8)}`;
        ref.hidden = false;
    } else {
        ref.textContent = '';
        ref.hidden = true;
    }

    actions.replaceChildren();

    if (err.action === 'retry') {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn--filled btn--sm';
        let remaining = Number(err.retryAfterSeconds || 0);

        if (remaining > 0) {
            retryBtn.disabled = true;
            retryBtn.textContent = `Retry (${remaining}s)`;
            state.countdownTimer = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                    clearInterval(state.countdownTimer);
                    state.countdownTimer = null;
                    retryBtn.disabled = false;
                    retryBtn.textContent = 'Retry';
                } else {
                    retryBtn.textContent = `Retry (${remaining}s)`;
                }
            }, 1000);
        } else {
            retryBtn.textContent = 'Retry';
        }

        retryBtn.addEventListener('click', () => {
            clearInterval(state.countdownTimer);
            state.countdownTimer = null;
            clearErrorBanner(prefix);
            onRetry?.();
        });
        actions.append(retryBtn);

        const tryAnotherBtn = document.createElement('button');
        tryAnotherBtn.type = 'button';
        tryAnotherBtn.className = 'btn btn--tonal btn--sm';
        tryAnotherBtn.textContent = 'Try another link';
        tryAnotherBtn.addEventListener('click', resetToInput);
        actions.append(tryAnotherBtn);

    } else if (err.action === 'try_another') {
        const tryAnotherBtn = document.createElement('button');
        tryAnotherBtn.type = 'button';
        tryAnotherBtn.className = 'btn btn--filled btn--sm';
        tryAnotherBtn.textContent = 'Try another link';
        tryAnotherBtn.addEventListener('click', resetToInput);
        actions.append(tryAnotherBtn);
    }

    banner.hidden = false;
}

function clearErrorBanner(prefix) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    const banner = el[`${prefix}Error`];
    if (banner) banner.hidden = true;
}

function resetToInput() {
    clearErrorBanner('input');
    clearErrorBanner('options');
    el.url.value = '';
    syncPasteButton();
    setFieldError('');
    go('input', 'back');
    el.url.focus();
}

// open and close the about dialog

el.aboutBtn.addEventListener('click', () => {
    logClientEvent('action', 'Opened about dialog');
    el.about.showModal();
});
el.aboutClose.addEventListener('click', () => {
    logClientEvent('action', 'Closed about dialog');
    el.about.close();
});
el.about.addEventListener('click', event => {
    const rect = el.about.getBoundingClientRect();
    const isInDialog = (
        rect.top <= event.clientY &&
        event.clientY <= rect.bottom &&
        rect.left <= event.clientX &&
        event.clientX <= rect.right
    );
    if (!isInDialog) el.about.close();
});

// spin the vinyl record cover while loading

let spin = null;
function setupSpin() {
    if (reduceMotion.matches || !el.cover.animate) return;
    const opts = { duration: 48000, iterations: Infinity, easing: 'linear' };
    const outer = el.cover.animate([{ rotate: '0deg' }, { rotate: '360deg' }], opts);
    const inner = el.coverImg.animate([{ rotate: '0deg' }, { rotate: '-360deg' }], opts);
    spin = [outer, inner];
}

function setSpinSpeed(rate) {
    if (!spin) return;
    spin.forEach(a => a.updatePlaybackRate(rate));
}

// switch between the different screens

const FOCUS_TARGET = {
    input: '#url',
    options: '#media-title',
    working: '#working-title',
    done: '#done-title'
};

function go(stage, dir = 'forward') {
    logClientEvent('transition', `Transition to ${stage} (${dir})`);
    const apply = () => {
        state.stage = stage;
        body.dataset.stage = stage;
    };
    const after = () => {
        const target = $(FOCUS_TARGET[stage]);
        if (target) target.focus({ preventScroll: true });
        root.removeAttribute('data-dir');
    };

    root.dataset.dir = dir;
    if (document.startViewTransition && !reduceMotion.matches) {
        const vt = document.startViewTransition(apply);
        vt.finished.finally(after);
    } else {
        apply();
        after();
    }
    setSpinSpeed(stage === 'working' ? 4 : 1);
}

// logic for the search input box and paste button

function setFieldError(message) {
    const bad = Boolean(message);
    el.search.dataset.invalid = String(bad);
    el.help.dataset.error = String(bad);
    el.help.textContent = message || 'Spotify, YouTube or YouTube Music links work.';
    el.url.setAttribute('aria-invalid', String(bad));
    if (bad) {
        // shake the input box if the url is invalid
        el.search.style.animation = 'none';
        void el.search.offsetWidth;
        el.search.style.animation = '';
    }
}

function syncPasteButton() {
    const has = el.url.value.length > 0;
    el.pasteIcon.textContent = has ? 'close' : 'content_paste';
    el.pasteBtn.setAttribute('aria-label', has ? 'Clear' : 'Paste from clipboard');
    el.pasteBtn.title = has ? 'Clear' : 'Paste';
}

el.url.addEventListener('input', () => {
    syncPasteButton();
    if (el.search.dataset.invalid === 'true') setFieldError('');
    clearErrorBanner('input');
});

el.pasteBtn.addEventListener('click', async () => {
    if (el.url.value) {
        logClientEvent('action', 'Cleared search input');
        el.url.value = '';
        syncPasteButton();
        setFieldError('');
        clearErrorBanner('input');
        el.url.focus();
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            logClientEvent('action', 'Pasted link from clipboard');
            el.url.value = text.trim();
            syncPasteButton();
            submitUrl();
        }
    } catch {
        toast('Could not read the clipboard. Press Ctrl+V in the box instead.');
        el.url.focus();
    }
});

// automatically start searching if the user pastes anywhere on the page
document.addEventListener('paste', event => {
    if (state.stage !== 'input' || document.activeElement === el.url) return;
    const text = event.clipboardData?.getData('text');
    if (!text) return;
    logClientEvent('action', 'Page paste detected');
    el.url.value = text.trim();
    syncPasteButton();
    submitUrl();
});

el.url.addEventListener('paste', () => {
    // wait a tick so the pasted text is actually in the box
    setTimeout(() => { if (normaliseUrl(el.url.value)) submitUrl(); }, 0);
});

el.form.addEventListener('submit', event => {
    event.preventDefault();
    submitUrl();
});

function setFetching(on) {
    el.fetchBtn.disabled = on;
    el.fetchIcon.textContent = on ? 'progress_activity' : 'arrow_forward';
    el.fetchIcon.classList.toggle('spin', on);
    el.fetchLabel.textContent = on ? 'Looking it up' : 'Continue';
}

let fetchController = null;
let fetchRequestId = 0;
let fetching = false;

async function submitUrl() {
    if (fetching) return;
    const rawVal = el.url.value;
    const playlistCtx = detectYouTubePlaylistContext(rawVal);
    const url = normaliseUrl(rawVal);
    if (!url) {
        const msg = rawVal.trim()
            ? 'That does not look like a Spotify or YouTube link.'
            : 'Paste a link first.';
        setFieldError(msg);
        showErrorBanner('input', normalizeError({ code: 'INVALID_URL', error: msg }, 400), () => submitUrl());
        el.url.focus();
        return;
    }
    state.playlistContext = playlistCtx;
    state.mode = 'track';

    if (fetchController) {
        fetchController.abort();
    }
    fetchController = new AbortController();
    const fetchId = ++fetchRequestId;

    el.url.value = url;
    setFieldError('');
    clearErrorBanner('input');
    fetching = true;
    setFetching(true);
    logClientEvent('api', 'Fetching metadata');
    try {
        const params = new URLSearchParams({ url });
        const res = await fetch(`/api/fetch-info?${params.toString()}`, {
            signal: fetchController.signal
        });
        if (fetchId !== fetchRequestId) return;
        const requestId = res.headers.get('x-request-id') || '';
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw normalizeError(data, res.status, requestId);
        logClientEvent('api', 'Metadata fetched successfully', { type: data.type, trackCount: data.trackCount || 1, requestId });
        state.url = data.url || url;
        el.url.value = state.url;
        state.info = data;
        state.mode = data.type === 'collection' ? 'playlist' : 'track';
        showOptions();
        remember(state.url, data);
    } catch (err) {
        if (fetchId !== fetchRequestId || err.name === 'AbortError') return;
        logClientEvent('error', `Metadata fetch failed: [${err.code || 'UNKNOWN'}] ${err.message}`, {
            code: err.code,
            requestId: err.requestId
        });
        showErrorBanner('input', err, () => submitUrl());
    } finally {
        if (fetchId === fetchRequestId) {
            fetching = false;
            setFetching(false);
        }
    }
}

// show recently downloaded songs

function remember(url, info) {
    const list = store.get('ripcord.recent', []).filter(r => r.url !== url);
    list.unshift({ url, title: info.title, artist: info.artist || '', thumbnail: info.thumbnail || '', type: info.type });
    store.set('ripcord.recent', list.slice(0, 3));
    renderRecent();
}

function renderRecent() {
    const list = store.get('ripcord.recent', []);
    el.recent.hidden = list.length === 0;
    el.recentList.replaceChildren();
    for (const item of list) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item';

        if (item.thumbnail) {
            const img = document.createElement('img');
            img.alt = '';
            img.width = img.height = 48;
            img.loading = 'lazy';
            img.src = coverSrc(item.thumbnail);
            img.onerror = () => { img.onerror = null; img.src = item.thumbnail; };
            btn.append(img);
        } else {
            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = 'music_note';
            btn.append(icon);
        }

        const text = document.createElement('span');
        text.className = 'list-item__text';
        const strong = document.createElement('strong');
        strong.textContent = item.title;
        const small = document.createElement('small');
        small.textContent = item.artist || (item.type === 'collection' ? 'Collection' : '');
        text.append(strong, small);
        btn.append(text);

        btn.addEventListener('click', () => {
            el.url.value = item.url;
            syncPasteButton();
            submitUrl();
        });
        li.append(btn);
        el.recentList.append(li);
    }
}

// options screen where the user picks format and quality

function currentFormat() {
    return $('input[name="format"]:checked').value;
}

function currentNameStyle() {
    return $('input[name="namestyle"]:checked').value;
}

function suggestedName() {
    const info = state.info;
    if (!info) return '';
    const title = el.clean.checked ? tidyTitle(info.title) : info.title;
    const artist = info.artist || '';
    let name = title;
    if (info.type !== 'collection' && artist) {
        const style = currentNameStyle();
        if (style === 'title_artist') name = `${title} - ${artist}`;
        if (style === 'artist_title') name = `${artist} - ${title}`;
    }
    return safeName(name);
}

let nameTouched = false;
function refreshName() {
    if (!nameTouched) el.filename.value = suggestedName();
}

function crossfadeText(elem, newText) {
    if (!elem || elem.textContent === newText) return;
    if (reduceMotion.matches) {
        elem.textContent = newText;
        return;
    }
    elem.style.opacity = '0.2';
    requestAnimationFrame(() => {
        elem.textContent = newText;
        elem.style.opacity = '1';
    });
}

function updateSegmented(seg) {
    if (!seg) return;
    const checked = seg.querySelector('input:checked');
    if (!checked) return;
    const label = checked.closest('label');
    if (!label) return;
    const segRect = seg.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    if (segRect.width === 0) return;
    const left = labelRect.left - segRect.left;
    const width = labelRect.width;
    seg.style.setProperty('--indicator-left', `${left}px`);
    seg.style.setProperty('--indicator-width', `${width}px`);
    seg.style.setProperty('--indicator-opacity', '1');
    seg.dataset.ready = 'true';
}

function updateAllSegmented() {
    $$('.segmented').forEach(updateSegmented);
}

if (typeof ResizeObserver !== 'undefined') {
    const segObserver = new ResizeObserver(entries => {
        for (const entry of entries) updateSegmented(entry.target);
    });
    $$('.segmented').forEach(s => segObserver.observe(s));
}
window.addEventListener('resize', updateAllSegmented);
if (document.fonts) document.fonts.ready.then(updateAllSegmented);

function refreshFormat() {
    const fmt = currentFormat();
    const lossless = LOSSLESS.has(fmt);
    el.ext.textContent = `.${fmt}`;
    crossfadeText(el.formatHint, FORMAT_HINTS[fmt]);
    el.qualityGroup.dataset.collapsed = String(lossless);
    el.qualityGroup.inert = lossless;
    el.qualityGroup.setAttribute('aria-hidden', String(lossless));
    el.bitrate.disabled = lossless;
    crossfadeText(el.bitrateOut, lossless ? 'Lossless' : `${BITRATES[el.bitrate.value]} kbps`);
    updateSegmented($('#format-group'));
}

function refreshSlider() {
    const pct = (el.bitrate.value / (el.bitrate.max - el.bitrate.min)) * 100;
    el.bitrate.parentElement.style.setProperty('--slider-position', `${pct}%`);
    crossfadeText(el.bitrateOut, LOSSLESS.has(currentFormat()) ? 'Lossless' : `${BITRATES[el.bitrate.value]} kbps`);
}

$$('input[name="format"]').forEach(i => {
    i.addEventListener('change', refreshFormat);
    i.addEventListener('input', refreshFormat);
});
$$('input[name="namestyle"]').forEach(i => i.addEventListener('change', () => {
    nameTouched = false;
    refreshName();
    updateSegmented($('#name-style'));
}));
el.clean.addEventListener('change', () => { nameTouched = false; refreshName(); });
el.bitrate.addEventListener('input', refreshSlider);
el.filename.addEventListener('input', () => { nameTouched = true; });

function showOptions() {
    const info = state.info;
    const isCollection = state.mode === 'playlist' || info.type === 'collection';
    const isSpotify = /spotify\.com/i.test(state.url);

    // fill in the title and cover art before showing the screen
    el.mediaTitle.textContent = info.title;
    el.mediaArtist.textContent = isCollection
        ? `${info.trackCount} ${info.trackCount === 1 ? 'track' : 'tracks'}${info.trackCount >= 30 ? ' (capped at 30)' : ''}`
        : (info.artist || '');
    el.badgeText.textContent = isCollection ? 'Collection' : 'Track';
    $('.icon', el.badge).textContent = isCollection ? 'library_music' : 'music_note';

    el.coverImg.onerror = () => {
        el.coverImg.onerror = null;
        el.coverImg.src = info.thumbnail || '';
    };
    el.coverImg.onload = () => seedFromCover();
    el.coverImg.crossOrigin = 'anonymous';
    el.coverImg.src = info.thumbnail ? coverSrc(info.thumbnail) : '';
    if (!info.thumbnail) resetSeed();

    el.spotifyNote.hidden = !isSpotify;
    el.nameGroup.style.display = isCollection ? 'none' : '';
    $$('input[name="namestyle"]').forEach(i => { i.disabled = isCollection; });
    $('input[name="namestyle"][value="title"]').checked = true;
    nameTouched = false;
    refreshName();
    refreshFormat();
    refreshSlider();
    requestAnimationFrame(() => updateAllSegmented());

    el.downloadLabel.textContent = isCollection
        ? `Download ${info.trackCount} tracks as ZIP`
        : 'Download';

    updatePlaylistCallout();

    go('options', 'forward');
}

function updatePlaylistCallout() {
    if (!el.playlistCallout) return;
    const ctx = state.playlistContext;
    if (!ctx || !ctx.playlistId) {
        el.playlistCallout.hidden = true;
        return;
    }

    el.playlistCallout.hidden = false;
    el.playlistToggleBtn.hidden = false;

    if (state.mode === 'playlist') {
        el.playlistCalloutText.textContent = 'Viewing full playlist.';
        el.playlistCalloutCap.hidden = false;
        el.playlistCalloutCap.textContent = 'Playlists are capped at up to 30 tracks.';
        el.playlistToggleBtn.textContent = 'Just this track';
    } else {
        el.playlistCalloutText.textContent = 'This track is part of a playlist.';
        el.playlistCalloutCap.hidden = true;
        el.playlistToggleBtn.textContent = 'Use the whole playlist';
    }
}

let mediaSwitchController = null;
let mediaSwitchId = 0;

async function switchMediaMode(nextMode, targetUrl) {
    if (fetching) return;

    if (mediaSwitchController) {
        mediaSwitchController.abort();
    }
    mediaSwitchController = new AbortController();
    const switchId = ++mediaSwitchId;

    fetching = true;
    el.playlistToggleBtn.disabled = true;
    el.playlistToggleBtn.textContent = 'Loading...';
    el.screenOptions?.setAttribute('aria-busy', 'true');
    clearErrorBanner('options');

    logClientEvent('action', `Switching media mode to ${nextMode}`, { targetUrl });

    try {
        const res = await fetch(`/api/fetch-info?${new URLSearchParams({ url: targetUrl })}`, {
            signal: mediaSwitchController.signal
        });
        if (switchId !== mediaSwitchId) return;

        const requestId = res.headers.get('x-request-id') || '';
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw normalizeError(data, res.status, requestId);

        state.mode = nextMode;
        state.url = data.url || targetUrl;
        el.url.value = state.url;
        state.info = data;
        nameTouched = false;

        logClientEvent('api', `Switched mode to ${nextMode} successfully`, {
            type: data.type,
            trackCount: data.trackCount || 1,
            requestId
        });

        showOptions();
        remember(state.url, data);
    } catch (err) {
        if (switchId !== mediaSwitchId || err.name === 'AbortError') return;
        logClientEvent('error', `Failed to switch mode to ${nextMode}: [${err.code || 'UNKNOWN'}] ${err.message}`, {
            code: err.code,
            requestId: err.requestId
        });
        showErrorBanner('options', err,
            () => switchMediaMode(nextMode, targetUrl),
            () => switchMediaMode(nextMode, targetUrl)
        );
    } finally {
        if (switchId === mediaSwitchId) {
            fetching = false;
            el.playlistToggleBtn.disabled = false;
            el.screenOptions?.removeAttribute('aria-busy');
            updatePlaylistCallout();
        }
    }
}

el.playlistToggleBtn?.addEventListener('click', () => {
    if (!state.playlistContext || !state.playlistContext.playlistId) return;
    const nextMode = state.mode === 'track' ? 'playlist' : 'track';
    const targetUrl = nextMode === 'playlist'
        ? state.playlistContext.playlistUrl
        : state.playlistContext.singleTrackUrl;
    switchMediaMode(nextMode, targetUrl);
});

el.backBtn.addEventListener('click', () => {
    resetSeed();
    go('input', 'back');
});

// handle starting the download

function startDownload() {
    clearErrorBanner('options');
    const info = state.info;
    const isCollection = info.type === 'collection';
    const fmt = currentFormat();
    const bitrate = LOSSLESS.has(fmt) ? 320 : BITRATES[el.bitrate.value];
    const name = safeName(el.filename.value) || suggestedName() || 'ripcord';

    const params = new URLSearchParams({ url: state.url, bitrate: String(bitrate), format: fmt, filename: name });
    if (!isCollection && nameTouched) {
        const customTitle = el.filename.value.trim().slice(0, 120);
        if (customTitle) params.set('title', customTitle);
    }
    const saveName = isCollection ? `${safeName(info.title) || 'ripcord'}.zip` : `${name}.${fmt}`;
    state.blobName = saveName;

    logClientEvent('action', 'Initiated download', { format: fmt, bitrate, isCollection });

    el.workingTitle.textContent = isCollection ? 'Packing up your collection' : 'Pulling the sound out';
    el.metaLeft.textContent = 'Getting started';
    el.metaRight.textContent = '0:00';
    resetProgressBar();
    el.workingHint.textContent = isCollection
        ? 'Collections are prepared track by track, so this can take a few minutes. You can leave this tab open.'
        : 'Finding the audio and converting it. Usually under a minute.';

    state.jobId = isCollection ? newJobId() : '';
    if (state.jobId) params.set('job', state.jobId);
    renderTrackList(isCollection ? collectionTracks(info) : []);

    state.startedAt = Date.now();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
        el.metaRight.textContent = formatTime((Date.now() - state.startedAt) / 1000);
    }, 500);

    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('GET', `/api/download?${params}`);
    xhr.responseType = 'blob';

    xhr.onprogress = event => {
        if (event.loaded === 0) return;
        // collections report per-track progress through the job poller instead of ZIP bytes
        if (state.jobId) return;
        if (event.lengthComputable && event.total > 0) {
            const fraction = Math.min(1, event.loaded / event.total);
            const pct = setProgress(fraction);
            el.metaLeft.textContent = `${pct}% · ${formatMB(event.loaded)} of ${formatMB(event.total)}`;
        } else {
            // show how many megabytes have been downloaded so far
            el.metaLeft.textContent = `${formatMB(event.loaded)} received`;
        }
    };

    xhr.onload = async () => {
        stopTimer();
        if (xhr.status >= 200 && xhr.status < 300) {
            setProgress(1);
            state.blob = xhr.response;
            const dispositionHeader = xhr.getResponseHeader('Content-Disposition') || '';
            state.blobName = resolveDownloadName(dispositionHeader, info, isCollection, fmt);
            const noteHeader = xhr.getResponseHeader('X-Ripcord-Note');
            if (noteHeader) {
                logClientEvent('api', `Server note: ${noteHeader}`);
            }
            logClientEvent('api', 'Download completed successfully', { status: xhr.status, size: state.blob.size, name: state.blobName });

            if (isCollection && state.jobId) {
                try {
                    const finalRes = await fetch(`/api/progress/${encodeURIComponent(state.jobId)}`, { cache: 'no-store' });
                    if (finalRes.ok) {
                        const finalJob = await finalRes.json();
                        applyJob(finalJob);
                    }
                } catch { /* proceed with last known state */ }
            }

            saveBlob();
            finish(isCollection);
        } else {
            let data = {};
            const requestId = xhr.getResponseHeader('X-Request-Id') || '';
            try {
                data = JSON.parse(await xhr.response.text());
            } catch { /* keep generic */ }
            const err = normalizeError(data, xhr.status, requestId);
            fail(err);
        }
    };
    xhr.onerror = () => {
        stopTimer();
        const err = normalizeError({ code: 'NETWORK_ERROR' }, 0);
        fail(err);
    };
    xhr.onabort = () => { stopTimer(); };

    xhr.send();
    if (state.jobId) pollJob(state.jobId);
    go('working', 'forward');
}

function stopTimer() {
    clearInterval(state.timer);
    state.timer = 0;
    stopPolling();
}

// per-track progress for collections

const TRACK_STATES = {
    queued: { icon: 'schedule', label: 'Queued' },
    matching: { spinner: true, label: 'Finding' },
    downloading: { spinner: true, label: 'Downloading' },
    encoding: { spinner: true, label: 'Converting' },
    done: { icon: 'check_circle', label: 'Done' },
    failed: { icon: 'error', label: 'Failed' }
};

function newJobId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // randomUUID is unavailable on plain-http hosts, so fall back to random hex
    return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function collectionTracks(info) {
    if (Array.isArray(info.tracks) && info.tracks.length) return info.tracks;
    return Array.from({ length: Number(info.trackCount) || 0 }, (_, i) => ({ title: `Track ${i + 1}`, artist: '' }));
}

// how far along one track is, from 0 to 1; failed tracks count as processed
function trackFraction(track) {
    switch (track.state) {
        case 'matching': return 0.05;
        case 'downloading': return 0.05 + 0.75 * (Number(track.progress) || 0);
        case 'encoding': return 0.85;
        case 'done':
        case 'failed': return 1;
        default: return 0;
    }
}

function resetProgressBar() {
    el.wavy.dataset.indeterminate = 'true';
    el.wavy.dataset.complete = 'false';
    el.wavy.style.removeProperty('--p');
    el.wavy.style.removeProperty('--pn');
    el.wavy.removeAttribute('aria-valuenow');
    el.wavy.removeAttribute('aria-valuetext');
}

// drive the wavy bar from a 0..1 fraction; returns the rounded percentage
function setProgress(fraction, valueText) {
    const clamped = Math.max(0, Math.min(1, fraction));
    const pct = Math.round(clamped * 100);
    el.wavy.dataset.indeterminate = 'false';
    el.wavy.dataset.complete = String(pct >= 100);
    el.wavy.style.setProperty('--p', `${(clamped * 100).toFixed(2)}%`);
    el.wavy.style.setProperty('--pn', clamped.toFixed(4));
    el.wavy.setAttribute('aria-valuenow', String(pct));
    el.wavy.setAttribute('aria-valuetext', valueText ? `${valueText}, ${pct}%` : `${pct}%`);
    return pct;
}

function renderTrackList(tracks) {
    state.rows = [];
    state.activeRow = -1;
    el.tracklist.replaceChildren();
    el.tracklistWrap.hidden = tracks.length === 0;
    el.tracklistWrap.scrollTop = 0;
    const fragment = document.createDocumentFragment();
    tracks.forEach((track, index) => {
        const li = document.createElement('li');
        li.className = 'track';
        const num = document.createElement('span');
        num.className = 'track__num';
        num.setAttribute('aria-hidden', 'true');
        num.textContent = String(index + 1);
        const text = document.createElement('span');
        text.className = 'track__text';
        const title = document.createElement('span');
        title.className = 'track__title';
        title.textContent = track.title || `Track ${index + 1}`;
        title.title = title.textContent;
        text.append(title);
        if (track.artist) {
            const sub = document.createElement('span');
            sub.className = 'track__sub';
            sub.textContent = track.artist;
            sub.title = track.artist;
            text.append(sub);
        }
        const status = document.createElement('span');
        status.className = 'track__status';
        li.append(num, text, status);
        fragment.append(li);
        const row = { li, text, status, key: '' };
        state.rows.push(row);
        updateTrackRow(row, { state: 'queued', progress: 0 });
    });
    el.tracklist.append(fragment);
}

function updateTrackRow(row, track) {
    const info = TRACK_STATES[track.state] || TRACK_STATES.queued;
    const pct = Math.round((Number(track.progress) || 0) * 100);
    const determinate = track.state === 'downloading' && pct > 0;
    const failureReason = track.state === 'failed' ? formatTrackFailure(track.code, track.error) : '';
    const note = track.note || '';
    const key = `${track.state}:${determinate ? pct : ''}:${failureReason}:${note}`;
    if (row.key === key) return;
    row.key = key;
    row.li.dataset.state = track.state in TRACK_STATES ? track.state : 'queued';

    if (note && !row.li.querySelector('.track__note')) {
        const noteBadge = document.createElement('span');
        noteBadge.className = 'track__note';
        noteBadge.textContent = note === 'alternate version used' ? 'alternate version' : note;
        const sub = row.text ? row.text.querySelector('.track__sub') : null;
        if (sub) {
            sub.append(' · ', noteBadge);
        } else if (row.text) {
            row.text.append(noteBadge);
        }
    }

    const label = document.createElement('span');
    if (track.state === 'failed') {
        label.textContent = `Skipped: ${failureReason}`;
        row.li.title = track.error || failureReason;
    } else {
        label.textContent = determinate ? `${info.label} ${pct}%` : info.label;
    }

    let indicator;
    if (info.spinner) {
        indicator = document.createElement('span');
        indicator.className = 'spinner';
        indicator.setAttribute('aria-hidden', 'true');
        if (determinate) indicator.style.setProperty('--tp', String(pct / 100));
        else indicator.dataset.indeterminate = 'true';
    } else {
        indicator = document.createElement('span');
        indicator.className = `icon${track.state === 'done' ? ' fill' : ''}`;
        indicator.setAttribute('aria-hidden', 'true');
        indicator.textContent = info.icon;
    }
    row.status.replaceChildren(label, indicator);
}

function scrollRowIntoView(index) {
    const row = state.rows[index];
    if (!row) return;
    const wrap = el.tracklistWrap;
    const top = row.li.offsetTop - wrap.offsetTop;
    const bottom = top + row.li.offsetHeight;
    // scroll only the list, never the page
    if (top < wrap.scrollTop || bottom > wrap.scrollTop + wrap.clientHeight) {
        wrap.scrollTo({ top: Math.max(0, top - 8), behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
}

function applyJob(job) {
    state.lastJob = job;
    const tracks = Array.isArray(job.tracks) ? job.tracks : [];
    if (!tracks.length) return;
    if (tracks.length !== state.rows.length) renderTrackList(tracks);
    tracks.forEach((track, i) => updateTrackRow(state.rows[i], track));

    const summary = job.summary || {
        total: tracks.length,
        ok: tracks.filter(t => t.state === 'done').length,
        failed: tracks.filter(t => t.state === 'failed')
    };

    const total = summary.total || tracks.length;
    const failedCount = Array.isArray(summary.failed) ? summary.failed.length : tracks.filter(t => t.state === 'failed').length;
    const okCount = tracks.filter(t => t.state === 'done').length;
    const processed = Math.min(total, okCount + failedCount);
    const overall = tracks.reduce((sum, t) => sum + trackFraction(t), 0) / (total || 1);

    const current = Math.min(total, processed + 1);
    const phase = processed >= total ? 'Zipping up' : `Downloading ${current} of ${total}`;
    const pct = setProgress(overall, phase);
    el.metaLeft.textContent = `${phase} · ${pct}%${failedCount ? ` · ${failedCount} skipped` : ''}`;

    const active = tracks.findIndex(t => t.state === 'matching' || t.state === 'downloading' || t.state === 'encoding');
    if (active !== -1 && active !== state.activeRow) {
        state.activeRow = active;
        scrollRowIntoView(active);
    }
}

function pollJob(jobId) {
    stopPolling();
    const tick = async () => {
        if (state.jobId !== jobId) return;
        try {
            const res = await fetch(`/api/progress/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
            if (state.jobId !== jobId) return;
            if (res.ok) {
                const job = await res.json();
                applyJob(job);
                if (job.status && job.status !== 'running') return;
            }
        } catch { /* transient network hiccup; try again on the next tick */ }
        if (state.jobId === jobId) state.poll = setTimeout(tick, 1000);
    };
    state.poll = setTimeout(tick, 600);
}

function stopPolling() {
    clearTimeout(state.poll);
    state.poll = 0;
}

function saveBlob() {
    if (!state.blob) return;
    if (!state.blobName) {
        const isCollection = state.mode === 'playlist' || state.info?.type === 'collection';
        state.blobName = resolveDownloadName('', state.info, isCollection, currentFormat());
    }
    const href = URL.createObjectURL(state.blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = state.blobName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
}

function fail(err) {
    state.xhr = null;
    logClientEvent('error', `Download failed: [${err.code || 'UNKNOWN'}] ${err.message}`, {
        code: err.code,
        requestId: err.requestId
    });
    go('options', 'back');
    showErrorBanner('options', err, () => startDownload());
}

function updateSkippedToggleLabel(failedCount, isExpanded) {
    const count = Number.isSafeInteger(failedCount) && failedCount > 0 ? failedCount : 1;
    const noun = count === 1 ? '1 track' : `${count} tracks`;
    const action = isExpanded ? '(click to hide)' : '(click to see why)';
    el.doneSkippedToggleText.textContent = `${noun} could not be downloaded ${action}`;
}

function finish(isCollection) {
    state.xhr = null;
    if (isCollection && state.lastJob) {
        const summary = state.lastJob.summary || {
            total: (state.lastJob.tracks || []).length,
            ok: (state.lastJob.tracks || []).filter(t => t.state === 'done').length,
            failed: (state.lastJob.tracks || []).filter(t => t.state !== 'done').map((t, i) => ({
                index: i,
                title: t.title,
                artist: t.artist,
                code: t.code,
                error: t.error
            }))
        };
        const total = summary.total;
        const failedTracks = Array.isArray(summary.failed) ? summary.failed : [];
        const failedCount = failedTracks.length;
        // Invariant: ready + skipped === total
        const readyCount = Math.max(0, total - failedCount);

        if (failedCount > 0) {
            el.doneTitle.textContent = `${readyCount} of ${total} ready, ${failedCount} skipped`;
            el.doneSub.textContent = 'Your ZIP should be in your downloads folder.';
            el.doneSkipped.hidden = false;
            el.doneSkippedPanel.hidden = true;
            el.doneSkippedToggle.setAttribute('aria-expanded', 'false');
            updateSkippedToggleLabel(failedCount, false);
            el.doneSkippedList.replaceChildren();

            failedTracks.forEach(t => {
                const li = document.createElement('li');
                li.className = 'done-skipped__item';
                const titleSpan = document.createElement('span');
                titleSpan.className = 'done-skipped__title';
                titleSpan.textContent = `${t.title || 'Track'}${t.artist ? ` - ${t.artist}` : ''}`;
                const reasonSpan = document.createElement('span');
                reasonSpan.className = 'done-skipped__reason';
                reasonSpan.textContent = formatTrackFailure(t.code, t.error);
                li.append(titleSpan, reasonSpan);
                el.doneSkippedList.append(li);
            });
        } else {
            el.doneTitle.textContent = 'All done. Enjoy!';
            el.doneSub.textContent = 'Your ZIP should be in your downloads folder.';
            el.doneSkipped.hidden = true;
        }
    } else {
        el.doneTitle.textContent = 'All done. Enjoy!';
        el.doneSub.textContent = 'Your file should be in your downloads folder.';
        el.doneSkipped.hidden = true;
    }
    go('done', 'forward');
    celebrate();
}

function celebrate() {
    el.doneBurst.replaceChildren();
    if (reduceMotion.matches) return;
    const glyphs = ['music_note', 'music_note', 'queue_music', 'graphic_eq', 'favorite'];
    for (let i = 0; i < 9; i++) {
        const n = document.createElement('span');
        n.className = 'icon fill note';
        n.textContent = glyphs[i % glyphs.length];
        n.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 300)}px`);
        n.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 80)}deg`);
        n.style.animationDelay = `${i * 70}ms`;
        el.doneBurst.append(n);
    }
}

el.doneSkippedToggle.addEventListener('click', () => {
    const isHidden = el.doneSkippedPanel.hidden;
    const willOpen = isHidden;
    el.doneSkippedPanel.hidden = !willOpen;
    el.doneSkippedToggle.setAttribute('aria-expanded', String(willOpen));
    const failedCount = (state.lastJob?.summary?.failed || []).length || (state.lastJob?.tracks || []).filter(t => t.state === 'failed').length || 1;
    updateSkippedToggleLabel(failedCount, willOpen);
    logClientEvent('action', willOpen ? 'Expanded skipped tracks' : 'Collapsed skipped tracks');
});

el.downloadBtn.addEventListener('click', () => {
    clearErrorBanner('options');
    startDownload(false);
});
el.cancelBtn.addEventListener('click', () => {
    logClientEvent('action', 'Cancelled download');
    state.jobId = '';
    stopPolling();
    if (state.xhr) state.xhr.abort();
    state.xhr = null;
    toast('Cancelled.');
    go('options', 'back');
});
el.saveBtn.addEventListener('click', () => {
    logClientEvent('action', 'Saved audio file again');
    saveBlob();
});
el.againBtn.addEventListener('click', () => {
    logClientEvent('action', 'Resetting to rip another track');
    state.blob = null;
    state.blobName = '';
    state.info = null;
    state.lastJob = null;
    clearErrorBanner('input');
    clearErrorBanner('options');
    el.url.value = '';
    syncPasteButton();
    setFieldError('');
    resetSeed();
    go('input', 'back');
});

// start everything up when the page loads

renderThemeButton();
renderRecent();
syncPasteButton();
setupSpin();
syncThemeColorMeta();
initColourEngine();

if (isDev) {
    window.resolveDownloadName = resolveDownloadName;
    window.state = state;
    window.finish = finish;
}

setTimeout(() => {
    delete root.dataset.intro;
}, 1350);


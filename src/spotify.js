const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
    MAX_PLAYLIST_TRACKS,
    SPOTIFY_MATCH_CACHE_FILE,
    SPOTIFY_MATCH_CACHE_MAX_SIZE,
    SPOTIFY_MATCH_CACHE_TTL_MS
} = require('./config');
const { Logger, safeMetadataText } = require('./logger');
const { Semaphore } = require('./queue');
const { parseCoverUrl } = require('./media');

function spotifyLinkDetails(urlString) {
    if (!urlString || typeof urlString !== 'string' || urlString.length > 2048) return null;
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'open.spotify.com') return null;
        const match = parsed.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)\/?$/);
        return match ? { type: match[1], id: match[2] } : null;
    } catch {
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
            if (oldestKey) this.cache.delete(oldestKey);
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

class SpotifyMatchCache {
    constructor({
        filePath = SPOTIFY_MATCH_CACHE_FILE,
        maxSize = SPOTIFY_MATCH_CACHE_MAX_SIZE,
        ttlMs = SPOTIFY_MATCH_CACHE_TTL_MS,
        logger = Logger
    } = {}) {
        this.filePath = filePath;
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.logger = logger;
        this.cache = new Map();
        this.saveTimeout = null;
        this.init();
    }

    normalizeKey(key) {
        if (!key || typeof key !== 'string') return '';
        if (key.startsWith('spotify:track:')) return key.slice('spotify:track:'.length).trim();
        return key.trim();
    }

    init() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                const data = JSON.parse(raw);
                if (data && typeof data === 'object') {
                    const now = Date.now();
                    const entries = Array.isArray(data.entries) ? data.entries : Object.entries(data).map(([k, v]) => ({ key: k, ...v }));
                    for (const entry of entries) {
                        const key = this.normalizeKey(entry.key || entry.id);
                        if (!key || !entry.videoId) continue;
                        if (entry.expiresAt && entry.expiresAt <= now) continue;
                        this.cache.set(key, {
                            videoId: entry.videoId,
                            matchedTitle: entry.matchedTitle || '',
                            score: entry.score || entry.confidence || 0.9,
                            confidence: entry.confidence || entry.score || 0.9,
                            expiresAt: entry.expiresAt || (now + this.ttlMs)
                        });
                    }
                    this.logger.info(`Spotify match cache loaded ${this.cache.size} valid entries from ${this.filePath}`);
                }
            }
        } catch (err) {
            this.logger.warn(`Failed to load Spotify match cache from ${this.filePath}: ${err.message}`);
        }
    }

    get(key) {
        const norm = this.normalizeKey(key);
        if (!norm || !this.cache.has(norm)) return null;
        const entry = this.cache.get(norm);
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(norm);
            this.scheduleSave();
            return null;
        }
        this.cache.delete(norm);
        this.cache.set(norm, entry);
        return entry;
    }

    set(key, matchData) {
        const norm = this.normalizeKey(key);
        if (!norm || !matchData || !matchData.videoId) return;
        const confidence = Number(matchData.confidence ?? matchData.score ?? 0);
        if (confidence < 0.9) return;

        if (this.cache.has(norm)) {
            this.cache.delete(norm);
        } else if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) this.cache.delete(oldestKey);
        }

        this.cache.set(norm, {
            videoId: matchData.videoId,
            matchedTitle: matchData.matchedTitle || '',
            score: matchData.score ?? confidence,
            confidence: confidence,
            expiresAt: Date.now() + this.ttlMs
        });

        this.scheduleSave();
    }

    invalidate(key) {
        const norm = this.normalizeKey(key);
        if (!norm) return false;
        if (this.cache.delete(norm)) {
            this.logger.info(`Spotify match cache invalidated entry: ${norm}`);
            this.scheduleSave();
            return true;
        }
        return false;
    }

    invalidateByVideoId(videoId) {
        if (!videoId) return false;
        let removed = 0;
        for (const [k, v] of this.cache.entries()) {
            if (v.videoId === videoId) {
                this.cache.delete(k);
                removed++;
            }
        }
        if (removed > 0) {
            this.logger.info(`Spotify match cache invalidated ${removed} entry/entries for video ID: ${videoId}`);
            this.scheduleSave();
            return true;
        }
        return false;
    }

    scheduleSave() {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.flush();
        }, 1000);
    }

    flush() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const entries = [];
            const now = Date.now();
            for (const [key, val] of this.cache.entries()) {
                if (val.expiresAt > now) {
                    entries.push({ key, ...val });
                }
            }

            const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2);
            const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tmpPath, payload, 'utf8');
            fs.renameSync(tmpPath, this.filePath);
        } catch (err) {
            this.logger.warn(`Failed to atomically save Spotify match cache: ${err.message}`);
        }
    }
}

const spotifyMatchCache = new SpotifyMatchCache({
    filePath: SPOTIFY_MATCH_CACHE_FILE,
    maxSize: SPOTIFY_MATCH_CACHE_MAX_SIZE,
    ttlMs: SPOTIFY_MATCH_CACHE_TTL_MS,
    logger: Logger
});

function getSpotifyDurationMs(track) {
    const raw = track?.duration_ms ?? track?.durationMs ?? track?.duration?.totalMilliseconds ?? track?.duration?.milliseconds ?? track?.duration;
    const duration = Number(raw);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return duration < 1000 ? Math.round(duration * 1000) : Math.round(duration);
}

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

    if (tracks.length === 0 && type === 'track') {
        const titleMatch = html.match(/<meta property="og:title" content="(.*?)"/i) || html.match(/<title>(.*?)<\/title>/i);
        const descMatch = html.match(/<meta property="og:description" content="(.*?)"/i);
        const imageMatch = html.match(/<meta property="og:image" content="(.*?)"/i);

        let parsedTitle = titleMatch ? titleMatch[1] : 'Unknown Track';
        let parsedArtist = descMatch ? descMatch[1] : 'Unknown Artist';
        if (imageMatch && !coverImage) coverImage = parseCoverUrl(imageMatch[1])?.href || '';

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

module.exports = {
    spotifyLinkDetails,
    SpotifyCoverCache,
    spotifyCoverCache,
    fetchSpotifyTrackCoverUrl,
    SpotifyMatchCache,
    spotifyMatchCache,
    getSpotifyDurationMs,
    extractVersionInfo,
    parseArtists,
    normalizeText,
    normalizeToAlphaNumeric,
    normalizeArtistName,
    getSpotifyData
};

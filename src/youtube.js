const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const {
    WORK_DIR,
    MAX_PLAYLIST_TRACKS,
    MAX_PLAYLIST_OUTPUT_BYTES,
    MAX_COVER_BYTES,
    MAX_DOWNLOAD_BYTES,
    MAX_AUDIO_OUTPUT_BYTES,
    zipTrackLimit,
    YTDLP_CONCURRENT_FRAGMENTS,
    YTDLP_AUTHED_CLIENTS,
    YTDLP_USE_ARIA2C,
    aria2cAvailable,
    COOKIES_PATH,
    SPOTIFY_SEARCH_EARLY_EXIT_SCORE,
    SPOTIFY_PREWARM_MAX_TRACKS,
    SPOTIFY_PREWARM_CONCURRENCY
} = require('./config');
const { Logger, startStage, safeMetadataText, sanitizeAsciiHeader } = require('./logger');
const { AppError, classifyError } = require('./errors');
const { ytdlpSemaphore, downloadQueue, Semaphore } = require('./queue');
const { cookieGuard, ageRestrictedCache, AgeGateLruCache } = require('./cookies');
const {
    downloadMetaMap,
    sanitizeFilename,
    cleanupFiles,
    parseCoverUrl,
    cropToSquareJpeg,
    probeAudioCodec,
    ffmpegEncodeArgs,
    runFfmpeg,
    injectVorbisCoverArt,
    fetchCoverBuffer,
    fetchYouTubeThumbnailBuffer
} = require('./media');
const {
    fetchSpotifyTrackCoverUrl,
    spotifyMatchCache,
    normalizeText,
    normalizeToAlphaNumeric,
    normalizeArtistName,
    extractVersionInfo,
    parseArtists
} = require('./spotify');

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

function classifyMatch(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return { quality: 'unknown', score: null, title: '', uploader: '' };
    }

    const rawTitle = candidate.matchedTitle || candidate.title || candidate.rawTitle || candidate.candidate?.title || '';
    const rawUploader = candidate.uploader || candidate.channel || candidate.matchedArtist || candidate.candidate?.uploader || candidate.candidate?.channel || '';
    const title = safeMetadataText(rawTitle, '');
    const uploader = safeMetadataText(rawUploader, '');
    const score = typeof candidate.score === 'number'
        ? Math.round(candidate.score * 1000) / 1000
        : (typeof candidate.confidence === 'number' ? Math.round(candidate.confidence * 1000) / 1000 : null);

    if (candidate.quality && ['official', 'good', 'approximate', 'unknown'].includes(candidate.quality)) {
        return { quality: candidate.quality, score, title, uploader };
    }

    const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : null;
    if (!reasons) {
        return { quality: 'unknown', score, title, uploader };
    }

    const hasApproximateSignal = reasons.some(r =>
        typeof r === 'string' && (
            r.startsWith('missing_') ||
            r.startsWith('conflicting_') ||
            r.startsWith('unwanted_') ||
            r.startsWith('penalty_') ||
            r.includes('conflict')
        )
    ) || (score !== null && score < 0.9);

    if (hasApproximateSignal) {
        return { quality: 'approximate', score, title, uploader };
    }

    const isTopic = reasons.includes('topic_channel_official') ||
        uploader.toLowerCase().endsWith(' - topic') ||
        Boolean(candidate.isTopicChannel);
    const isOfficialArtist = reasons.includes('official_artist_channel') ||
        reasons.includes('vevo_channel');

    if (isTopic || isOfficialArtist) {
        return { quality: 'official', score, title, uploader };
    }

    if (score !== null && score >= 0.9) {
        return { quality: 'good', score, title, uploader };
    }

    return { quality: 'approximate', score, title, uploader };
}

function killProcessGroup(proc, signal = 'SIGKILL') {
    if (!proc || !proc.pid) return;
    try {
        if (process.platform !== 'win32') {
            process.kill(-proc.pid, signal);
        } else {
            proc.kill(signal);
        }
    } catch {
        try { proc.kill(signal); } catch { /* ignore */ }
    }
}

async function searchYouTubeCandidates(query, maxCandidates, signal, logger = Logger) {
    const stageTimer = startStage(logger, 'search');
    const searchTarget = `ytsearch${maxCandidates}:${query}`;
    const args = [
        '--ignore-config',
        '--dump-single-json', '--flat-playlist', '--skip-download', '--no-warnings',
        '--extractor-args', 'youtube:player_client=android,web',
        '--',
        searchTarget
    ];

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            stageTimer.end('failed', { code: 'CANCELLED' });
            return reject(new AppError('CANCELLED'));
        }
        const ytdlp = spawn('yt-dlp', args, {
            detached: process.platform !== 'win32',
            windowsHide: true
        });
        let output = '';
        let outputBytes = 0;
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            killProcessGroup(ytdlp, 'SIGKILL');
        }, 30000);
        const onAbort = () => killProcessGroup(ytdlp, 'SIGKILL');
        signal?.addEventListener('abort', onAbort, { once: true });
        ytdlp.stdout.on('data', chunk => {
            outputBytes += chunk.length;
            if (outputBytes > 2 * 1024 * 1024) killProcessGroup(ytdlp, 'SIGKILL');
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


async function findSpotifyCandidates(track, signal, logger = Logger, excludedVideoIds = new Set()) {
    const MATCH_THRESHOLD = 0.58;       // Minimum confidence score required
    const MAX_SEARCH_QUERIES = 2;       // Maximum search query variations attempted per track
    const MAX_CANDIDATES_PER_QUERY = 5; // Maximum YouTube candidates fetched per search query

    const queries = generateSearchQueries(track, MAX_SEARCH_QUERIES);
    const collectedCandidates = [];
    const seenIds = new Set();

    const rankCollected = () => {
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
    };

    // Run the queries one after another: each one is a yt-dlp process, and when the first
    // already finds a near-certain match the second is pure CPU waste.
    let filtered = [];
    for (let i = 0; i < queries.length; i++) {
        const entries = await searchYouTubeCandidates(queries[i], MAX_CANDIDATES_PER_QUERY, signal, logger);

        if (i === 0) {
            const q1Ranked = rankCandidates(track, entries, { threshold: MATCH_THRESHOLD });
            const q1BestScore = q1Ranked[0]?.score ?? 0;
            logger.info(`[Spotify search] First query "${sanitizeAsciiHeader(queries[0])}" best score: ${(q1BestScore * 100).toFixed(0)}%`);
        }

        for (const entry of entries) {
            const id = entry?.id || entry?.url;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                collectedCandidates.push(entry);
            }
        }

        filtered = rankCollected();
        if (filtered[0] && filtered[0].score >= SPOTIFY_SEARCH_EARLY_EXIT_SCORE) {
            if (i < queries.length - 1) logger.info(`[Spotify search] Strong match after query ${i + 1}, skipping ${queries.length - 1 - i} more`);
            break;
        }
    }

    return filtered;
}

// Background matching. The link is inspected well before the person taps Download, so start the
// yt-dlp search then; by the time the download starts the match is already in the cache.
const prewarmInflight = new Map();
const prewarmSemaphore = new Semaphore(SPOTIFY_PREWARM_CONCURRENCY);
const PREWARM_MAX_PENDING = 24;

function spotifyTrackKey(track) {
    return String(track?.id || track?.uri || '');
}

function prewarmSpotifyMatches(tracks, logger = Logger) {
    if (!SPOTIFY_PREWARM_MAX_TRACKS || !Array.isArray(tracks)) return;
    // never compete with real downloads when the server is already saturated
    if (downloadQueue.running >= downloadQueue.concurrency) return;

    for (const track of tracks.slice(0, SPOTIFY_PREWARM_MAX_TRACKS)) {
        const key = spotifyTrackKey(track);
        if (!key || prewarmInflight.has(key) || spotifyMatchCache.get(key)) continue;
        if (prewarmInflight.size >= PREWARM_MAX_PENDING) break;

        const controller = new AbortController();
        const task = (async () => {
            await prewarmSemaphore.acquire(controller.signal);
            try {
                const candidates = await findSpotifyCandidates(track, controller.signal, logger);
                if (candidates[0]?.score >= 0.9) {
                    spotifyMatchCache.set(key, candidates[0]);
                    logger.info(`[Prewarm] Matched ${sanitizeAsciiHeader(track.title)} -> ${sanitizeAsciiHeader(candidates[0].matchedTitle || '')}`);
                }
            } finally {
                prewarmSemaphore.release();
            }
        })()
            .catch(err => logger.warn(`[Prewarm] Skipped ${sanitizeAsciiHeader(track?.title || '')}: ${err.message}`))
            .finally(() => prewarmInflight.delete(key));
        prewarmInflight.set(key, { task, controller });
    }
}

function cancelAllPrewarms() {
    for (const item of prewarmInflight.values()) {
        try { item.controller.abort(); } catch { /* already aborted */ }
    }
    prewarmInflight.clear();
}

if (typeof downloadQueue.onShutdown === 'function') {
    downloadQueue.onShutdown(() => cancelAllPrewarms());
}

// let a real download wait for an in-flight prewarm of the same track instead of searching twice
async function awaitPrewarm(track, signal) {
    const item = prewarmInflight.get(spotifyTrackKey(track));
    if (!item) return;
    if (signal?.aborted) {
        item.controller.abort();
        throw new AppError('CANCELLED');
    }
    await new Promise((resolve, reject) => {
        const onAbort = () => {
            item.controller.abort();
            reject(new AppError('CANCELLED'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        item.task.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        });
    });
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
            '--ignore-config',
            '--flat-playlist',
            '--print', '%(playlist_title)s:::%(id)s:::%(title)s:::%(uploader)s',
            '--ignore-errors',
            '--no-abort-on-error',
            '--no-warnings',
            '--playlist-end', String(MAX_PLAYLIST_TRACKS),
            '--extractor-args', 'youtube:player_client=android,web',
            '--',
            url
        ];

        const ytdlp = spawn('yt-dlp', ytdlpArgs, {
            detached: process.platform !== 'win32',
            windowsHide: true
        });
        let output = '';
        let timedOut = false;

        const timeout = setTimeout(() => {
            timedOut = true;
            killProcessGroup(ytdlp, 'SIGKILL');
        }, 30000);
        const onAbort = () => killProcessGroup(ytdlp, 'SIGKILL');
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });

        let outputBytes = 0;
        ytdlp.stdout.on('data', (data) => {
            outputBytes += data.length;
            if (outputBytes > MAX_PLAYLIST_OUTPUT_BYTES) {
                killProcessGroup(ytdlp, 'SIGKILL');
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

// download the raw audio stream to a temp file using yt-dlp
async function downloadToTemp(targetUrl, extension = 'webm', signal, targetFormat, onProgress, logger = Logger, cookiePathOverride = null) {
    const stageTimer = startStage(logger, 'download');
    await ytdlpSemaphore.acquire(signal);

    const ytId = getYouTubeVideoId(targetUrl);
    const canonicalTarget = ytId ? `https://www.youtube.com/watch?v=${ytId}` : targetUrl;

    try {
        const maxAttempts = !cookiePathOverride ? 2 : 1;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (signal?.aborted) throw new AppError('CANCELLED');
            const tempPath = path.join(WORK_DIR, `ripcord_${randomUUID()}.${extension}`);

            try {
                return await new Promise((resolve, reject) => {
                    const formatSelector = targetFormat === 'ogg'
                        ? 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio/best'
                        : targetFormat === 'm4a'
                            ? 'bestaudio[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio/best'
                            : 'bestaudio/best';
                    const ytdlpArgs = [
                        '--ignore-config',
                        '-f', formatSelector,
                        '--no-playlist',
                        '--no-warnings',
                        '--max-filesize', `${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))}M`,
                        '--concurrent-fragments', String(YTDLP_CONCURRENT_FRAGMENTS),
                        '--print', 'before_dl:RIPCORD_INFO %(format_id)s'
                    ];

                    let chosenClient = 'visionos,android,web';
                    if (cookiePathOverride) {
                        chosenClient = YTDLP_AUTHED_CLIENTS;
                        ytdlpArgs.push('--cookies', cookiePathOverride);
                        ytdlpArgs.push('--js-runtimes', 'node');
                        ytdlpArgs.push('--extractor-args', `youtube:player_client=${chosenClient}`);
                        logger.info(`Age-gate cookie retry using authed player client(s) [${chosenClient}]`);
                    } else {
                        ytdlpArgs.push('--extractor-args', `youtube:player_client=${chosenClient}`);
                    }

                    if (YTDLP_USE_ARIA2C && aria2cAvailable) ytdlpArgs.push('--downloader', 'aria2c');

                    if (onProgress) {
                        ytdlpArgs.push('--newline', '--progress', '--progress-template',
                            'download:RIPCORD_PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s');
                    }

                    ytdlpArgs.push('-o', tempPath, '--', canonicalTarget);

                    const ytdlp = spawn('yt-dlp', ytdlpArgs, {
                        detached: process.platform !== 'win32',
                        windowsHide: true
                    });
                    let detectedFormatId = 'unknown';
                    let detectedClient = chosenClient;

                    ytdlp.stdout.on('data', chunk => {
                        const text = chunk.toString();
                        const infoMatch = text.match(/RIPCORD_INFO\s+(\S+)/);
                        if (infoMatch) detectedFormatId = infoMatch[1];
                        if (!onProgress) return;
                        const matches = [...text.matchAll(/RIPCORD_PROGRESS (\d+) (\d+(?:\.\d+)?)/g)];
                        const last = matches[matches.length - 1];
                        if (last && Number(last[2]) > 0) onProgress(Math.min(1, Number(last[1]) / Number(last[2])));
                    });
                    let timedOut = false;

                    const timeout = setTimeout(() => {
                        timedOut = true;
                        killProcessGroup(ytdlp, 'SIGKILL');
                    }, 90000);
                    const onAbort = () => killProcessGroup(ytdlp, 'SIGKILL');
                    if (signal?.aborted) onAbort();
                    else signal?.addEventListener('abort', onAbort, { once: true });

                    let stderr = '';
                    ytdlp.stderr.on('data', (data) => {
                        const text = data.toString();
                        stderr = (stderr + text).slice(-8000);
                        const clientMatch = text.match(/Downloading\s+(\w+)\s+player API JSON/i);
                        if (clientMatch) detectedClient = clientMatch[1];
                        logger.warn(`yt-dlp: ${text.trim()}`);
                    });

                    ytdlp.on('close', (code) => {
                        clearTimeout(timeout);
                        signal?.removeEventListener('abort', onAbort);
                        if (signal?.aborted) {
                            cleanupFiles([tempPath]);
                            reject(new AppError('CANCELLED'));
                        } else if (timedOut) {
                            cleanupFiles([tempPath]);
                            reject(new AppError('TIMEOUT', { userMessage: 'Audio download timed out.' }));
                        } else if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size <= MAX_DOWNLOAD_BYTES) {
                            downloadMetaMap.set(tempPath, { formatId: detectedFormatId, client: detectedClient });
                            stageTimer.end('ok');
                            resolve(tempPath);
                        } else {
                            cleanupFiles([tempPath]);
                            const err = new Error('yt-dlp was unable to extract this audio source.');
                            err.stderr = stderr;
                            err.exitCode = code;
                            const appErr = classifyError(err, stderr);
                            reject(appErr);
                        }
                    });

                    ytdlp.on('error', (err) => {
                        clearTimeout(timeout);
                        signal?.removeEventListener('abort', onAbort);
                        cleanupFiles([tempPath]);
                        err.stderr = stderr;
                        const appErr = classifyError(err, stderr);
                        reject(appErr);
                    });
                });
            } catch (err) {
                lastError = err;
                if (signal?.aborted) throw err;
                const isTransientCdnError = /http error 403: forbidden|unable to download video data/i.test(err?.stderr || '') || err?.code === 'RATE_LIMITED';
                if (attempt < maxAttempts && isTransientCdnError) {
                    logger.warn(`Transient YouTube CDN error on download (attempt ${attempt}/${maxAttempts}), retrying in 1s...`);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                throw err;
            }
        }
        throw lastError;
    } catch (err) {
        stageTimer.end('failed', { code: err?.code || 'INTERNAL' });
        throw err;
    } finally {
        ytdlpSemaphore.release();
    }
}

async function downloadSpotifyAudioWithFallback({
    track,
    audioFormat,
    signal,
    onProgress,
    logger = Logger,
    jobExcludedVideoIds = new Set(),
    onNote = null,
    onMatched = null,
    candidatesOverride = null,
    clientIp = '127.0.0.1'
}) {
    const spotifyTrackId = track?.id || track?.uri || '';
    let candidates = candidatesOverride;

    if (!candidates || candidates.length === 0) {
        if (spotifyTrackId) {
            await awaitPrewarm(track, signal);
            const cached = spotifyMatchCache.get(spotifyTrackId);
            if (cached && !jobExcludedVideoIds.has(cached.videoId) && !ageRestrictedCache.has(cached.videoId)) {
                logger.info(`[Spotify match cache hit] ${sanitizeAsciiHeader(track.title)} - ${sanitizeAsciiHeader(track.artist)} -> ${sanitizeAsciiHeader(cached.matchedTitle || '')} [${cached.videoId}] (confidence ${(cached.score * 100).toFixed(0)}%)`);
                candidates = [{
                    videoId: cached.videoId,
                    score: cached.score,
                    confidence: cached.confidence,
                    matchedTitle: cached.matchedTitle,
                    reasons: ['cached_match']
                }];
            }
        }

        if (!candidates || candidates.length === 0) {
            candidates = await findSpotifyCandidates(track, signal, logger, jobExcludedVideoIds);
            if (!candidates || candidates.length === 0) {
                throw new AppError('NO_MATCH', { userMessage: 'No search result matched the Spotify title, artist, and duration closely enough.' });
            }
            if (spotifyTrackId && candidates[0]?.score >= 0.9) {
                spotifyMatchCache.set(spotifyTrackId, candidates[0]);
            }
        }
    }

    if (!candidates || candidates.length === 0) {
        throw new AppError('NO_MATCH', { userMessage: 'No search result matched the Spotify title, artist, and duration closely enough.' });
    }

    onMatched?.(candidates[0]);
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

            if (spotifyTrackId && candidate.score >= 0.9) {
                spotifyMatchCache.set(spotifyTrackId, candidate);
            }

            return { tempAudioPath, candidate, alternateUsed: isAlternate };
        } catch (err) {
            lastError = err;
            const appErr = classifyError(err, err?.stderr || '');
            if (appErr.code === 'AGE_RESTRICTED' || appErr.code === 'UNAVAILABLE') {
                if (spotifyTrackId) spotifyMatchCache.invalidate(spotifyTrackId);
                spotifyMatchCache.invalidateByVideoId(candidate.videoId);
            }
            if (err?.code === 'AGE_RESTRICTED') {
                logger.warn(`Spotify age-gate fallback: candidate ${candidate.videoId} failed with AGE_RESTRICTED. Adding to 24h cache and job excluded set.`);
                ageRestrictedCache.add(candidate.videoId);
                jobExcludedVideoIds?.add(candidate.videoId);
                if (attempt + 1 < maxAttempts) {
                    continue; // try next candidate
                }
                break;
            }
            throw err;
        }
    }

    if (lastError?.code === 'AGE_RESTRICTED') {
        const topCandidate = candidates[0];
        if (cookieGuard.isEnabled()) {
            logger.info(`Spotify age-gate fallback: all non-cookie attempts failed; retrying top candidate [${topCandidate.videoId}] with cookie guard`);
            const guardResult = await cookieGuard.acquire({
                ip: clientIp,
                videoId: topCandidate.videoId,
                kind: 'spotify',
                signal,
                logger
            });
            if (guardResult.status === 'allow') {
                if (guardResult.fromCache && guardResult.tempAudioPath) {
                    return { tempAudioPath: guardResult.tempAudioPath, candidate: topCandidate, alternateUsed: false };
                } else if (guardResult.lease) {
                    try {
                        const candidateUrl = `https://www.youtube.com/watch?v=${topCandidate.videoId}`;
                        const tempAudioPath = await downloadToTemp(
                            candidateUrl,
                            audioFormat === 'm4a' ? 'm4a' : 'webm',
                            signal,
                            audioFormat,
                            onProgress,
                            logger,
                            guardResult.lease.cookiePath
                        );
                        guardResult.release(true, null, tempAudioPath);
                        return { tempAudioPath, candidate: topCandidate, alternateUsed: false };
                    } catch (cookieErr) {
                        guardResult.release(false, cookieErr);
                        throw cookieErr;
                    }
                }
            }
            throw lastError || new AppError('AGE_RESTRICTED');
        } else if (COOKIES_PATH) {
            logger.info(`Spotify age-gate fallback: all non-cookie attempts failed; retrying top candidate [${topCandidate.videoId}] with fallback cookies`);
            const candidateUrl = `https://www.youtube.com/watch?v=${topCandidate.videoId}`;
            const tempAudioPath = await downloadToTemp(
                candidateUrl,
                audioFormat === 'm4a' ? 'm4a' : 'webm',
                signal,
                audioFormat,
                onProgress,
                logger,
                COOKIES_PATH
            );
            return { tempAudioPath, candidate: topCandidate, alternateUsed: false };
        }
    }

    throw lastError || new AppError('AGE_RESTRICTED');
}

async function downloadPlaylistTrack(track, index, audioBitrate, audioFormat, signal, report = () => { }, logger = Logger, jobExcludedVideoIds = new Set(), clientIp = '127.0.0.1') {
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

        if (track.url && !track.candidates) {
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
                if (err?.code === 'AGE_RESTRICTED') {
                    if (cookieGuard.isEnabled()) {
                        trackLogger.info(`Track is age-restricted, acquiring cookie guard lease for automatic retry [videoId=${matchedVideoId || 'unknown'}]`);
                        const guardResult = await cookieGuard.acquire({
                            ip: clientIp,
                            videoId: matchedVideoId,
                            kind: 'collection',
                            signal,
                            logger: trackLogger
                        });
                        if (guardResult.status !== 'allow') {
                            const reason = guardResult.reason === 'CIRCUIT_BREAKER_OPEN'
                                ? 'circuit_open'
                                : (guardResult.reason && (guardResult.reason.includes('LIMIT') || guardResult.reason.includes('BUDGET') || guardResult.reason.includes('COOLDOWN'))
                                    ? 'budget_exhausted'
                                    : 'no_account');
                            throw new AppError('AGE_RESTRICTED', { detail: { reason } });
                        }
                        if (guardResult.fromCache && guardResult.tempAudioPath) {
                            tempAudioPath = guardResult.tempAudioPath;
                            tempFiles.push(tempAudioPath);
                        } else if (guardResult.lease) {
                            try {
                                tempAudioPath = await downloadToTemp(track.url, audioFormat === 'm4a' ? 'm4a' : 'webm', signal, audioFormat,
                                    fraction => report(index, { state: 'downloading', progress: fraction }), trackLogger, guardResult.lease.cookiePath);
                                tempFiles.push(tempAudioPath);
                                guardResult.release(true, null, tempAudioPath);
                            } catch (cookieErr) {
                                guardResult.release(false, cookieErr);
                                throw new AppError('AGE_RESTRICTED', { detail: { reason: 'rejected' } });
                            }
                        } else {
                            throw new AppError('AGE_RESTRICTED', { detail: { reason: 'no_account' } });
                        }
                    } else if (COOKIES_PATH) {
                        trackLogger.info('Track is age-restricted, retrying with fallback cookies');
                        tempAudioPath = await downloadToTemp(track.url, audioFormat === 'm4a' ? 'm4a' : 'webm', signal, audioFormat,
                            fraction => report(index, { state: 'downloading', progress: fraction }), trackLogger, COOKIES_PATH);
                        tempFiles.push(tempAudioPath);
                    } else {
                        throw new AppError('AGE_RESTRICTED', { detail: { reason: 'no_account' } });
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
                candidatesOverride: track.candidates || null,
                clientIp,
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
        if (appErr.code === 'CANCELLED' || signal?.aborted) {
            trackLogger.info(`Track download cancelled: [CANCELLED]`);
        } else {
            trackLogger.error(`Track failed: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - [${appErr.code}] ${appErr.message}`);
        }
        report(index, { state: 'failed', progress: 1, error: appErr.userMessage, code: appErr.code, detail: appErr.detail || null });
        cleanupFiles(tempFiles);
        return null;
    }
}

// convert one downloaded song so it can be added to the zip file
async function processPlaylistTrack(source, audioBitrate, audioFormat, signal, report = () => { }, logger = Logger, job = null) {
    const { track, index, title, artist, tempAudioPath, tempImgPath } = source;
    const trackLogger = logger.child({ trackIndex: index });
    const tempFiles = [tempAudioPath, tempImgPath].filter(Boolean);

    try {
        report(index, { state: 'encoding', progress: 0 });
        trackLogger.info(`Encoding track: ${sanitizeAsciiHeader(`${title} - ${artist}`)}`);
        const tempOutPath = path.join(WORK_DIR, `track_${randomUUID()}.${audioFormat}`);
        tempFiles.push(tempOutPath);

        const sourceCodec = await probeAudioCodec(tempAudioPath, trackLogger);
        const meta = downloadMetaMap.get(tempAudioPath) || {};
        const copyAudio = (audioFormat === 'ogg' && sourceCodec === 'opus') || (audioFormat === 'm4a' && sourceCodec === 'aac');
        if (!copyAudio && (audioFormat === 'm4a' || audioFormat === 'ogg')) {
            if (!job || !job.loggedCodecMismatch) {
                if (job) job.loggedCodecMismatch = true;
                const expectedCodec = audioFormat === 'm4a' ? 'aac' : 'opus';
                trackLogger.info(`Source audio codec '${sourceCodec || 'unknown'}' from format [${meta.formatId || 'unknown'}] via client [${meta.client || 'unknown'}] cannot be remuxed to ${audioFormat.toUpperCase()}; transcoding required (expected ${expectedCodec}).`);
            }
        }
        trackLogger.info(copyAudio
            ? `Remuxing ${sourceCodec} audio into [${audioFormat.toUpperCase()}]`
            : `Encoding ${sourceCodec || 'audio'} audio to [${audioFormat.toUpperCase()}] at ${audioBitrate} kbps`);
        const args = ffmpegEncodeArgs(tempAudioPath, tempOutPath, audioFormat, audioBitrate, tempImgPath, title, artist, zipTrackLimit(audioFormat), copyAudio);
        await runFfmpeg(args, 'Track encoding timed out.', signal, trackLogger);
        if (signal?.aborted) throw new AppError('CANCELLED');
        const postEncodeSize = fs.statSync(tempOutPath).size;
        const trackLimit = zipTrackLimit(audioFormat);
        if (postEncodeSize >= trackLimit) {
            throw new AppError('TOO_LARGE', {
                userMessage: 'Playlist track exceeds the allowed size.',
                detail: { limitBytes: trackLimit, actualBytes: postEncodeSize }
            });
        }

        if (tempImgPath && fs.existsSync(tempOutPath) && audioFormat === 'ogg') {
            await injectVorbisCoverArt(tempOutPath, tempImgPath, audioFormat, trackLogger);
        }

        const finalSize = fs.statSync(tempOutPath).size;
        if (finalSize > trackLimit) {
            throw new AppError('TOO_LARGE', {
                userMessage: 'Playlist track exceeds the allowed size.',
                detail: { limitBytes: trackLimit, actualBytes: finalSize }
            });
        }
        const safeName = sanitizeFilename(`${String(index + 1).padStart(2, '0')} - ${title} - ${artist}.${audioFormat}`);

        cleanupFiles(tempFiles.filter(file => file !== tempOutPath));
        report(index, { state: 'done', progress: 1 });
        return { name: safeName, filePath: tempOutPath };

    } catch (err) {
        const appErr = classifyError(err, err?.stderr || '');
        if (appErr.code === 'CANCELLED' || signal?.aborted) {
            trackLogger.info(`Track encode cancelled: [CANCELLED]`);
        } else {
            trackLogger.error(`Track encode failed: ${sanitizeAsciiHeader(String(track.title || 'Unknown Track'))} - [${appErr.code}] ${appErr.message}`);
        }
        report(index, { state: 'failed', progress: 1, error: appErr.userMessage, code: appErr.code, detail: appErr.detail || null });
        cleanupFiles(tempFiles);
        return null;
    }
}

async function processAndStreamAudio(target, bitrate, format, thumbnailUrl, res, filename = '', artist = '', signal, _req = null, logger = Logger, isTempFile = false) {
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
            const videoId = getYouTubeVideoId(target);
            const clientIp = _req?.ip || _req?.socket?.remoteAddress || '127.0.0.1';
            let skipDirect = false;

            if (videoId && ageRestrictedCache.has(videoId)) {
                logger.info(`Track [${videoId}] is in age-restricted cache; skipping unauthenticated download attempt`);
                skipDirect = true;
            }

            if (!skipDirect) {
                logger.info('Downloading validated audio source');
                try {
                    tempAudioPath = await downloadToTemp(target, format === 'm4a' ? 'm4a' : 'webm', signal, format, undefined, logger);
                    tempFiles.push(tempAudioPath);
                } catch (err) {
                    if (err?.code === 'AGE_RESTRICTED') {
                        if (videoId) ageRestrictedCache.add(videoId);
                    } else {
                        throw err;
                    }
                }
            }

            if (!tempAudioPath) {
                if (cookieGuard.isEnabled()) {
                    logger.info(`Track is age-restricted, acquiring cookie guard lease for automatic retry [videoId=${videoId || 'unknown'}]`);
                    const guardResult = await cookieGuard.acquire({
                        ip: clientIp,
                        videoId,
                        kind: 'single',
                        signal,
                        logger
                    });

                    if (guardResult.status !== 'allow') {
                        throw new AppError('AGE_RESTRICTED');
                    }

                    if (guardResult.fromCache && guardResult.tempAudioPath) {
                        tempAudioPath = guardResult.tempAudioPath;
                        tempFiles.push(tempAudioPath);
                    } else if (guardResult.lease) {
                        try {
                            tempAudioPath = await downloadToTemp(target, format === 'm4a' ? 'm4a' : 'webm', signal, format, undefined, logger, guardResult.lease.cookiePath);
                            tempFiles.push(tempAudioPath);
                            guardResult.release(true, null, tempAudioPath);
                        } catch (cookieErr) {
                            guardResult.release(false, cookieErr);
                            throw cookieErr;
                        }
                    } else {
                        throw new AppError('AGE_RESTRICTED');
                    }
                } else if (COOKIES_PATH) {
                    logger.info('Track is age-restricted, retrying with fallback cookies');
                    tempAudioPath = await downloadToTemp(target, format === 'm4a' ? 'm4a' : 'webm', signal, format, undefined, logger, COOKIES_PATH);
                    tempFiles.push(tempAudioPath);
                } else {
                    throw new AppError('AGE_RESTRICTED');
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
        const meta = downloadMetaMap.get(tempAudioPath) || {};
        const copyAudio = (format === 'ogg' && sourceCodec === 'opus') || (format === 'm4a' && sourceCodec === 'aac');
        if (!copyAudio && (format === 'm4a' || format === 'ogg')) {
            const expectedCodec = format === 'm4a' ? 'aac' : 'opus';
            logger.info(`Source audio codec '${sourceCodec || 'unknown'}' from format [${meta.formatId || 'unknown'}] via client [${meta.client || 'unknown'}] cannot be remuxed to ${format.toUpperCase()}; transcoding required (expected ${expectedCodec}).`);
        }
        logger.info(copyAudio
            ? `Remuxing ${sourceCodec} audio into [${format.toUpperCase()}]`
            : `Encoding ${sourceCodec || 'audio'} audio to [${format.toUpperCase()}] at ${bitrate} kbps`);
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

        const onStreamDone = () => {
            res.removeListener('close', onDisconnect);
            cleanupFiles(tempFiles);
        };
        readStream.on('end', onStreamDone);
        readStream.on('close', onStreamDone);
    } catch (err) {
        res.removeListener('close', onDisconnect);
        cleanupFiles(tempFiles);
        throw err;
    }
}

module.exports = {
    YOUTUBE_HOSTS,
    SPOTIFY_HOSTS,
    isSafeUrl,
    extractSingleVideoId,
    getYouTubeVideoId,
    isYouTubeUrl,
    normalizeYouTubeUrl,
    isYouTubePlaylist,
    parseYouTubeCandidate,
    matchTokens,
    tokenSimilarity,
    calculateDurationScore,
    containsPhrase,
    scoreTitle,
    scoreArtist,
    evaluateVersionCompatibility,
    scoreSpotifyCandidate,
    classifyMatch,
    generateSearchQueries,
    rankCandidates,
    killProcessGroup,
    searchYouTubeCandidates,
    AgeGateLruCache,
    ageRestrictedCache,
    findSpotifyCandidates,
    prewarmSpotifyMatches,
    awaitPrewarm,
    cancelAllPrewarms,
    findSpotifyMatch,
    getYoutubeInfo,
    getYoutubePlaylistData,
    downloadToTemp,
    downloadSpotifyAudioWithFallback,
    downloadPlaylistTrack,
    processPlaylistTrack,
    processAndStreamAudio
};

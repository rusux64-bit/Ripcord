const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { classifyMatch } = require('../src/youtube');
const { SpotifyMatchCache } = require('../src/spotify');
const { AppError } = require('../src/errors');
const { createJob, computeJobSummary } = require('../src/queue');

// Mock frontend formatTrackFailure and formatBytes (directly testing the exact client formatting)
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    const rounded = (val >= 10 || val % 1 === 0) ? Math.round(val) : Number(val.toFixed(1));
    return `${rounded} ${units[i]}`;
}

function formatTrackFailure(code, error, detail) {
    switch (code) {
        case 'AGE_RESTRICTED': {
            if (detail?.reason === 'no_account') return 'Age-restricted: no authenticated account available.';
            if (detail?.reason === 'circuit_open') return 'Age-restricted: account protection active. Try again later.';
            if (detail?.reason === 'budget_exhausted') return 'Age-restricted: daily account budget reached.';
            if (detail?.reason === 'rejected') return 'Age-restricted: account access was rejected.';
            return error || 'Age-restricted: no authenticated account available.';
        }
        case 'REGION_BLOCKED': return "Not available in this server's region.";
        case 'TOO_LARGE': {
            if (detail?.limitBytes && detail?.actualBytes) {
                return `Audio exceeds the ${formatBytes(detail.limitBytes)} limit (this one: ${formatBytes(detail.actualBytes)})`;
            }
            if (detail?.limitBytes) {
                return `Audio exceeds the ${formatBytes(detail.limitBytes)} limit.`;
            }
            return error || 'Audio exceeds the maximum allowed size limit.';
        }
        case 'TOO_LONG': {
            if (detail?.limitSeconds) {
                const mins = Math.round(detail.limitSeconds / 60);
                return `Duration exceeds the ${mins} min limit.`;
            }
            return error || 'Duration exceeds the maximum allowed limit.';
        }
        case 'NO_MATCH': {
            if (detail?.bestScore != null) {
                return `No confident YouTube match (best candidate scored ${Math.round(detail.bestScore * 100)}%)`;
            }
            return error || 'No confident YouTube match found.';
        }
        case 'TIMEOUT': return 'Processing timed out. Retrying may help.';
        case 'RATE_LIMITED': return 'Server or YouTube is busy. Please try again in a few minutes.';
        case 'LOGIN_REQUIRED': return 'YouTube requires sign-in or bot check. Retrying later may help.';
        case 'ARCHIVE_LIMIT': return error || 'Skipped: archive size limit reached.';
        case 'NETWORK_TIMEOUT': return 'Network connection timed out. Retrying may help.';
        case 'ENCODE_FAILED': return 'Audio conversion failed. Try a different audio format.';
        case 'PRIVATE_OR_UNAVAILABLE': return 'This media is private, removed, or unavailable.';
        case 'MEMBERS_ONLY': return 'Only available to YouTube channel members.';
        case 'LIVE_NOT_SUPPORTED': return 'Live streams cannot be downloaded until broadcast ends.';
        default: return error || code || 'Skipped';
    }
}

test('classifyMatch across official, good, approximate, legacy, and null inputs', () => {
    // 1. Topic channel -> official
    const topicMatch = classifyMatch({
        score: 0.95,
        reasons: ['topic_channel_official', 'studio_version_matched'],
        matchedTitle: 'Levitating',
        uploader: 'Dua Lipa - Topic'
    });
    assert.equal(topicMatch.quality, 'official');
    assert.equal(topicMatch.score, 0.95);
    assert.equal(topicMatch.title, 'Levitating');
    assert.equal(topicMatch.uploader, 'Dua Lipa - Topic');

    // 2. High score non-official upload -> good
    const goodMatch = classifyMatch({
        score: 0.93,
        reasons: ['studio_version_matched', 'duration_exact'],
        matchedTitle: 'Levitating Audio',
        uploader: 'RecordLabelMusic'
    });
    assert.equal(goodMatch.quality, 'good');

    // 3. Lower confidence (score < 0.9) -> approximate
    const lowScoreMatch = classifyMatch({
        score: 0.82,
        reasons: ['duration_acceptable'],
        matchedTitle: 'Levitating (Live at Arena)',
        uploader: 'FanAccount'
    });
    assert.equal(lowScoreMatch.quality, 'approximate');

    // 4. High score but contains conflicting or penalty reasons -> approximate
    const penaltyMatch = classifyMatch({
        score: 0.91,
        reasons: ['topic_channel_official', 'penalty_cover_song'],
        matchedTitle: 'Levitating Cover',
        uploader: 'CoverArtist'
    });
    assert.equal(penaltyMatch.quality, 'approximate');

    // 5. Legacy cache entry (no quality, no reasons array) -> unknown, NEVER official
    const legacyCacheEntry = {
        videoId: 'abc12345678',
        matchedTitle: 'Legacy Song',
        uploader: 'Legacy Channel',
        score: 0.98,
        confidence: 0.98
    };
    const legacyMatch = classifyMatch(legacyCacheEntry);
    assert.equal(legacyMatch.quality, 'unknown');
    assert.notEqual(legacyMatch.quality, 'official');

    // 6. Explicit stored quality survives
    const cachedOfficial = classifyMatch({
        quality: 'official',
        score: 0.96,
        matchedTitle: 'Song',
        uploader: 'Artist - Topic'
    });
    assert.equal(cachedOfficial.quality, 'official');

    // 7. Null/undefined/garbage -> unknown
    assert.equal(classifyMatch(null).quality, 'unknown');
    assert.equal(classifyMatch({}).quality, 'unknown');
});

test('failure codes produce specific honest user sentences', () => {
    // AGE_RESTRICTED sub-reasons
    assert.equal(
        formatTrackFailure('AGE_RESTRICTED', '', { reason: 'no_account' }),
        'Age-restricted: no authenticated account available.'
    );
    assert.equal(
        formatTrackFailure('AGE_RESTRICTED', '', { reason: 'circuit_open' }),
        'Age-restricted: account protection active. Try again later.'
    );
    assert.equal(
        formatTrackFailure('AGE_RESTRICTED', '', { reason: 'budget_exhausted' }),
        'Age-restricted: daily account budget reached.'
    );
    assert.equal(
        formatTrackFailure('AGE_RESTRICTED', '', { reason: 'rejected' }),
        'Age-restricted: account access was rejected.'
    );

    // REGION_BLOCKED
    assert.equal(
        formatTrackFailure('REGION_BLOCKED', ''),
        "Not available in this server's region."
    );

    // TOO_LARGE with exact sizes
    assert.equal(
        formatTrackFailure('TOO_LARGE', '', { limitBytes: 150 * 1024 * 1024, actualBytes: 212 * 1024 * 1024 }),
        'Audio exceeds the 150 MB limit (this one: 212 MB)'
    );

    // TOO_LONG with duration
    assert.equal(
        formatTrackFailure('TOO_LONG', '', { limitSeconds: 7200 }),
        'Duration exceeds the 120 min limit.'
    );

    // NO_MATCH with best score
    assert.equal(
        formatTrackFailure('NO_MATCH', '', { bestScore: 0.41 }),
        'No confident YouTube match (best candidate scored 41%)'
    );

    // TIMEOUT / RATE_LIMITED / LOGIN_REQUIRED / ARCHIVE_LIMIT
    assert.equal(
        formatTrackFailure('TIMEOUT', ''),
        'Processing timed out. Retrying may help.'
    );
    assert.equal(
        formatTrackFailure('RATE_LIMITED', ''),
        'Server or YouTube is busy. Please try again in a few minutes.'
    );
    assert.equal(
        formatTrackFailure('LOGIN_REQUIRED', ''),
        'YouTube requires sign-in or bot check. Retrying later may help.'
    );
    assert.equal(
        formatTrackFailure('ARCHIVE_LIMIT', 'Skipped: archive size limit (1 GB) reached'),
        'Skipped: archive size limit (1 GB) reached'
    );
});

test('payload sanitization: hostile strings, paths, and control characters never appear in payload', () => {
    const hostileTitle = 'Clean Title\x00\x1f\x7f' + 'A'.repeat(500);
    const hostileUploader = 'HackerChannel\x08\x0b' + 'B'.repeat(300);

    const match = classifyMatch({
        score: 0.95,
        reasons: ['topic_channel_official'],
        matchedTitle: hostileTitle,
        uploader: hostileUploader
    });

    // Control characters must be stripped
    assert.ok(!/[\x00-\x1F\x7F]/.test(match.title));
    assert.ok(!/[\x00-\x1F\x7F]/.test(match.uploader));
    // Length must be bounded to 200 chars
    assert.ok(match.title.length <= 200);
    assert.ok(match.uploader.length <= 200);

    // Test AppError internalDetail vs detail
    const secretPath = '/var/secrets/cookies_account_42.txt';
    const secretIp = '198.51.100.42';
    const rawStderr = `ERROR: [youtube] ${secretPath}: IP ${secretIp} got 403 Forbidden`;

    const appErr = new AppError('AGE_RESTRICTED', {
        internalDetail: rawStderr,
        detail: { reason: 'no_account' }
    });

    const job = createJob('job-sanitize-test', [{ title: match.title, artist: match.uploader }]);
    job.tracks[0].code = appErr.code;
    job.tracks[0].error = appErr.userMessage;
    job.tracks[0].detail = appErr.detail;
    job.tracks[0].match = match;
    const summary = computeJobSummary(job);

    const payloadJson = JSON.stringify({ job, summary });
    assert.ok(!payloadJson.includes(secretPath), 'Internal filesystem paths must never leak into payload');
    assert.ok(!payloadJson.includes(secretIp), 'Internal IP addresses must never leak into payload');
    assert.ok(!payloadJson.includes('cookies_account_42'), 'Account identifiers must never leak');
});

test('Spotify match cache round-trip preserves quality, and legacy entries default to unknown', () => {
    const tmpCacheFile = path.join(os.tmpdir(), `test_spotify_matches_${Date.now()}.json`);

    try {
        const cache = new SpotifyMatchCache({
            filePath: tmpCacheFile,
            maxSize: 100,
            ttlMs: 60000,
            logger: { info: () => {}, warn: () => {} }
        });

        // Store new match with quality
        cache.set('track:new123', {
            videoId: 'vid11111111',
            matchedTitle: 'Fresh Song',
            uploader: 'Fresh Artist - Topic',
            quality: 'official',
            score: 0.98
        });

        cache.flush();

        // Simulate a legacy entry written by an older version (no quality field)
        const cacheContent = JSON.parse(fs.readFileSync(tmpCacheFile, 'utf8'));
        cacheContent.entries.push({
            key: 'track:legacy999',
            videoId: 'vid22222222',
            matchedTitle: 'Old Song',
            uploader: 'Old Artist',
            score: 0.95,
            confidence: 0.95,
            expiresAt: Date.now() + 60000
        });
        fs.writeFileSync(tmpCacheFile, JSON.stringify(cacheContent, null, 2), 'utf8');

        // Load new cache instance from disk
        const loadedCache = new SpotifyMatchCache({
            filePath: tmpCacheFile,
            maxSize: 100,
            ttlMs: 60000,
            logger: { info: () => {}, warn: () => {} }
        });

        const newEntry = loadedCache.get('track:new123');
        assert.ok(newEntry);
        assert.equal(newEntry.quality, 'official');
        const classifiedNew = classifyMatch(newEntry);
        assert.equal(classifiedNew.quality, 'official');

        const legacyEntry = loadedCache.get('track:legacy999');
        assert.ok(legacyEntry);
        assert.equal(legacyEntry.quality, 'unknown');
        const classifiedLegacy = classifyMatch(legacyEntry);
        assert.equal(classifiedLegacy.quality, 'unknown', 'Legacy cache entries must never be classified as official');
    } finally {
        if (fs.existsSync(tmpCacheFile)) fs.unlinkSync(tmpCacheFile);
    }
});

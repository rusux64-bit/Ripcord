const { randomUUID } = require('crypto');

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
        test: (combined, err) => err?.name === 'AbortError' || err?.code === 'ERR_CANCELED' || err?.code === 'CANCELLED' || /request cancelled|request aborted|abort\(|aborted/i.test(combined)
    },
    {
        code: 'RATE_LIMITED',
        test: (combined, err) => err?.status === 429 || err?.response?.status === 429 || /http error 429|too many requests|rate limit|http error 403: forbidden|unable to download video data.*(?:403|forbidden)/i.test(combined)
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

module.exports = {
    ERROR_DEFINITIONS,
    AppError,
    CLASSIFIER_RULES,
    classifyError,
    sendError
};

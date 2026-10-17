/**
 * Ripcord Server Entrypoint
 */

const config = require('./src/config');
const logger = require('./src/logger');
const errors = require('./src/errors');
const queue = require('./src/queue');
const cookies = require('./src/cookies');
const media = require('./src/media');
const spotify = require('./src/spotify');
const youtube = require('./src/youtube');
const routes = require('./src/routes');
const bootstrap = require('./src/bootstrap');

if (require.main === module) {
    bootstrap.startServer();
}

module.exports = {
    // Bootstrap & App
    app: bootstrap.app,
    startServer: bootstrap.startServer,
    getServerInstance: bootstrap.getServerInstance,
    gracefulShutdown: bootstrap.gracefulShutdown,
    sweepWorkDir: bootstrap.sweepWorkDir,
    cleanupStaleWorkFiles: bootstrap.cleanupStaleWorkFiles,

    // Config
    ...config,

    // Logger & Redaction
    StructuredLogger: logger.StructuredLogger,
    Logger: logger.Logger,
    redactLog: logger.redactLog,
    startStage: logger.startStage,
    safeMetadataText: logger.safeMetadataText,

    // Errors
    AppError: errors.AppError,
    ERROR_DEFINITIONS: errors.ERROR_DEFINITIONS,
    classifyError: errors.classifyError,
    sendError: errors.sendError,

    // Queue & Semaphores
    MetadataSemaphore: queue.MetadataSemaphore,
    Semaphore: queue.Semaphore,
    DownloadQueue: queue.DownloadQueue,
    downloadQueue: queue.downloadQueue,
    metadataSemaphore: queue.metadataSemaphore,
    ytdlpSemaphore: queue.ytdlpSemaphore,
    ffmpegSemaphore: queue.ffmpegSemaphore,
    AsyncBoundedQueue: queue.AsyncBoundedQueue,

    // Cookies
    AgeGateCookiePool: cookies.AgeGateCookiePool,
    ageGateCookiePool: cookies.ageGateCookiePool,

    // Media & Tagging
    downloadMetaMap: media.downloadMetaMap,
    sanitizeFilename: media.sanitizeFilename,
    sanitizeAsciiHeader: media.sanitizeAsciiHeader,
    buildContentDisposition: media.buildContentDisposition,
    cleanupFiles: media.cleanupFiles,
    parseCoverUrl: media.parseCoverUrl,
    resolveCoverFile: media.resolveCoverFile,
    cropToSquareJpeg: media.cropToSquareJpeg,
    ensureSquareCover: media.ensureSquareCover,
    probeAudioCodec: media.probeAudioCodec,
    ffmpegEncodeArgs: media.ffmpegEncodeArgs,
    runFfmpeg: media.runFfmpeg,
    injectVorbisCoverArt: media.injectVorbisCoverArt,
    tagAudioFile: media.tagAudioFile,
    encodeAudio: media.encodeAudio,
    fetchCoverBuffer: media.fetchCoverBuffer,
    fetchYouTubeThumbnailBuffer: media.fetchYouTubeThumbnailBuffer,

    // Spotify
    spotifyLinkDetails: spotify.spotifyLinkDetails,
    SpotifyCoverCache: spotify.SpotifyCoverCache,
    spotifyCoverCache: spotify.spotifyCoverCache,
    fetchSpotifyTrackCoverUrl: spotify.fetchSpotifyTrackCoverUrl,
    SpotifyMatchCache: spotify.SpotifyMatchCache,
    spotifyMatchCache: spotify.spotifyMatchCache,
    getSpotifyDurationMs: spotify.getSpotifyDurationMs,
    normalizeText: spotify.normalizeText,
    normalizeToAlphaNumeric: spotify.normalizeToAlphaNumeric,
    normalizeArtistName: spotify.normalizeArtistName,
    extractVersionInfo: spotify.extractVersionInfo,
    parseArtists: spotify.parseArtists,
    getSpotifyData: spotify.getSpotifyData,

    // YouTube
    YOUTUBE_HOSTS: youtube.YOUTUBE_HOSTS,
    SPOTIFY_HOSTS: youtube.SPOTIFY_HOSTS,
    isSafeUrl: youtube.isSafeUrl,
    extractSingleVideoId: youtube.extractSingleVideoId,
    getYouTubeVideoId: youtube.getYouTubeVideoId,
    isYouTubeUrl: youtube.isYouTubeUrl,
    normalizeYouTubeUrl: youtube.normalizeYouTubeUrl,
    isYouTubePlaylist: youtube.isYouTubePlaylist,
    parseYouTubeCandidate: youtube.parseYouTubeCandidate,
    matchTokens: youtube.matchTokens,
    tokenSimilarity: youtube.tokenSimilarity,
    calculateDurationScore: youtube.calculateDurationScore,
    containsPhrase: youtube.containsPhrase,
    scoreTitle: youtube.scoreTitle,
    scoreArtist: youtube.scoreArtist,
    evaluateVersionCompatibility: youtube.evaluateVersionCompatibility,
    scoreSpotifyCandidate: youtube.scoreSpotifyCandidate,
    generateSearchQueries: youtube.generateSearchQueries,
    rankCandidates: youtube.rankCandidates,
    searchYouTubeCandidates: youtube.searchYouTubeCandidates,
    AgeGateLruCache: youtube.AgeGateLruCache,
    ageRestrictedCache: youtube.ageRestrictedCache,
    findSpotifyCandidates: youtube.findSpotifyCandidates,
    findSpotifyMatch: youtube.findSpotifyMatch,
    getYoutubeInfo: youtube.getYoutubeInfo,
    getYoutubePlaylistData: youtube.getYoutubePlaylistData,
    downloadToTemp: youtube.downloadToTemp,
    downloadSpotifyAudioWithFallback: youtube.downloadSpotifyAudioWithFallback,
    downloadPlaylistTrack: youtube.downloadPlaylistTrack,
    processPlaylistTrack: youtube.processPlaylistTrack,
    processAndStreamAudio: youtube.processAndStreamAudio,

    // Routes & Jobs
    createRateLimiter: routes.createRateLimiter,
    rejectCrossSiteRequests: routes.rejectCrossSiteRequests,
    JOB_ID_PATTERN: routes.JOB_ID_PATTERN,
    MAX_TRACKED_JOBS: routes.MAX_TRACKED_JOBS,
    downloadJobs: routes.downloadJobs,
    computeJobSummary: routes.computeJobSummary,
    createJob: routes.createJob,
    endJob: routes.endJob,
    executeDownloadTask: routes.executeDownloadTask,
    registerRoutes: routes.registerRoutes
};

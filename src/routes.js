const path = require('path');
const { randomUUID } = require('crypto');
const { Transform } = require('stream');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const {
    RATE_LIMIT_WINDOW_MS,
    API_RATE_LIMIT_MAX,
    MAX_PLAYLIST_TRACKS,
    MAX_COVER_BYTES,
    PUBLIC_DIR,
    SPOTIFY_SEARCH_CONCURRENCY,
    DOWNLOAD_CONCURRENCY,
    ENCODE_CONCURRENCY,
    JOB_ID_PATTERN
} = require('./config');

const { Logger, startStage, safeMetadataText } = require('./logger');
const { AppError, classifyError, sendError } = require('./errors');
const { AsyncBoundedQueue, downloadQueue, metadataSemaphore } = require('./queue');
const {
    sanitizeFilename,
    buildContentDisposition,
    cleanupFiles,
    parseCoverUrl
} = require('./media');
const { spotifyLinkDetails, getSpotifyData } = require('./spotify');
const {
    isSafeUrl,
    isYouTubeUrl,
    normalizeYouTubeUrl,
    isYouTubePlaylist,
    getYouTubeVideoId,
    getYoutubeInfo,
    getYoutubePlaylistData,
    downloadSpotifyAudioWithFallback,
    downloadPlaylistTrack,
    processPlaylistTrack,
    processAndStreamAudio
} = require('./youtube');

function createRateLimiter(limit, message) {
    return rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => sendError(res, new AppError('RATE_LIMITED', { userMessage: message }), req)
    });
}

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

// per-track progress for collection downloads, keyed by a client-generated job id
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
            collectionData = await getYoutubePlaylistData(url, signal);
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
                const searchCapacity = Math.max(8, SPOTIFY_SEARCH_CONCURRENCY * 2);
                const searchHandoffQueue = new AsyncBoundedQueue(searchCapacity);
                const encodeHandoffQueue = new AsyncBoundedQueue(4);
                let nextSearchTrack = 0;

                const isSpotifyCollection = spotifyLink && spotifyLink.type !== 'track';

                const searchWorker = async () => {
                    while (!signal.aborted) {
                        const index = nextSearchTrack++;
                        if (index >= tracks.length) return;
                        const track = tracks[index];
                        report(index, { state: 'matching', progress: 0 });

                        if (!isSpotifyCollection) {
                            try {
                                await searchHandoffQueue.push({ track, index });
                            } catch {
                                return;
                            }
                            continue;
                        }

                        try {
                            const candidates = await require('./youtube').findSpotifyCandidates(track, signal, taskLogger, jobExcludedVideoIds);
                            if (candidates && candidates.length > 0) {
                                await searchHandoffQueue.push({ track: { ...track, candidates }, index });
                            } else {
                                report(index, { state: 'failed', error: 'No search result matched the Spotify title and artist.' });
                            }
                        } catch (searchErr) {
                            if (signal.aborted) return;
                            taskLogger.warn(`[track:${index + 1}] Search error: ${searchErr.message}`);
                            report(index, { state: 'failed', error: searchErr.message });
                        }
                    }
                };

                const downloadWorker = async () => {
                    while (!signal.aborted) {
                        const item = await searchHandoffQueue.shift();
                        if (!item) return;
                        const { track, index } = item;
                        const downloaded = await downloadPlaylistTrack(track, index, audioBitrate, audioFormat, signal, report, taskLogger, jobExcludedVideoIds);
                        if (!downloaded) continue;
                        try {
                            await encodeHandoffQueue.push(downloaded);
                        } catch {
                            cleanupFiles([downloaded.tempAudioPath, downloaded.tempImgPath]);
                            return;
                        }
                    }
                };

                const encodeWorker = async () => {
                    while (!signal.aborted) {
                        const downloaded = await encodeHandoffQueue.shift();
                        if (!downloaded) return;
                        const result = await processPlaylistTrack(downloaded, audioBitrate, audioFormat, signal, report, taskLogger, job);
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

                const searchWorkerCount = isSpotifyCollection
                    ? Math.min(SPOTIFY_SEARCH_CONCURRENCY, tracks.length)
                    : 1;
                const searchWorkers = Array.from({ length: searchWorkerCount }, () => searchWorker());
                const downloadWorkers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, () => downloadWorker());
                const encodeWorkers = Array.from({ length: ENCODE_CONCURRENCY }, () => encodeWorker());

                const searchPromise = Promise.all(searchWorkers).then(() => searchHandoffQueue.close());
                const downloadPromise = Promise.all(downloadWorkers).then(() => encodeHandoffQueue.close());
                const encodePromise = Promise.all(encodeWorkers);

                await Promise.all([searchPromise, downloadPromise, encodePromise]);

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
        if (appErr.code === 'CANCELLED' || signal.aborted || req?.destroyed) {
            taskLogger.info(`Download cancelled: [CANCELLED] Client cancelled or disconnected`);
        } else {
            taskLogger.error(`Queue execution error: [${appErr.code}] ${appErr.message}`);
        }
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

function registerRoutes(app) {
    app.use('/api', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    // polled about once a second, so it gets its own budget instead of the main API limit
    app.get('/api/progress/:id', createRateLimiter(Math.max(API_RATE_LIMIT_MAX * 20, 2000), 'Too many progress requests.'), rejectCrossSiteRequests, (req, res) => {
        const job = JOB_ID_PATTERN.test(req.params.id) ? downloadJobs.get(req.params.id) : null;
        if (!job) return res.status(404).json({ status: 'pending' });
        const summary = job.summary || computeJobSummary(job);
        res.json({ ...job, summary });
    });

    app.use('/api', createRateLimiter(API_RATE_LIMIT_MAX, 'Too many requests. Please wait before trying again.'));

    // health check route so uptime monitors know the server is running
    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    // inspect a link and return title, artist, and cover art
    app.get('/api/fetch-info', rejectCrossSiteRequests, async (req, res) => {
        const controller = new AbortController();
        let metadataAcquisition = null;
        res.once('close', () => {
            if (!res.writableEnded) {
                controller.abort();
                metadataAcquisition?.cancel();
            }
        });

        try {
            const rawUrl = req.query.url;
            if (!isSafeUrl(rawUrl)) {
                return sendError(res, new AppError('INVALID_URL', { userMessage: 'Please enter a valid Spotify or YouTube URL.' }), req);
            }
            const parsedUrl = new URL(rawUrl);
            parsedUrl.hash = '';
            const url = normalizeYouTubeUrl(parsedUrl.href);

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
                    const ytData = await getYoutubePlaylistData(url, controller.signal);
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
            if (appErr.code === 'CANCELLED' || controller.signal.aborted) {
                Logger.info(`Fetch info cancelled: [CANCELLED]`);
            } else {
                Logger.error(`Fetch info error: [${appErr.code}] ${appErr.message}`);
            }
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
}

module.exports = {
    createRateLimiter,
    rejectCrossSiteRequests,
    JOB_ID_PATTERN,
    MAX_TRACKED_JOBS,
    downloadJobs,
    computeJobSummary,
    createJob,
    endJob,
    executeDownloadTask,
    registerRoutes
};

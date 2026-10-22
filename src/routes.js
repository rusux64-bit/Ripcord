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

const { Logger, startStage, safeMetadataText, sanitizeAsciiHeader } = require('./logger');
const { AppError, classifyError, sendError } = require('./errors');
const {
    AsyncBoundedQueue,
    downloadQueue,
    metadataSemaphore,
    MAX_TRACKED_JOBS,
    downloadJobs,
    progressStreams,
    subscribeJob,
    notifyJob,
    computeJobSummary,
    createJob,
    endJob
} = require('./queue');
const {
    sanitizeFilename,
    buildContentDisposition,
    cleanupFiles,
    parseCoverUrl
} = require('./media');
const { spotifyLinkDetails, getSpotifyData, spotifyMatchCache } = require('./spotify');
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
    processAndStreamAudio,
    findSpotifyCandidates,
    prewarmSpotifyMatches,
    awaitPrewarm,
    ageRestrictedCache
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

// worker function that processes the actual download request
async function executeDownloadTask(url, audioBitrate, audioFormat, safeFilename, res, signal, jobId = null, customTitle = '', req = null) {
    const taskLogger = (req?.logger || Logger).child({ jobId: jobId || randomUUID() });
    const jobStartTime = Date.now();
    let job = null;
    const jobExcludedVideoIds = new Set();
    const report = (index, patch) => {
        if (job?.tracks[index]) {
            Object.assign(job.tracks[index], patch);
            job.summary = computeJobSummary(job);
            notifyJob(jobId);
        }
    };

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
            job = createJob(jobId, [track]);
            report(0, { state: 'matching', progress: 0 });
            const downloaded = await downloadSpotifyAudioWithFallback({
                track,
                audioFormat,
                signal,
                onProgress: job ? fraction => report(0, { state: 'downloading', progress: fraction }) : undefined,
                onMatched: () => report(0, { state: 'downloading', progress: 0 }),
                logger: taskLogger,
                jobExcludedVideoIds,
                clientIp: req?.ip || req?.socket?.remoteAddress || '127.0.0.1',
                onNote: (note) => {
                    res.setHeader('X-Ripcord-Note', note);
                }
            });
            report(0, { state: 'encoding', progress: 0 });
            await processAndStreamAudio(downloaded.tempAudioPath, audioBitrate, audioFormat, track.thumbnail, res, trackTitle, track.artist, signal, req, taskLogger, true);
            report(0, { state: 'done', progress: 1 });
            endJob(jobId, 'finished');
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
                            const spotifyTrackId = track.id || track.uri;
                            let matchedCandidates = null;

                            if (spotifyTrackId) {
                                await awaitPrewarm(track, signal);
                                const cached = spotifyMatchCache.get(spotifyTrackId);
                                if (cached && !jobExcludedVideoIds.has(cached.videoId) && !ageRestrictedCache.has(cached.videoId)) {
                                    taskLogger.info(`[Spotify match cache hit] [track:${index + 1}] ${sanitizeAsciiHeader(track.title)} - ${sanitizeAsciiHeader(track.artist)} -> ${sanitizeAsciiHeader(cached.matchedTitle || '')} [${cached.videoId}]`);
                                    matchedCandidates = [{
                                        videoId: cached.videoId,
                                        score: cached.score,
                                        confidence: cached.confidence,
                                        matchedTitle: cached.matchedTitle,
                                        reasons: ['cached_match']
                                    }];
                                }
                            }

                            if (!matchedCandidates) {
                                matchedCandidates = await findSpotifyCandidates(track, signal, taskLogger.child({ trackIndex: index }), jobExcludedVideoIds);
                                if (matchedCandidates && matchedCandidates.length > 0 && spotifyTrackId && matchedCandidates[0]?.score >= 0.9) {
                                    spotifyMatchCache.set(spotifyTrackId, matchedCandidates[0]);
                                }
                            }

                            if (!matchedCandidates || matchedCandidates.length === 0) {
                                taskLogger.warn(`[track:${index + 1}] No matching YouTube candidate found for Spotify track: ${sanitizeAsciiHeader(track.title)} - ${sanitizeAsciiHeader(track.artist)}`);
                                report(index, { state: 'failed', error: 'No YouTube match found.' });
                                continue;
                            }

                            await searchHandoffQueue.push({
                                track: {
                                    ...track,
                                    candidates: matchedCandidates,
                                    url: `https://www.youtube.com/watch?v=${matchedCandidates[0].videoId}`,
                                    videoId: matchedCandidates[0].videoId
                                },
                                index
                            });
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
                        const clientIp = req?.ip || req?.socket?.remoteAddress || '127.0.0.1';
                        const downloaded = await downloadPlaylistTrack(track, index, audioBitrate, audioFormat, signal, report, taskLogger, jobExcludedVideoIds, clientIp);
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
        if (job?.status === 'running') endJob(jobId, signal.aborted ? 'cancelled' : 'failed', appErr);
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
        const summary = computeJobSummary(job);
        res.json({ ...job, summary });
    });

    // push version of the poller: the same payload, sent the moment a job changes instead of once a second
    const MAX_PROGRESS_STREAMS = 200;
    const MAX_STREAM_LIFETIME_MS = 30 * 60 * 1000;
    app.get('/api/progress/:id/stream', createRateLimiter(Math.max(API_RATE_LIMIT_MAX, 120), 'Too many progress streams.'), rejectCrossSiteRequests, (req, res) => {
        const jobId = req.params.id;
        if (!JOB_ID_PATTERN.test(jobId) || progressStreams.size >= MAX_PROGRESS_STREAMS) {
            return res.status(JOB_ID_PATTERN.test(jobId) ? 503 : 404).end();
        }

        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        res.write('retry: 2000\n\n');
        progressStreams.add(res);

        let timer = null;
        let lastSent = 0;
        let closed = false;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            clearInterval(heartbeat);
            clearTimeout(lifetime);
            unsubscribe();
            progressStreams.delete(res);
        };
        const send = () => {
            timer = null;
            if (closed || res.destroyed) return;
            const job = downloadJobs.get(jobId);
            if (!job) return;
            lastSent = Date.now();
            res.write(`data: ${JSON.stringify({ ...job, summary: computeJobSummary(job) })}\n\n`);
            if (job.status !== 'running') {
                cleanup();
                res.end();
            }
        };
        // coalesce bursts (yt-dlp prints progress many times a second) into at most ~5 messages a second
        const onChange = () => {
            if (timer || closed) return;
            timer = setTimeout(send, Math.max(0, 200 - (Date.now() - lastSent)));
        };
        const unsubscribe = subscribeJob(jobId, onChange);
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15000);
        const lifetime = setTimeout(() => { cleanup(); res.end(); }, MAX_STREAM_LIFETIME_MS);
        res.once('close', cleanup);
        onChange();
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
                res.json({
                    type: 'track',
                    title: track.title,
                    artist: track.artist,
                    thumbnail: track.thumbnail,
                    url
                });
                prewarmSpotifyMatches([track], Logger);
                return;
            } else if (spotifyLinkDetails(url)) {
                const spotifyData = await getSpotifyData(url, controller.signal);
                res.json({
                    type: 'collection',
                    title: spotifyData.name,
                    trackCount: spotifyData.tracks.length,
                    tracks: spotifyData.tracks.map(t => ({ title: t.title, artist: t.artist === 'Unknown Artist' ? '' : t.artist })),
                    thumbnail: spotifyData.thumbnail,
                    url
                });
                prewarmSpotifyMatches(spotifyData.tracks, Logger);
                return;
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

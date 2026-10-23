const { DOWNLOAD_CONCURRENCY, METADATA_CONCURRENCY, MAX_QUEUED_DOWNLOADS, ENCODE_CONCURRENCY } = require('./config');
const { Logger } = require('./logger');
const { AppError, classifyError, sendError } = require('./errors');

// open /api/progress/:id/stream responses, so shutdown can end them instead of waiting on them
const progressStreams = new Set();

class DownloadQueue {
    constructor(concurrency = DOWNLOAD_CONCURRENCY, maxQueued = MAX_QUEUED_DOWNLOADS) {
        this.concurrency = concurrency;
        this.maxQueued = maxQueued;
        this.running = 0;
        this.queue = [];
        this.activeEntries = new Set();
        this.shutdownHooks = new Set();
        this.shuttingDown = false;
    }

    onShutdown(fn) {
        if (typeof fn === 'function') this.shutdownHooks.add(fn);
    }

    addTask(task, res, req = null) {
        if (this.shuttingDown) return false;
        if (this.running >= this.concurrency && this.queue.length >= this.maxQueued) return false;

        const entry = { task, res, req, controller: new AbortController(), started: false };
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
        if (this.shuttingDown) return;
        if (this.running >= this.concurrency || this.queue.length === 0) return;

        this.running++;
        const entry = this.queue.shift();
        entry.started = true;
        this.activeEntries.add(entry);

        if (entry.controller.signal.aborted || entry.res.destroyed) {
            entry.res.removeListener('close', entry.onClose);
            this.activeEntries.delete(entry);
            this.running--;
            this.process();
            return;
        }

        Promise.resolve(entry.task(entry.controller.signal))
            .catch(err => {
                const appErr = classifyError(err, err?.stderr || '');
                if (appErr.code !== 'CANCELLED' && !entry.controller.signal.aborted) {
                    Logger.error(`[Queue] Task failed: ${err.message}`);
                }
            })
            .finally(() => {
                entry.res.removeListener('close', entry.onClose);
                this.activeEntries.delete(entry);
                this.running--;
                this.process();
            });
    }

    stopAccepting() {
        this.shuttingDown = true;
        for (const hook of this.shutdownHooks) {
            try { hook(); } catch { /* ignore */ }
        }
        for (const stream of progressStreams) {
            try { stream.end(); } catch { /* already closed */ }
        }
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            entry.res.removeListener('close', entry.onClose);
            entry.controller.abort();
            if (!entry.res.headersSent) {
                sendError(entry.res, new AppError('SERVER_SHUTTING_DOWN'), entry.req);
            } else if (!entry.res.destroyed) {
                entry.res.destroy();
            }
        }
    }

    abortAll() {
        for (const entry of this.activeEntries) {
            entry.controller.abort();
        }
    }
}

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

class Semaphore {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    async acquire(signal) {
        if (signal?.aborted) throw new Error('Request cancelled.');
        if (this.running < this.concurrency) {
            this.running++;
            return;
        }

        await new Promise((resolve, reject) => {
            let waiter;
            const onAbort = () => {
                const idx = this.queue.indexOf(waiter);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                    reject(new Error('Request cancelled.'));
                }
            };

            waiter = {
                resolve: () => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve();
                },
                reject: (err) => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    reject(err);
                }
            };

            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this.queue.push(waiter);
        });
    }

    release() {
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            next.resolve();
            return;
        }
        this.running = Math.max(0, this.running - 1);
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

const MAX_TRACKED_JOBS = 500;
const downloadJobs = new Map();

// push channel for job changes; subscribers may attach before the job exists (it is created once the task leaves the queue)
const jobSubscribers = new Map();

function subscribeJob(jobId, listener) {
    let listeners = jobSubscribers.get(jobId);
    if (!listeners) jobSubscribers.set(jobId, listeners = new Set());
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && jobSubscribers.get(jobId) === listeners) jobSubscribers.delete(jobId);
    };
}

function notifyJob(jobId) {
    const listeners = jobId && jobSubscribers.get(jobId);
    if (!listeners) return;
    for (const listener of listeners) {
        try { listener(); } catch { /* one bad subscriber must not break the job */ }
    }
}

function computeJobSummary(job) {
    if (!job || !Array.isArray(job.tracks)) return { total: 0, ok: 0, failed: [] };
    const total = job.tracks.length;
    let ok = 0;
    const failed = [];

    job.tracks.forEach((t, i) => {
        if (t.state === 'done') {
            ok++;
        } else if (t.state === 'failed') {
            failed.push({
                index: i,
                title: t.title || 'Unknown Track',
                artist: t.artist || '',
                code: t.code || 'UNKNOWN',
                error: t.error || 'Track could not be downloaded.',
                detail: t.detail || null,
                match: t.match || null
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
                    error: t.error || 'Track could not be processed.',
                    detail: t.detail || null,
                    match: t.match || null
                });
            }
        });
        ok = Math.max(0, total - failed.length);
    }

    return { total, ok, failed };
}

/**
 * Shared job payload shape:
 * {
 *   status: 'queued' | 'running' | 'finished' | 'failed' | 'cancelled',
 *   queue?: { position, total, concurrency, etaSeconds | null },
 *   tracks: [{
 *     title, artist, state, progress, code, error,
 *     detail?: { ... },
 *     match?:  { quality, score, title, uploader }
 *   }],
 *   summary: { total, ok, failed: [...] }
 * }
 */
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
            error: null,
            detail: null,
            match: null
        }))
    };
    job.summary = computeJobSummary(job);
    downloadJobs.set(jobId, job);
    notifyJob(jobId);
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
    if (status !== 'finished' && Array.isArray(job.tracks)) {
        for (const t of job.tracks) {
            if (t.state === 'queued' || t.state === 'matching' || t.state === 'downloading' || t.state === 'encoding') {
                t.state = 'failed';
                t.code = job.code || (status === 'cancelled' ? 'CANCELLED' : 'UNKNOWN');
                t.error = job.error || (status === 'cancelled' ? 'Download was cancelled.' : 'Download failed.');
                if (!t.detail && errorInfo?.detail) t.detail = errorInfo.detail;
            }
        }
    }
    job.summary = computeJobSummary(job);
    notifyJob(jobId);
    setTimeout(() => { if (downloadJobs.get(jobId) === job) downloadJobs.delete(jobId); }, 2 * 60 * 1000).unref();
}

const downloadQueue = new DownloadQueue();
const metadataSemaphore = new MetadataSemaphore();
const ytdlpSemaphore = new Semaphore(DOWNLOAD_CONCURRENCY);
const ffmpegSemaphore = new Semaphore(ENCODE_CONCURRENCY);

module.exports = {
    DownloadQueue,
    downloadQueue,
    MetadataSemaphore,
    metadataSemaphore,
    Semaphore,
    ytdlpSemaphore,
    ffmpegSemaphore,
    AsyncBoundedQueue,
    MAX_TRACKED_JOBS,
    downloadJobs,
    progressStreams,
    subscribeJob,
    notifyJob,
    computeJobSummary,
    createJob,
    endJob
};

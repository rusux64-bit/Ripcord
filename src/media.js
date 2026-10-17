const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const {
    ffmpegPath,
    ffprobePath,
    WORK_DIR,
    MAX_COVER_BYTES
} = require('./config');
const { Logger, startStage } = require('./logger');
const { AppError, classifyError } = require('./errors');
const { ffmpegSemaphore } = require('./queue');

const downloadMetaMap = new Map();

function sanitizeFilename(name) {
    if (typeof name !== 'string' || !name) return 'audio_track';
    return name.slice(0, 240).replace(/<[^>]*>|&nbsp;|&[a-z]+;|[\$`'";|&]|\.\.[/\\]|[\x00-\x1F\x7F]/g, '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/^\.+/, '')
        .replace(/\s+/g, ' ')
        .trim().slice(0, 120) || 'audio_track';
}

function buildContentDisposition(baseName, extension) {
    const ext = extension ? (extension.startsWith('.') ? extension.slice(1) : extension).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    let name = String(baseName || '').trim();
    if (ext && name.toLowerCase().endsWith(`.${ext}`)) {
        name = name.slice(0, -(ext.length + 1)).trim();
    }
    const cleanExt = ext ? `.${ext}` : '';
    const safeUtf8 = sanitizeFilename(name);
    const finalUtf8 = safeUtf8 && safeUtf8 !== 'audio_track'
        ? `${safeUtf8}${cleanExt}`
        : (ext === 'zip' ? 'ripcord-playlist.zip' : `ripcord${cleanExt}`);

    const encodedUtf8 = encodeURIComponent(finalUtf8)
        .replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/\*/g, '%2A');

    let ascii = sanitizeFilename(name)
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/["\\;]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!ascii || ascii === 'audio_track') {
        ascii = ext === 'zip' ? 'ripcord-playlist' : 'ripcord';
    }
    const asciiFilename = `${ascii.slice(0, 100)}${cleanExt}`;

    return `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedUtf8}`;
}

function cleanupFiles(files) {
    if (!Array.isArray(files)) return;
    files.forEach(file => {
        if (!file) return;
        downloadMetaMap.delete(file);
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch (e) {
            // ignore errors if the file is already gone
        }
    });
}

function sweepWorkDir(staleOnly = true) {
    const staleBefore = staleOnly ? Date.now() - 6 * 60 * 60 * 1000 : Infinity;
    const prefixes = ['ripcord_', 'out_', 'track_', 'cover_', 'tagged_', 'comments_'];
    let removed = 0;
    try {
        const entries = fs.readdirSync(WORK_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!prefixes.some(p => entry.name.startsWith(p))) continue;
            const fullPath = path.join(WORK_DIR, entry.name);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs <= staleBefore) {
                    fs.unlinkSync(fullPath);
                    removed++;
                }
            } catch (error) {
                Logger.warn(`Unable to sweep temporary file ${entry.name}: ${error.message}`);
            }
        }
    } catch (error) {
        Logger.warn(`Unable to sweep work directory ${WORK_DIR}: ${error.message}`);
    }
    Logger.info(`Temporary file sweep removed ${removed} ${staleOnly ? 'stale ' : ''}file(s) from ${WORK_DIR}`);
}

const cleanupStaleWorkFiles = () => sweepWorkDir(true);

function parseCoverUrl(urlString) {
    if (typeof urlString !== 'string' || urlString.length === 0 || urlString.length > 2048) return null;
    try {
        const parsed = new URL(urlString);
        const host = parsed.hostname.toLowerCase();
        const allowed = ['ytimg.com', 'spotifycdn.com', 'scdn.co', 'googleusercontent.com']
            .some(domain => host === domain || host.endsWith(`.${domain}`));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowed) return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

async function fetchYouTubeThumbnailBuffer(videoId, signal = null) {
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const candidates = [
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
    ];
    for (const url of candidates) {
        if (signal?.aborted) return null;
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 5000,
                maxRedirects: 0,
                maxContentLength: MAX_COVER_BYTES,
                signal
            });
            if (res.status === 200 && res.data && res.data.length > 1000) {
                return { buffer: Buffer.from(res.data), url };
            }
        } catch {
            // try next candidate
        }
    }
    return null;
}

async function fetchCoverBuffer(urlString, signal = null) {
    const safeUrl = parseCoverUrl(urlString);
    if (!safeUrl) return null;
    try {
        const res = await axios.get(safeUrl.href, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 6000,
            maxRedirects: 0,
            maxContentLength: MAX_COVER_BYTES,
            signal
        });
        if (res.status === 200 && res.data && res.data.length > 500) {
            return Buffer.from(res.data);
        }
    } catch {
        return null;
    }
    return null;
}

async function cropToSquareJpeg(inputPath, outputPath, logger = Logger) {
    return new Promise(resolve => {
        const proc = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
            '-i', inputPath,
            '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=600:600:flags=lanczos',
            '-q:v', '2',
            outputPath
        ], { windowsHide: true });
        const timer = setTimeout(() => proc.kill('SIGKILL'), 10000);
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

function probeAudioCodec(filePath, logger = Logger) {
    const stageTimer = startStage(logger, 'probe');
    return new Promise(resolve => {
        const proc = spawn(ffprobePath, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { windowsHide: true });

        let output = '';
        const timer = setTimeout(() => proc.kill('SIGKILL'), 10000);
        proc.stdout.on('data', data => { output += data.toString(); });
        proc.on('error', () => {
            clearTimeout(timer);
            stageTimer.end('failed');
            resolve(null);
        });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) {
                stageTimer.end('ok');
                resolve(output.trim() || null);
            } else {
                stageTimer.end('failed');
                resolve(null);
            }
        });
    });
}

function ffmpegEncodeArgs(audioPath, outputPath, format, bitrate, coverPath, title, artist, maxBytes, copyAudio = false) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y', '-i', audioPath];
    const embedsCover = coverPath && ['mp3', 'm4a', 'flac'].includes(format);
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
        args.push('-c:v', 'copy');
        if (format === 'mp3') {
            args.push('-id3v2_version', '3', '-metadata:s:v', 'title=Album cover');
        }
        args.push('-disposition:v', 'attached_pic');
    }
    args.push('-fs', String(maxBytes), outputPath);
    return args;
}

async function injectVorbisCoverArt(filePath, imgPath, format, logger = Logger) {
    if (format !== 'ogg') return false;
    if (!fs.existsSync(imgPath) || !fs.existsSync(filePath)) return false;
    const stageTimer = startStage(logger, 'tag');

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

        const stdout = await new Promise((resolve, reject) => {
            const proc = spawn('vorbiscomment', ['-l', '-R', filePath], { windowsHide: true });
            let out = '';
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 15000);
            proc.stdout.on('data', d => { out += d.toString(); });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (timedOut || code !== 0) reject(new Error('vorbiscomment read failed'));
                else resolve(out);
            });
        });

        let comments = stdout.split('\n');
        comments = comments.filter(c => c && !c.startsWith('metadata_block_picture='));
        comments.push(`metadata_block_picture=${base64Block}\n`);

        await new Promise((resolve, reject) => {
            const proc = spawn('vorbiscomment', ['-w', '-R', filePath], { windowsHide: true });
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, 15000);
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (timedOut || code !== 0) reject(new Error('vorbiscomment write failed'));
                else resolve();
            });
            proc.stdin.write(comments.join('\n'));
            proc.stdin.end();
        });

        stageTimer.end('ok');
        return true;
    } catch {
        stageTimer.end('failed');
        return false;
    }
}

async function runFfmpeg(args, timeoutMessage, signal, logger = Logger) {
    const stageTimer = startStage(logger, 'encode');
    await ffmpegSemaphore.acquire(signal);
    try {
        return await new Promise((resolve, reject) => {
            if (signal?.aborted) {
                stageTimer.end('failed', { code: 'CANCELLED' });
                return reject(new AppError('CANCELLED'));
            }

            const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
            let timedOut = false;
            let stderr = '';
            const timeout = setTimeout(() => {
                timedOut = true;
                ff.kill('SIGKILL');
            }, 60000);
            const onAbort = () => ff.kill('SIGKILL');
            signal?.addEventListener('abort', onAbort, { once: true });
            ff.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
            ff.on('error', error => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                error.stderr = stderr;
                const appErr = classifyError(error, stderr);
                stageTimer.end('failed', { code: appErr.code });
                reject(appErr);
            });
            ff.on('close', code => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', onAbort);
                if (signal?.aborted) {
                    stageTimer.end('failed', { code: 'CANCELLED' });
                    reject(new AppError('CANCELLED'));
                } else if (timedOut) {
                    stageTimer.end('failed', { code: 'TIMEOUT' });
                    reject(new AppError('TIMEOUT', { userMessage: timeoutMessage }));
                } else if (code !== 0) {
                    const err = new Error('FFmpeg encoding failed.');
                    err.stderr = stderr;
                    err.exitCode = code;
                    const appErr = classifyError(err, stderr);
                    stageTimer.end('failed', { code: appErr.code });
                    reject(appErr);
                } else {
                    stageTimer.end('ok');
                    resolve();
                }
            });
        });
    } finally {
        ffmpegSemaphore.release();
    }
}

module.exports = {
    downloadMetaMap,
    sanitizeFilename,
    buildContentDisposition,
    cleanupFiles,
    sweepWorkDir,
    cleanupStaleWorkFiles,
    parseCoverUrl,
    fetchYouTubeThumbnailBuffer,
    fetchCoverBuffer,
    cropToSquareJpeg,
    probeAudioCodec,
    ffmpegEncodeArgs,
    injectVorbisCoverArt,
    runFfmpeg
};

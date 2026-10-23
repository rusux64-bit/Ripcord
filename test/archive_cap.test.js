const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PassThrough } = require('stream');

const youtube = require('../src/youtube');
const { formatBytes } = require('../src/config');
const { AppError, classifyError } = require('../src/errors');

test('formatBytes formats byte values appropriately', () => {
    assert.equal(formatBytes(1073741824), '1 GB');
    assert.equal(formatBytes(5242880), '5 MB');
    assert.equal(formatBytes(157286400), '150 MB');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(0), '0 B');
});

test('ARCHIVE_LIMIT error definition and classification', () => {
    const err = new AppError('ARCHIVE_LIMIT');
    assert.equal(err.code, 'ARCHIVE_LIMIT');
    assert.equal(err.httpStatus, 413);
    assert.equal(err.retryable, false);

    const classified = classifyError(new Error('Skipped: archive size limit (1 GB) reached'));
    assert.equal(classified.code, 'ARCHIVE_LIMIT');
});

test('aggregate playlist archive cap enforces limit, excludes oversized track, writes report and cleans up', async () => {
    const origCap = process.env.MAX_PLAYLIST_ARCHIVE_BYTES;
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripcord-test-cap-'));

    try {
        process.env.MAX_PLAYLIST_ARCHIVE_BYTES = '25000';
        delete require.cache[require.resolve('../src/config')];
        delete require.cache[require.resolve('../src/routes')];

        const origGetPlaylist = youtube.getYoutubePlaylistData;
        const origDownloadTrack = youtube.downloadPlaylistTrack;
        const origProcessTrack = youtube.processPlaylistTrack;

        youtube.getYoutubePlaylistData = async () => ({
            name: 'Test Cap Playlist',
            tracks: [
                { id: 't1', title: 'Track 1', artist: 'Artist 1', url: 'https://youtube.com/watch?v=1' },
                { id: 't2', title: 'Track 2', artist: 'Artist 2', url: 'https://youtube.com/watch?v=2' },
                { id: 't3', title: 'Track 3', artist: 'Artist 3', url: 'https://youtube.com/watch?v=3' },
                { id: 't4', title: 'Track 4', artist: 'Artist 4', url: 'https://youtube.com/watch?v=4' }
            ]
        });

        youtube.downloadPlaylistTrack = async (track, index) => {
            const tempAudio = path.join(testDir, `audio_${index}.tmp`);
            fs.writeFileSync(tempAudio, Buffer.alloc(10000));
            return { tempAudioPath: tempAudio, tempImgPath: null, index, track };
        };

        youtube.processPlaylistTrack = async (downloaded, bitrate, format, signal, report) => {
            const outPath = path.join(testDir, `out_${downloaded.index}.mp3`);
            fs.writeFileSync(outPath, Buffer.alloc(10000));
            if (fs.existsSync(downloaded.tempAudioPath)) {
                fs.unlinkSync(downloaded.tempAudioPath);
            }
            report(downloaded.index, { state: 'done', progress: 1 });
            return { filePath: outPath, name: `track_${downloaded.index + 1}.mp3` };
        };

        const routes = require('../src/routes');
        const res = new PassThrough();
        res.statusCode = 200;
        res.setHeader = () => {};
        res.getHeader = () => null;
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (obj) => { res.end(JSON.stringify(obj)); };

        const chunks = [];
        res.on('data', c => chunks.push(c));

        const ac = new AbortController();
        const jobId = 'test-job-archive-cap-1';

        await routes.executeDownloadTask(
            'https://www.youtube.com/playlist?list=PLcap_test_1',
            '128',
            'mp3',
            'test-playlist',
            res,
            ac.signal,
            jobId
        );

        const zipBuf = Buffer.concat(chunks);
        assert.ok(zipBuf.length > 0, 'ZIP must have content');

        // Check End of Central Directory (EOCD) signature 0x06054b50
        const eocdIndex = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        assert.ok(eocdIndex !== -1, 'Valid ZIP must contain EOCD record');
        const entryCount = zipBuf.readUInt16LE(eocdIndex + 10);
        // Expect 2 audio files + 1 _ripcord-skipped.txt report = 3 entries
        assert.equal(entryCount, 3);

        const job = routes.downloadJobs.get(jobId);
        assert.ok(job);
        assert.equal(job.status, 'finished');

        const doneTracks = job.tracks.filter(t => t.state === 'done');
        const failedTracks = job.tracks.filter(t => t.state === 'failed');
        assert.equal(doneTracks.length, 2, 'Exactly 2 tracks should fit in 25KB cap');
        assert.equal(failedTracks.length, 2, 'Exactly 2 tracks should be skipped');

        for (const t of failedTracks) {
            assert.equal(t.code, 'ARCHIVE_LIMIT');
            assert.ok(t.error.includes('archive size limit'));
        }

        // Verify summary
        assert.equal(job.summary.ok, 2);
        assert.equal(job.summary.failed.length, 2);

        // Verify all temporary files in testDir were cleaned up
        const remainingFiles = fs.readdirSync(testDir);
        assert.deepEqual(remainingFiles, [], 'No temporary files should leak');

        // Restore stubs
        youtube.getYoutubePlaylistData = origGetPlaylist;
        youtube.downloadPlaylistTrack = origDownloadTrack;
        youtube.processPlaylistTrack = origProcessTrack;
    } finally {
        if (origCap !== undefined) process.env.MAX_PLAYLIST_ARCHIVE_BYTES = origCap;
        else delete process.env.MAX_PLAYLIST_ARCHIVE_BYTES;
        delete require.cache[require.resolve('../src/config')];
        delete require.cache[require.resolve('../src/routes')];
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('aggregate playlist archive cap: all-skipped case rejects with ARCHIVE_LIMIT', async () => {
    const origCap = process.env.MAX_PLAYLIST_ARCHIVE_BYTES;
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripcord-test-cap-all-'));

    try {
        process.env.MAX_PLAYLIST_ARCHIVE_BYTES = '5000';
        delete require.cache[require.resolve('../src/config')];
        delete require.cache[require.resolve('../src/routes')];

        const origGetPlaylist = youtube.getYoutubePlaylistData;
        const origDownloadTrack = youtube.downloadPlaylistTrack;
        const origProcessTrack = youtube.processPlaylistTrack;

        youtube.getYoutubePlaylistData = async () => ({
            name: 'All Skipped Playlist',
            tracks: [
                { id: 't1', title: 'Track 1', artist: 'Artist 1', url: 'https://youtube.com/watch?v=1' }
            ]
        });

        youtube.downloadPlaylistTrack = async (track, index) => {
            const tempAudio = path.join(testDir, `audio_${index}.tmp`);
            fs.writeFileSync(tempAudio, Buffer.alloc(10000));
            return { tempAudioPath: tempAudio, tempImgPath: null, index, track };
        };

        youtube.processPlaylistTrack = async (downloaded, bitrate, format, signal, report) => {
            const outPath = path.join(testDir, `out_${downloaded.index}.mp3`);
            fs.writeFileSync(outPath, Buffer.alloc(10000));
            if (fs.existsSync(downloaded.tempAudioPath)) {
                fs.unlinkSync(downloaded.tempAudioPath);
            }
            report(downloaded.index, { state: 'done', progress: 1 });
            return { filePath: outPath, name: `track_${downloaded.index + 1}.mp3` };
        };

        const routes = require('../src/routes');
        const res = new PassThrough();
        res.statusCode = 200;
        res.setHeader = () => {};
        res.getHeader = () => null;
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (obj) => { res.end(JSON.stringify(obj)); };

        const ac = new AbortController();
        const jobId = 'test-job-archive-cap-all-skipped';

        await routes.executeDownloadTask(
            'https://www.youtube.com/playlist?list=PLcap_test_all',
            '128',
            'mp3',
            'all-skipped-playlist',
            res,
            ac.signal,
            jobId
        );

        assert.equal(res.statusCode, 413);
        const job = routes.downloadJobs.get(jobId);
        assert.ok(job);
        assert.equal(job.status, 'failed');
        assert.equal(job.code, 'ARCHIVE_LIMIT');

        const remainingFiles = fs.readdirSync(testDir);
        assert.deepEqual(remainingFiles, [], 'No temporary files should leak');

        youtube.getYoutubePlaylistData = origGetPlaylist;
        youtube.downloadPlaylistTrack = origDownloadTrack;
        youtube.processPlaylistTrack = origProcessTrack;
    } finally {
        if (origCap !== undefined) process.env.MAX_PLAYLIST_ARCHIVE_BYTES = origCap;
        else delete process.env.MAX_PLAYLIST_ARCHIVE_BYTES;
        delete require.cache[require.resolve('../src/config')];
        delete require.cache[require.resolve('../src/routes')];
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

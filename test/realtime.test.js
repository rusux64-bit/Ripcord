// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');

// isolate the on-disk caches and keep logs quiet before any app module loads
process.env.SPOTIFY_MATCH_CACHE_FILE = path.join(os.tmpdir(), `ripcord-test-${process.pid}.json`);
process.env.LOG_LEVEL = 'error';

const childProcess = require('child_process');
const axios = require('axios');

// ---- fake yt-dlp: every spawn is counted and answers with canned search JSON ----
let spawnCalls = [];
let searchEntries = () => [];
const realSpawn = childProcess.spawn;
childProcess.spawn = (cmd, args) => {
    if (cmd !== 'yt-dlp') return realSpawn(cmd, args);
    spawnCalls.push(args[args.length - 1]);
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { };
    const entries = searchEntries(args[args.length - 1]);
    setTimeout(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ entries })));
        proc.emit('close', 0);
    }, 5);
    return proc;
};

const strong = [{ id: 'AAAAAAAAAAA', title: 'Test Artist - Test Song', uploader: 'Test Artist - Topic', duration: 200 }];
const weak = [{ id: 'BBBBBBBBBBB', title: 'Something unrelated entirely', uploader: 'Nobody', duration: 60 }];
const track = { title: 'Test Song', artist: 'Test Artist', durationMs: 200000, uri: 'spotify:track:TESTTRACK1' };

const spotify = require('../src/spotify');
const youtube = require('../src/youtube');

test('first search already strong -> second yt-dlp process is skipped', async () => {
    spawnCalls = [];
    searchEntries = () => strong;
    const result = await youtube.findSpotifyCandidates(track, undefined, require('../src/logger').Logger);
    assert.equal(spawnCalls.length, 1);
    assert.equal(result[0].videoId, 'AAAAAAAAAAA');
    assert.ok(result[0].score >= 0.9, `score was ${result[0].score}`);
});

test('weak first search -> falls through to the second query', async () => {
    spawnCalls = [];
    let n = 0;
    searchEntries = () => (n++ === 0 ? weak : strong);
    const result = await youtube.findSpotifyCandidates(track);
    assert.equal(spawnCalls.length, 2);
    assert.equal(result[0].videoId, 'AAAAAAAAAAA');
});

test('prewarm fills the match cache once and download waits for it', async () => {
    spawnCalls = [];
    searchEntries = () => strong;
    const t = { ...track, uri: 'spotify:track:PREWARM0001' };
    youtube.prewarmSpotifyMatches([t]);
    youtube.prewarmSpotifyMatches([t]); // duplicate call must not spawn again
    await youtube.awaitPrewarm(t);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spotify.spotifyMatchCache.get(t.uri).videoId, 'AAAAAAAAAAA');
    youtube.prewarmSpotifyMatches([t]); // already cached -> nothing to do
    assert.equal(spawnCalls.length, 1);
});

test('spotify metadata: oEmbed + embed fetched in parallel, cached, concurrent calls share one scrape', async () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { state: { data: { entity: { name: 'Cached Song', artists: [{ name: 'Cached Artist' }], duration: 1000 } } } } }
    })}</script>`;
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [];
    const realGet = axios.get;
    axios.get = async (url) => {
        calls.push(url);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 20));
        inFlight--;
        if (url.includes('/oembed')) return { status: 200, data: { title: 'T', thumbnail_url: 'https://i.scdn.co/image/abc' } };
        return { status: 200, data: html };
    };
    try {
        const url = 'https://open.spotify.com/track/CACHETEST123';
        const [a, b] = await Promise.all([spotify.getSpotifyData(url), spotify.getSpotifyData(url)]);
        const c = await spotify.getSpotifyData(url);
        assert.equal(calls.length, 2, `expected 2 upstream calls, got ${calls.length}`);
        assert.equal(maxInFlight, 2, 'oEmbed and embed should overlap');
        assert.equal(a.tracks[0].title, 'Cached Song');
        a.tracks[0].title = 'mutated';
        assert.equal(c.tracks[0].title, 'Cached Song', 'callers must get independent copies');
        assert.notEqual(b, a);
    } finally {
        axios.get = realGet;
    }
});

test('aborting one caller does not poison the shared scrape', async () => {
    const realGet = axios.get;
    axios.get = async (url) => {
        await new Promise(r => setTimeout(r, 30));
        if (url.includes('/oembed')) return { status: 200, data: { title: 'T' } };
        return { status: 200, data: `<meta property="og:title" content="Song · Artist"><meta property="og:description" content="x">` };
    };
    try {
        const url = 'https://open.spotify.com/track/ABORTTEST123';
        const ctl = new AbortController();
        const aborted = spotify.getSpotifyData(url, ctl.signal);
        const survivor = spotify.getSpotifyData(url);
        ctl.abort();
        await assert.rejects(aborted, err => err.code === 'CANCELLED');
        assert.equal((await survivor).tracks.length, 1);
    } finally {
        axios.get = realGet;
    }
});

test('SSE stream pushes job updates immediately and closes when the job ends', async () => {
    const express = require('express');
    const { registerRoutes } = require('../src/routes');
    const queue = require('../src/queue');
    const app = express();
    registerRoutes(app);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = server.address();
    const jobId = 'sse-test-job-0001';

    const events = [];
    const done = new Promise((resolve, reject) => {
        http.get({ port, host: '127.0.0.1', path: `/api/progress/${jobId}/stream` }, res => {
            assert.equal(res.statusCode, 200);
            assert.match(res.headers['content-type'], /text\/event-stream/);
            let buf = '';
            res.on('data', chunk => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const frame = buf.slice(0, i);
                    buf = buf.slice(i + 2);
                    if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
                }
            });
            res.on('end', resolve);
            res.on('error', reject);
        }).on('error', reject);
    });

    await new Promise(r => setTimeout(r, 100));            // client subscribed before the job exists
    const job = queue.createJob(jobId, [{ title: 'One', artist: 'A' }]);
    await new Promise(r => setTimeout(r, 300));
    job.tracks[0].state = 'downloading';
    job.tracks[0].progress = 0.5;
    queue.notifyJob(jobId);
    await new Promise(r => setTimeout(r, 300));
    queue.endJob(jobId, 'finished');
    await done;                                            // stream must end on its own

    assert.ok(events.length >= 3, `got ${events.length} events`);
    assert.equal(events[0].tracks[0].state, 'queued');
    assert.ok(events.some(e => e.tracks[0].state === 'downloading' && e.tracks[0].progress === 0.5));
    assert.equal(events.at(-1).status, 'finished');
    assert.equal(queue.progressStreams.size, 0, 'stream registry must be cleaned up');
    await new Promise(r => server.close(r));
});

test('SSE rejects malformed job ids', async () => {
    const express = require('express');
    const { registerRoutes } = require('../src/routes');
    const app = express();
    registerRoutes(app);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const status = await new Promise(resolve => {
        http.get({ port: server.address().port, host: '127.0.0.1', path: '/api/progress/x/stream' }, res => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(status, 404);
    await new Promise(r => server.close(r));
});

test('endJob marks incomplete tracks as failed with code and error', () => {
    const queue = require('../src/queue');
    const { AppError } = require('../src/errors');
    const jobId = 'test-job-fail-001';
    const job = queue.createJob(jobId, [{ title: 'Track 1' }, { title: 'Track 2' }]);
    job.tracks[0].state = 'downloading';
    queue.endJob(jobId, 'failed', new AppError('NO_MATCH', { userMessage: 'Could not find track' }));
    assert.equal(job.status, 'failed');
    assert.equal(job.tracks[0].state, 'failed');
    assert.equal(job.tracks[0].code, 'NO_MATCH');
    assert.equal(job.tracks[1].state, 'failed');
    assert.equal(job.summary.failed.length, 2);
    assert.equal(job.summary.ok, 0);
});

test('cancelAllPrewarms cleans up inflight prewarm tasks', () => {
    const t = { ...track, uri: 'spotify:track:CANCELPREWARM01' };
    youtube.prewarmSpotifyMatches([t]);
    youtube.cancelAllPrewarms();
});

test('api/ready returns 200 with readiness status', async () => {
    const express = require('express');
    const { registerRoutes } = require('../src/routes');
    const app = express();
    registerRoutes(app);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const resData = await new Promise((resolve, reject) => {
        http.get({ port: server.address().port, host: '127.0.0.1', path: '/api/ready' }, res => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
        }).on('error', reject);
    });
    assert.equal(resData.status, 200);
    assert.equal(resData.body.status, 'ready');
    assert.equal(resData.body.storage, 'ok');
    assert.equal(resData.body.ffmpeg, 'ok');
    await new Promise(r => server.close(r));
});

test('killProcessGroup terminates safely without throwing', () => {
    youtube.killProcessGroup(null);
    youtube.killProcessGroup({});
    youtube.killProcessGroup({ pid: -999999 });
});

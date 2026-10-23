const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');
const { registerRoutes } = require('../src/routes');
const {
    DownloadQueue,
    DurationTracker,
    createPlaceholderJob,
    createJob,
    endJob,
    downloadJobs,
    progressStreams
} = require('../src/queue');

function createMockResponse() {
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.headersSent = false;
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
    return res;
}

test('positions renumber when an earlier task finishes or a waiting one disconnects', async () => {
    const q = new DownloadQueue(1, 5);
    let resolveTask0;
    const task0Promise = new Promise(resolve => { resolveTask0 = resolve; });
    let resolveTask1;
    const task1Promise = new Promise(resolve => { resolveTask1 = resolve; });
    let resolveTask3;
    const task3Promise = new Promise(resolve => { resolveTask3 = resolve; });
    const res0 = createMockResponse();
    const res1 = createMockResponse();
    const res2 = createMockResponse();
    const res3 = createMockResponse();

    // Task 0 takes the single running slot
    q.addTask(() => task0Promise, res0, null, { jobId: 'job-0' });
    assert.equal(q.running, 1);
    assert.equal(q.queue.length, 0);

    // Tasks 1, 2, 3 wait in line
    q.addTask(() => task1Promise, res1, null, { jobId: 'job-1' });
    q.addTask(() => Promise.resolve(), res2, null, { jobId: 'job-2' });
    q.addTask(() => task3Promise, res3, null, { jobId: 'job-3' });

    assert.equal(q.queue.length, 3);
    assert.equal(downloadJobs.get('job-1').queue.position, 1);
    assert.equal(downloadJobs.get('job-1').queue.total, 3);
    assert.equal(downloadJobs.get('job-2').queue.position, 2);
    assert.equal(downloadJobs.get('job-2').queue.total, 3);
    assert.equal(downloadJobs.get('job-3').queue.position, 3);
    assert.equal(downloadJobs.get('job-3').queue.total, 3);

    // Disconnect job-2 while queued
    res2.emit('close');
    assert.equal(downloadJobs.has('job-2'), false);
    assert.equal(q.queue.length, 2);
    assert.equal(downloadJobs.get('job-1').queue.position, 1);
    assert.equal(downloadJobs.get('job-1').queue.total, 2);
    assert.equal(downloadJobs.get('job-3').queue.position, 2);
    assert.equal(downloadJobs.get('job-3').queue.total, 2);

    // Finish running task 0 -> task 1 leaves queue and starts running
    resolveTask0();
    await new Promise(r => setTimeout(r, 20));

    assert.equal(q.running, 1);
    assert.equal(q.queue.length, 1);
    assert.equal(downloadJobs.get('job-3').queue.position, 1);
    assert.equal(downloadJobs.get('job-3').queue.total, 1);

    // Cleanup
    resolveTask1();
    resolveTask3();
    res1.emit('close');
    res3.emit('close');
    downloadJobs.delete('job-0');
    downloadJobs.delete('job-1');
    downloadJobs.delete('job-3');
});

test('ETA is null under 3 samples and sensible after', () => {
    const tracker = new DurationTracker(0.3);

    // With 0 samples, estimate is null
    assert.equal(tracker.getEstimate(1, 1, 'single'), null);

    // With 1 sample, estimate is null
    tracker.recordDuration('single', 30);
    assert.equal(tracker.getEstimate(1, 1, 'single'), null);

    // With 2 samples, estimate is null
    tracker.recordDuration('single', 30);
    assert.equal(tracker.getEstimate(1, 1, 'single'), null);

    // With 3 samples, estimate is available
    tracker.recordDuration('single', 30);
    const est = tracker.getEstimate(1, 1, 'single');
    assert.equal(typeof est, 'number');
    assert.equal(est, 30);

    // Scales with position and concurrency waves (position 2, concurrency 1 => 2 waves => 60s)
    assert.equal(tracker.getEstimate(2, 1, 'single'), 60);

    // Separate collection bucket still has 0 samples, so returns null
    assert.equal(tracker.getEstimate(1, 1, 'collection'), null);

    // Add 3 samples to collection bucket
    tracker.recordDuration('collection', 100);
    tracker.recordDuration('collection', 100);
    tracker.recordDuration('collection', 100);
    const collEst = tracker.getEstimate(1, 1, 'collection');
    assert.equal(typeof collEst, 'number');
    assert.equal(collEst, 100);
});

test('placeholder upgrades to a running job without duplicates', () => {
    const jobId = 'upgrade-test-job-999';
    downloadJobs.delete(jobId);

    const initialSize = downloadJobs.size;
    const placeholder = createPlaceholderJob(jobId, {
        position: 2,
        total: 4,
        concurrency: 4,
        etaSeconds: 45
    });

    assert.equal(downloadJobs.size, initialSize + 1);
    assert.equal(placeholder.status, 'queued');
    assert.equal(placeholder.queue.position, 2);
    assert.equal(placeholder.tracks.length, 0);

    // Upgrade the placeholder job
    const upgraded = createJob(jobId, [{ title: 'Upgraded Song', artist: 'Artist' }]);

    assert.equal(upgraded, placeholder);
    assert.equal(downloadJobs.size, initialSize + 1, 'must not create duplicate job entry');
    assert.equal(upgraded.status, 'running');
    assert.equal(upgraded.queue, undefined);
    assert.equal(upgraded.tracks.length, 1);
    assert.equal(upgraded.tracks[0].title, 'Upgraded Song');

    endJob(jobId, 'finished');
    downloadJobs.delete(jobId);
});

test('SSE integration test going queued -> running -> finished and staying open the whole time', async () => {
    const app = express();
    registerRoutes(app);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

    try {
        const { port } = server.address();
        const jobId = 'sse-flow-job-888';
        downloadJobs.delete(jobId);

        // Register placeholder job
        createPlaceholderJob(jobId, { position: 1, total: 1, concurrency: 4, etaSeconds: null });

        const events = [];
        let streamEnded = false;

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
                        if (frame.startsWith('data: ')) {
                            events.push(JSON.parse(frame.slice(6)));
                        }
                    }
                });
                res.on('end', () => {
                    streamEnded = true;
                    resolve();
                });
                res.on('error', reject);
            }).on('error', reject);
        });

        // Give connection a moment to receive queued event
        await new Promise(r => setTimeout(r, 250));
        assert.equal(streamEnded, false, 'Stream must remain open during queued state');
        assert.ok(events.length >= 1);
        assert.equal(events[0].status, 'queued');
        assert.equal(events[0].queue.position, 1);

        // Upgrade to running job
        createJob(jobId, [{ title: 'Streaming Track', artist: 'Test Artist' }]);
        await new Promise(r => setTimeout(r, 250));
        assert.equal(streamEnded, false, 'Stream must remain open during running state');
        assert.ok(events.some(e => e.status === 'running'));

        // End job with finished
        endJob(jobId, 'finished');
        await done;

        assert.equal(streamEnded, true);
        assert.equal(events.at(-1).status, 'finished');
        assert.equal(progressStreams.size, 0, 'all stream resources cleaned up');
    } finally {
        await new Promise(r => server.close(r));
    }
});

test('a disconnected queued client frees its spot', () => {
    const q = new DownloadQueue(1, 1);
    let resolveTask0;
    const p0 = new Promise(resolve => { resolveTask0 = resolve; });
    const res0 = createMockResponse();
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    // Fill the running slot
    const accepted0 = q.addTask(() => p0, res0, null, { jobId: 'run-job' });
    assert.equal(accepted0, true);
    assert.equal(q.running, 1);
    assert.equal(q.queue.length, 0);

    // Fill the 1 queued slot
    const accepted1 = q.addTask(() => Promise.resolve(), res1, null, { jobId: 'queued-job' });
    assert.equal(accepted1, true);
    assert.equal(q.queue.length, 1);

    // Attempt to queue another task - must be rejected
    const accepted2 = q.addTask(() => Promise.resolve(), res2, null, { jobId: 'rejected-job' });
    assert.equal(accepted2, false);

    // Disconnect the queued client
    res1.emit('close');
    assert.equal(q.queue.length, 0);
    assert.equal(downloadJobs.has('queued-job'), false);

    // Now adding another task should succeed because the spot was freed
    const accepted3 = q.addTask(() => Promise.resolve(), res2, null, { jobId: 'accepted-job' });
    assert.equal(accepted3, true);
    assert.equal(q.queue.length, 1);

    // Cleanup
    resolveTask0();
    res2.emit('close');
    downloadJobs.delete('run-job');
    downloadJobs.delete('accepted-job');
});

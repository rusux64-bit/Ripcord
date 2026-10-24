const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { EventEmitter } = require('node:events');

const {
    signDeviceId,
    verifyDeviceCookie,
    resolveDeviceIdentity,
    extractClientSubnet,
    SlidingQuotaTracker,
    quotaTracker,
    DEVICE_COOKIE_NAME
} = require('../src/quota');

const {
    DownloadQueue,
    downloadQueue,
    downloadJobs
} = require('../src/queue');

const { registerRoutes } = require('../src/routes');

function createMockResponse() {
    const res = new EventEmitter();
    res.headersSent = false;
    res.destroyed = false;
    res.writableEnded = false;
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
    res.getHeader = (name) => res.headers[name.toLowerCase()];
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.data = data; res.writableEnded = true; res.emit('finish'); return res; };
    res.end = () => { res.writableEnded = true; res.emit('finish'); return res; };
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
    return res;
}

test('device cookie signing and HMAC tamper rejection', () => {
    const secret = 'test-secret-key-32-chars-long!!';
    const deviceId = '12345678-1234-4234-8234-123456789abc';

    // 1. Sign and verify valid cookie
    const signed = signDeviceId(deviceId, secret);
    assert.match(signed, /^[0-9a-fA-F-]+\.[0-9a-f]{64}$/);
    const verified = verifyDeviceCookie(signed, secret);
    assert.equal(verified, deviceId);

    // 2. Tampered signature rejected
    const tamperedSig = signed.slice(0, -4) + '0000';
    assert.equal(verifyDeviceCookie(tamperedSig, secret), null);

    // 3. Tampered device ID rejected
    const tamperedId = '87654321' + signed.slice(8);
    assert.equal(verifyDeviceCookie(tamperedId, secret), null);

    // 4. Different secret rejected
    assert.equal(verifyDeviceCookie(signed, 'another-secret-key-completely-diff'), null);

    // 5. Malformed inputs safely return null
    assert.equal(verifyDeviceCookie('', secret), null);
    assert.equal(verifyDeviceCookie(null, secret), null);
    assert.equal(verifyDeviceCookie('not-a-valid-cookie', secret), null);
    assert.equal(verifyDeviceCookie('../../../etc/passwd.bad', secret), null);
});

test('resolveDeviceIdentity issues fresh signed cookie when missing or invalid, preserves valid', () => {
    const secret = 'secret-for-resolve-device-identity';

    // Case 1: First visit, no cookies
    const req1 = { headers: {} };
    const id1 = resolveDeviceIdentity(req1, secret);
    assert.ok(id1.deviceId);
    assert.ok(id1.setCookieHeader);
    assert.match(id1.setCookieHeader, /rc_did=/);
    assert.match(id1.setCookieHeader, /HttpOnly/);
    assert.match(id1.setCookieHeader, /SameSite=Lax/);

    // Case 2: Returning visit with valid cookie
    const req2 = { headers: { cookie: `${DEVICE_COOKIE_NAME}=${encodeURIComponent(signDeviceId(id1.deviceId, secret))}` } };
    const id2 = resolveDeviceIdentity(req2, secret);
    assert.equal(id2.deviceId, id1.deviceId);
    assert.equal(id2.setCookieHeader, null);

    // Case 3: Returning visit with tampered/forged cookie -> replaces with new valid ID
    const req3 = { headers: { cookie: `${DEVICE_COOKIE_NAME}=forged-id.1234567890abcdef` } };
    const id3 = resolveDeviceIdentity(req3, secret);
    assert.notEqual(id3.deviceId, 'forged-id');
    assert.ok(id3.setCookieHeader);

    // Case 4: HTTPS request receives Secure attribute
    const reqSecure = { headers: { 'x-forwarded-proto': 'https' } };
    const idSecure = resolveDeviceIdentity(reqSecure, secret);
    assert.match(idSecure.setCookieHeader, /; Secure/);
});

test('extractClientSubnet masks IPv4 to /24 and IPv6 to /64 correctly', () => {
    // IPv4 standard
    assert.equal(extractClientSubnet('192.168.1.42'), '192.168.1.0/24');
    assert.equal(extractClientSubnet('10.0.5.120'), '10.0.5.0/24');
    assert.equal(extractClientSubnet('127.0.0.1'), '127.0.0.0/24');

    // Mapped IPv4
    assert.equal(extractClientSubnet('::ffff:192.0.2.1'), '192.0.2.0/24');
    assert.equal(extractClientSubnet('::ffff:127.0.0.1'), '127.0.0.0/24');

    // IPv6
    assert.equal(extractClientSubnet('::1'), '::1/64');
    assert.equal(extractClientSubnet('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), '2001:0db8:85a3:0000::/64');
    assert.equal(extractClientSubnet('2001:db8:85a3::8a2e:370:7334'), '2001:0db8:85a3:0000::/64');
    assert.equal(extractClientSubnet('2600:1700:abcd:1234:5678::'), '2600:1700:abcd:1234::/64');

    // Edge / invalid
    assert.equal(extractClientSubnet(''), 'unknown');
    assert.equal(extractClientSubnet(null), 'unknown');
    assert.equal(extractClientSubnet('invalid-ip-address'), 'unknown');
});

test('SlidingQuotaTracker sliding 24h window, rolling expiry, and evasion resistance', () => {
    const tracker = new SlidingQuotaTracker();
    const baseTime = 1700000000000; // ms

    // Record 200 songs for device1 on subnet1
    tracker.recordSuccess('device1', '192.168.1.0/24', 200, baseTime);
    assert.equal(tracker.getCount('dev:device1', 24, baseTime), 200);
    assert.equal(tracker.getCount('sub:192.168.1.0/24', 24, baseTime), 200);
    assert.equal(tracker.isOverQuota('device1', '192.168.1.0/24', 500, 24, baseTime), false);

    // Add 300 more songs 2 hours later
    const timeT2 = baseTime + 2 * 3600000;
    tracker.recordSuccess('device1', '192.168.1.0/24', 300, timeT2);
    assert.equal(tracker.getUsage('device1', '192.168.1.0/24', 24, timeT2).maxCount, 500);
    assert.equal(tracker.isOverQuota('device1', '192.168.1.0/24', 500, 24, timeT2), true);

    // Evasion attempt 1: user clears cookies (new device ID, same subnet) -> caught by subnet
    assert.equal(tracker.isOverQuota('new-device-id', '192.168.1.0/24', 500, 24, timeT2), true);

    // Evasion attempt 2: user changes IP subnet (same device ID) -> caught by cookie
    assert.equal(tracker.isOverQuota('device1', '10.0.0.0/24', 500, 24, timeT2), true);

    // Detachable: if quota limit is 0, isOverQuota always returns false
    assert.equal(tracker.isOverQuota('device1', '192.168.1.0/24', 0, 24, timeT2), false);

    // After 25 hours from baseTime, the first 200 songs expire, only 300 remain
    const timeT25 = baseTime + 25 * 3600000;
    assert.equal(tracker.getUsage('device1', '192.168.1.0/24', 24, timeT25).maxCount, 300);
    assert.equal(tracker.isOverQuota('device1', '192.168.1.0/24', 500, 24, timeT25), false);

    // After 27 hours from baseTime, all records expire and prune removes entries from memory
    const timeT27 = baseTime + 27 * 3600000;
    assert.equal(tracker.getUsage('device1', '192.168.1.0/24', 24, timeT27).maxCount, 0);
    tracker.prune(24, timeT27);
    assert.equal(tracker.buckets.size, 0);
});

test('DownloadQueue fair-share dispatching: normal runs first, low-priority runs when normal queue is 0', async () => {
    const q = new DownloadQueue(1, 10);
    const executionOrder = [];

    let resolveTask0;
    const p0 = new Promise(r => { resolveTask0 = r; });
    let resolveTaskNormal1;
    const pNormal1 = new Promise(r => { resolveTaskNormal1 = r; });
    let resolveTaskLow1;
    const pLow1 = new Promise(r => { resolveTaskLow1 = r; });

    const res0 = createMockResponse();
    const resNormal1 = createMockResponse();
    const resLow1 = createMockResponse();

    // 1. Task 0 starts and occupies the single slot
    q.addTask(() => {
        executionOrder.push('task0');
        return p0;
    }, res0, null, { jobId: 'job-0' });

    assert.equal(q.running, 1);
    assert.equal(executionOrder.length, 1);

    // 2. Queue a low-priority task (over-quota bulk client)
    q.addTask(() => {
        executionOrder.push('low1');
        return pLow1;
    }, resLow1, null, { jobId: 'job-low-1', priority: 'low' });

    // 3. Queue a normal-priority task (standard client)
    q.addTask(() => {
        executionOrder.push('normal1');
        return pNormal1;
    }, resNormal1, null, { jobId: 'job-normal-1', priority: 'normal' });

    assert.equal(q.queue.length, 1);
    assert.equal(q.lowPriorityQueue.length, 1);
    assert.equal(downloadJobs.get('job-normal-1').queue.priority, 'normal');
    assert.equal(downloadJobs.get('job-normal-1').queue.position, 1);
    assert.equal(downloadJobs.get('job-low-1').queue.priority, 'low');
    // Low priority position is behind normal queue: 1 + 1 = 2
    assert.equal(downloadJobs.get('job-low-1').queue.position, 2);

    // 4. Task 0 finishes. Normal task must execute NEXT despite arriving after low-priority task!
    resolveTask0();
    await new Promise(r => setTimeout(r, 20));

    assert.deepEqual(executionOrder, ['task0', 'normal1']);
    assert.equal(q.queue.length, 0);
    assert.equal(q.lowPriorityQueue.length, 1);
    assert.equal(downloadJobs.get('job-low-1').queue.position, 1);

    // 5. Normal task finishes. Now normal queue is 0, so low-priority task runs!
    resolveTaskNormal1();
    await new Promise(r => setTimeout(r, 20));

    assert.deepEqual(executionOrder, ['task0', 'normal1', 'low1']);
    assert.equal(q.lowPriorityQueue.length, 0);

    // Cleanup
    resolveTaskLow1();
    await new Promise(r => setTimeout(r, 20));
    downloadJobs.delete('job-0');
    downloadJobs.delete('job-normal-1');
    downloadJobs.delete('job-low-1');
});

test('DownloadQueue disconnect while in lowPriorityQueue cleans up properly', () => {
    const q = new DownloadQueue(1, 5);
    const resRunning = createMockResponse();
    const resLow = createMockResponse();

    let resolveRunning;
    const pRunning = new Promise(r => { resolveRunning = r; });

    q.addTask(() => pRunning, resRunning, null, { jobId: 'job-run' });
    q.addTask(() => Promise.resolve(), resLow, null, { jobId: 'job-low', priority: 'low' });

    assert.equal(q.lowPriorityQueue.length, 1);
    assert.equal(downloadJobs.has('job-low'), true);

    // Disconnect low priority client
    resLow.emit('close');
    assert.equal(q.lowPriorityQueue.length, 0);
    assert.equal(downloadJobs.has('job-low'), false);

    resolveRunning();
    resRunning.emit('close');
    downloadJobs.delete('job-run');
});

test('Integration: /api/download assigns low priority to clients over daily quota and normal to others', async () => {
    quotaTracker.reset();

    // Occupy all download concurrency slots so new additions stay queued for deterministic assertions
    const busyResolvers = [];
    const busyResponses = [];
    for (let i = 0; i < downloadQueue.concurrency; i++) {
        const busyRes = createMockResponse();
        const p = new Promise(r => busyResolvers.push(r));
        downloadQueue.addTask(() => p, busyRes, null, { jobId: `busy-slot-${i}` });
        busyResponses.push(busyRes);
    }

    const app = express();
    registerRoutes(app);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    let reqNormal = null;
    let reqBulk = null;

    try {
        // 1. Visit /api/health to obtain initial signed device cookie
        const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: { 'User-Agent': 'RipcordTest' }
        });
        const setCookie = healthRes.headers.get('set-cookie');
        assert.ok(setCookie, 'Server must issue signed rc_did cookie');
        assert.match(setCookie, /rc_did=/);

        const cookieVal = setCookie.split(';')[0].split('=')[1];
        const dotIdx = cookieVal.indexOf('.');
        const deviceId = decodeURIComponent(cookieVal.substring(0, dotIdx));
        const subnet = '127.0.0.0/24';

        // 2. Start download request for client under quota (0/500)
        reqNormal = http.get({
            port,
            host: '127.0.0.1',
            path: '/api/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&job=test-job-normal',
            headers: { 'Cookie': `${DEVICE_COOKIE_NAME}=${cookieVal}` }
        });
        reqNormal.on('error', () => {});

        // Wait brief tick for request to reach queue
        await new Promise(r => setTimeout(r, 60));
        const jobNormal = downloadJobs.get('test-job-normal');
        assert.ok(jobNormal);
        assert.equal(jobNormal.status, 'queued');
        assert.equal(jobNormal.queue.priority, 'normal');

        // 3. Record quota successes reaching the 500 limit
        quotaTracker.recordSuccess(deviceId, subnet, 500);

        // 4. Start second download request with same device cookie -> over quota -> priority: 'low'
        reqBulk = http.get({
            port,
            host: '127.0.0.1',
            path: '/api/download?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&job=test-job-bulk',
            headers: { 'Cookie': `${DEVICE_COOKIE_NAME}=${cookieVal}` }
        });
        reqBulk.on('error', () => {});

        await new Promise(r => setTimeout(r, 60));
        const jobBulk = downloadJobs.get('test-job-bulk');
        assert.ok(jobBulk);
        assert.equal(jobBulk.status, 'queued');
        assert.equal(jobBulk.queue.priority, 'low');
        // Total queue count should reflect both normal and low priority queued jobs
        assert.equal(jobBulk.queue.total, 2);
    } finally {
        if (reqNormal) reqNormal.destroy();
        if (reqBulk) reqBulk.destroy();
        busyResolvers.forEach(r => r());
        busyResponses.forEach(res => res.emit('close'));
        await new Promise(r => setTimeout(r, 60));
        downloadJobs.delete('test-job-normal');
        downloadJobs.delete('test-job-bulk');
        for (let i = 0; i < downloadQueue.concurrency; i++) {
            downloadJobs.delete(`busy-slot-${i}`);
        }
        quotaTracker.reset();
        await new Promise(r => server.close(r));
    }
});

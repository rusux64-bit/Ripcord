const crypto = require('crypto');
const net = require('net');

const DEVICE_COOKIE_NAME = 'rc_did';

function signDeviceId(deviceId, secret) {
    if (!deviceId || typeof deviceId !== 'string') return '';
    const hmac = crypto.createHmac('sha256', secret).update(deviceId).digest('hex');
    return `${deviceId}.${hmac}`;
}

function verifyDeviceCookie(cookieValue, secret) {
    if (!cookieValue || typeof cookieValue !== 'string') return null;
    const dotIdx = cookieValue.indexOf('.');
    if (dotIdx === -1) return null;
    const deviceId = cookieValue.substring(0, dotIdx);
    const signature = cookieValue.substring(dotIdx + 1);
    if (!deviceId || !signature) return null;
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(deviceId)) return null;

    const expectedSig = crypto.createHmac('sha256', secret).update(deviceId).digest('hex');
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    return deviceId;
}

function getCookie(req, name) {
    const raw = req?.headers?.cookie;
    if (!raw || typeof raw !== 'string') return null;
    const parts = raw.split(';');
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        const eqIdx = part.indexOf('=');
        if (eqIdx !== -1) {
            const key = part.substring(0, eqIdx).trim();
            if (key === name) {
                const val = part.substring(eqIdx + 1).trim();
                try {
                    return decodeURIComponent(val);
                } catch {
                    return val;
                }
            }
        }
    }
    return null;
}

function formatDeviceCookie(deviceId, secret, isSecure) {
    const signedValue = signDeviceId(deviceId, secret);
    let cookie = `${DEVICE_COOKIE_NAME}=${encodeURIComponent(signedValue)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
    if (isSecure) {
        cookie += '; Secure';
    }
    return cookie;
}

function resolveDeviceIdentity(req, secret) {
    const rawCookie = getCookie(req, DEVICE_COOKIE_NAME);
    let deviceId = verifyDeviceCookie(rawCookie, secret);
    let setCookieHeader = null;

    if (!deviceId) {
        deviceId = crypto.randomUUID();
        const isSecure = Boolean(req?.secure || String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase() === 'https');
        setCookieHeader = formatDeviceCookie(deviceId, secret, isSecure);
    }

    return { deviceId, setCookieHeader };
}

function extractClientSubnet(ip) {
    if (!ip || typeof ip !== 'string') return 'unknown';
    let cleaned = ip.trim();
    if (cleaned.startsWith('::ffff:')) {
        cleaned = cleaned.slice(7);
    }
    const ipType = net.isIP(cleaned);
    if (ipType === 4) {
        const parts = cleaned.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    if (ipType === 6) {
        if (cleaned === '::1') return '::1/64';
        let full = cleaned.toLowerCase();
        if (full.includes('::')) {
            const [leftStr, rightStr] = full.split('::');
            const left = leftStr ? leftStr.split(':').filter(Boolean) : [];
            const right = rightStr ? rightStr.split(':').filter(Boolean) : [];
            const missing = 8 - (left.length + right.length);
            const middle = new Array(Math.max(0, missing)).fill('0');
            full = [...left, ...middle, ...right].join(':');
        }
        const groups = full.split(':').map(g => g.padStart(4, '0'));
        return `${groups.slice(0, 4).join(':')}::/64`;
    }
    return 'unknown';
}

class SlidingQuotaTracker {
    constructor() {
        this.buckets = new Map();
    }

    recordSuccess(deviceId, subnet, count = 1, timestamp = Date.now()) {
        const n = Number(count);
        if (!Number.isSafeInteger(n) || n <= 0) return;
        const hour = Math.floor(timestamp / 3600000);

        if (deviceId) {
            this._increment(`dev:${deviceId}`, hour, n);
        }
        if (subnet) {
            this._increment(`sub:${subnet}`, hour, n);
        }
    }

    _increment(key, hour, count) {
        let entry = this.buckets.get(key);
        if (!entry) {
            entry = new Map();
            this.buckets.set(key, entry);
        }
        entry.set(hour, (entry.get(hour) || 0) + count);
    }

    getCount(key, windowHours = 24, now = Date.now()) {
        const entry = this.buckets.get(key);
        if (!entry) return 0;

        const currentHour = Math.floor(now / 3600000);
        const cutoffHour = currentHour - windowHours;
        let total = 0;

        for (const [hour, count] of entry.entries()) {
            if (hour <= cutoffHour) {
                entry.delete(hour);
            } else {
                total += count;
            }
        }

        if (entry.size === 0) {
            this.buckets.delete(key);
        }

        return total;
    }

    getUsage(deviceId, subnet, windowHours = 24, now = Date.now()) {
        const devCount = deviceId ? this.getCount(`dev:${deviceId}`, windowHours, now) : 0;
        const subCount = subnet ? this.getCount(`sub:${subnet}`, windowHours, now) : 0;
        const maxCount = Math.max(devCount, subCount);
        return { devCount, subCount, maxCount };
    }

    isOverQuota(deviceId, subnet, limit, windowHours = 24, now = Date.now()) {
        if (!limit || limit <= 0) return false;
        const { maxCount } = this.getUsage(deviceId, subnet, windowHours, now);
        return maxCount >= limit;
    }

    prune(windowHours = 24, now = Date.now()) {
        const currentHour = Math.floor(now / 3600000);
        const cutoffHour = currentHour - windowHours;

        for (const [key, entry] of this.buckets.entries()) {
            for (const [hour] of entry.entries()) {
                if (hour <= cutoffHour) {
                    entry.delete(hour);
                }
            }
            if (entry.size === 0) {
                this.buckets.delete(key);
            }
        }
    }

    reset() {
        this.buckets.clear();
    }
}

const quotaTracker = new SlidingQuotaTracker();
const pruneTimer = setInterval(() => quotaTracker.prune(), 30 * 60 * 1000);
if (pruneTimer.unref) pruneTimer.unref();

module.exports = {
    DEVICE_COOKIE_NAME,
    signDeviceId,
    verifyDeviceCookie,
    getCookie,
    formatDeviceCookie,
    resolveDeviceIdentity,
    extractClientSubnet,
    SlidingQuotaTracker,
    quotaTracker
};


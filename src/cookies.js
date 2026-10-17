const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
    WORK_DIR,
    PUBLIC_DIR,
    AGE_GATE_COOKIES_ENABLED,
    YTDLP_AGE_COOKIES_DIR
} = require('./config');
const { Logger } = require('./logger');

class AgeGateCookiePool {
    constructor({
        enabled = false,
        dirPath = '',
        hourlyLimit = 30,
        logger = Logger
    } = {}) {
        this.enabled = enabled;
        this.dirPath = dirPath;
        this.hourlyLimit = hourlyLimit;
        this.logger = logger;
        this.accounts = [];
        this.currentIndex = 0;
    }

    init() {
        if (!this.enabled) {
            return;
        }
        if (!this.dirPath) {
            this.logger.warn('AGE_GATE_COOKIES is enabled but YTDLP_AGE_COOKIES_DIR is not configured.');
            this.enabled = false;
            return;
        }

        const resolvedDir = path.resolve(this.dirPath);
        const publicDir = path.resolve(PUBLIC_DIR);

        // Directory validation: make sure it can NEVER be under public/ or web root
        if (resolvedDir === publicDir || resolvedDir.startsWith(publicDir + path.sep)) {
            this.logger.error('YTDLP_AGE_COOKIES_DIR is inside public directory. Disabling age-gate cookie pool for security.');
            this.enabled = false;
            return;
        }

        if (!fs.existsSync(resolvedDir)) {
            this.logger.warn(`YTDLP_AGE_COOKIES_DIR directory does not exist: [cookies_dir]`);
            this.enabled = false;
            return;
        }

        let entries;
        try {
            entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
        } catch (err) {
            this.logger.warn(`Failed to read YTDLP_AGE_COOKIES_DIR: ${err.message}`);
            this.enabled = false;
            return;
        }

        let accountIndex = 1;
        this.accounts = [];

        for (const entry of entries) {
            if (!entry.isFile() || entry.name.startsWith('.')) continue;
            const fullPath = path.join(resolvedDir, entry.name);

            try {
                const stat = fs.statSync(fullPath);
                // Check file permissions: warn if broader than owner-only (0600 / 0400)
                if ((stat.mode & 0o077) !== 0) {
                    this.logger.warn(`Cookie file permissions broader than owner-only (mode 0${(stat.mode & 0o777).toString(8)}): account-${accountIndex}`);
                }

                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split(/\r?\n/);

                // Startup validation 1: Netscape format check
                const isNetscape = lines.some(l => l.includes('# Netscape HTTP Cookie File') || l.includes('# HTTP Cookie File'));
                if (!isNetscape) {
                    this.logger.warn(`Skipping non-Netscape cookie file: account-${accountIndex}`);
                    continue;
                }

                // Startup validation 2: Domain restriction check
                const unexpectedDomains = new Set();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const parts = trimmed.split('\t');
                    if (parts.length >= 7) {
                        const domain = parts[0].toLowerCase();
                        if (!domain.includes('youtube.com') && !domain.includes('google.com')) {
                            unexpectedDomains.add(domain);
                        }
                    }
                }

                if (unexpectedDomains.size > 0) {
                    this.logger.warn(`Cookie file contains unexpected domain(s): account-${accountIndex}`);
                }

                this.accounts.push({
                    id: `account-${accountIndex++}`,
                    filename: entry.name,
                    filePath: fullPath,
                    active: false,
                    cooldownUntil: 0,
                    failCount: 0,
                    hourlyUsage: []
                });
            } catch (err) {
                this.logger.warn(`Failed to inspect cookie file: ${err.message}`);
            }
        }

        if (this.accounts.length === 0) {
            this.logger.warn('No valid Netscape cookie files found in YTDLP_AGE_COOKIES_DIR.');
            this.enabled = false;
        } else {
            this.logger.info(`Age-gate cookie pool initialized with ${this.accounts.length} valid account(s)`);
        }
    }

    isEnabled() {
        return Boolean(this.enabled && this.accounts.length > 0);
    }

    getHealthyAccount() {
        if (!this.isEnabled()) return null;
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        const count = this.accounts.length;

        for (let i = 0; i < count; i++) {
            const idx = (this.currentIndex + i) % count;
            const acc = this.accounts[idx];

            // clean up hourlyUsage
            acc.hourlyUsage = acc.hourlyUsage.filter(ts => ts > oneHourAgo);

            // check active, cooldown, quota
            if (!acc.active && now >= acc.cooldownUntil && acc.hourlyUsage.length < this.hourlyLimit) {
                this.currentIndex = (idx + 1) % count;
                return acc;
            }
        }
        return null;
    }

    async acquire() {
        const account = this.getHealthyAccount();
        if (!account) return null;

        account.active = true;
        const tempCookiePath = path.join(WORK_DIR, `ripcord_cookie_${randomUUID()}.tmp`);

        try {
            const fd = fs.openSync(tempCookiePath, 'w', 0o600);
            const content = fs.readFileSync(account.filePath);
            fs.writeSync(fd, content);
            fs.closeSync(fd);
        } catch (err) {
            account.active = false;
            try { fs.unlinkSync(tempCookiePath); } catch {}
            throw err;
        }

        const release = (success = false, err = null) => {
            try {
                if (success) {
                    account.failCount = 0;
                    account.hourlyUsage.push(Date.now());

                    // Atomic copy-back if updated
                    try {
                        if (fs.existsSync(tempCookiePath)) {
                            const newContent = fs.readFileSync(tempCookiePath);
                            const oldContent = fs.readFileSync(account.filePath);
                            if (Buffer.compare(newContent, oldContent) !== 0) {
                                const tmpDst = `${account.filePath}.tmp.${randomUUID()}`;
                                const fd = fs.openSync(tmpDst, 'w', 0o600);
                                fs.writeSync(fd, newContent);
                                fs.closeSync(fd);
                                fs.renameSync(tmpDst, account.filePath);
                            }
                        }
                    } catch (syncErr) {
                        this.logger.warn(`Failed to atomic copy-back cookie updates for [${account.id}]: ${syncErr.message}`);
                    }
                } else if (err) {
                    const code = err.code || '';
                    if (code === 'LOGIN_REQUIRED' || code === 'RATE_LIMITED') {
                        account.failCount++;
                        const backoffMs = Math.min(3600000, 60000 * Math.pow(2, account.failCount - 1));
                        account.cooldownUntil = Date.now() + backoffMs;
                        this.logger.warn(`Age-gate account [${account.id}] entering cooldown for ${Math.round(backoffMs / 1000)}s`);
                    }
                }
            } finally {
                try {
                    if (fs.existsSync(tempCookiePath)) {
                        fs.unlinkSync(tempCookiePath);
                    }
                } catch {}
                account.active = false;
            }
        };

        return {
            account,
            cookiePath: tempCookiePath,
            release
        };
    }
}

// In-memory 24h LRU cache of age-restricted video IDs across jobs
class AgeGateLruCache {
    constructor(maxSize = 1000, ttlMs = 24 * 60 * 60 * 1000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.cache = new Map(); // videoId -> timestamp
    }

    has(videoId) {
        if (!videoId || !this.cache.has(videoId)) return false;
        const entryTime = this.cache.get(videoId);
        if (Date.now() - entryTime > this.ttlMs) {
            this.cache.delete(videoId);
            return false;
        }
        // Refresh position in Map for LRU order
        this.cache.delete(videoId);
        this.cache.set(videoId, entryTime);
        return true;
    }

    add(videoId) {
        if (!videoId) return;
        if (this.cache.has(videoId)) {
            this.cache.delete(videoId);
        } else if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) this.cache.delete(oldestKey);
        }
        this.cache.set(videoId, Date.now());
    }

    clear() {
        this.cache.clear();
    }
}

const ageGateCookiePool = new AgeGateCookiePool({
    enabled: AGE_GATE_COOKIES_ENABLED,
    dirPath: YTDLP_AGE_COOKIES_DIR,
    logger: Logger
});
ageGateCookiePool.init();

const ageRestrictedCache = new AgeGateLruCache(1000, 24 * 60 * 60 * 1000);

module.exports = {
    AgeGateCookiePool,
    ageGateCookiePool,
    AgeGateLruCache,
    ageRestrictedCache
};

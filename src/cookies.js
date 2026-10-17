const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = crypto;
const {
    WORK_DIR,
    PUBLIC_DIR,
    AGE_GATE_COOKIES_ENABLED,
    YTDLP_AGE_COOKIES_DIR,
    COOKIE_BUDGET_CACHE_FILE,
    COOKIE_GUARD_SECRET_FILE
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

class CookieGuard {
    constructor({
        pool = null,
        budgetFile = COOKIE_BUDGET_CACHE_FILE,
        secretFile = COOKIE_GUARD_SECRET_FILE,
        workDir = WORK_DIR,
        logger = Logger,
        perAccountHourlyLimit = 20,
        perAccountDailyLimit = 100,
        globalHourlyLimit = 40,
        perIpHourlyLimit = 3,
        perIpDailyLimit = 8,
        perIpDistinctIdsLimit = 5,
        perSubnetHourlyLimit = 8,
        perSubnetDailyLimit = 20,
        maxQueueSize = 5,
        queueTimeoutMs = 60000,
        jitterMinMs = 20000,
        jitterMaxMs = 40000,
        sourceCacheTtlMs = 15 * 60 * 1000,
        sourceCacheMaxBytes = 500 * 1024 * 1024,
        failedCookieTtlMs = 60 * 60 * 1000
    } = {}) {
        this.pool = pool;
        this.budgetFile = budgetFile;
        this.secretFile = secretFile;
        this.workDir = workDir;
        this.logger = logger;
        this.serverSecret = this.initServerSecret(this.secretFile);
        this.perAccountHourlyLimit = perAccountHourlyLimit;
        this.perAccountDailyLimit = perAccountDailyLimit;
        this.globalHourlyLimit = globalHourlyLimit;
        this.perIpHourlyLimit = perIpHourlyLimit;
        this.perIpDailyLimit = perIpDailyLimit;
        this.perIpDistinctIdsLimit = perIpDistinctIdsLimit;
        this.perSubnetHourlyLimit = perSubnetHourlyLimit;
        this.perSubnetDailyLimit = perSubnetDailyLimit;
        this.maxQueueSize = maxQueueSize;
        this.queueTimeoutMs = queueTimeoutMs;
        this.jitterMinMs = jitterMinMs;
        this.jitterMaxMs = jitterMaxMs;
        this.sourceCacheTtlMs = sourceCacheTtlMs;
        this.sourceCacheMaxBytes = sourceCacheMaxBytes;
        this.failedCookieTtlMs = failedCookieTtlMs;

        this.sourceCacheDir = path.join(this.workDir, 'source_cache');
        try { fs.mkdirSync(this.sourceCacheDir, { recursive: true }); } catch {}

        this.queue = []; // FIFO queue of waiting requests: [{ id, ip, subnet, videoId, kind, signal, resolve, reject, enqueuedAt, timer }]
        this.inFlightDownloads = new Map(); // videoId -> Promise<{ success, tempAudioPath, error }>
        this.sourceAudioCache = new Map(); // videoId -> { filePath, size, createdAt, expiresAt }
        this.failedCookieCache = new Map(); // videoId -> timestamp

        this.circuitBreaker = {
            state: 'CLOSED', // 'CLOSED' | 'PAUSED' | 'HALF_OPEN'
            pausedUntil: 0,
            botChecks: [], // [{ accountId, ts }]
            probeInFlight: false
        };

        this.globalUsage = []; // timestamps
        this.accountUsage = new Map(); // accountId -> { hourly: [], daily: [], gapUntil: 0 }
        this.ipUsage = new Map(); // ip -> { hourly: [], daily: [], videoIds: Map, blockedUntil: 0, strikes: 0 }
        this.subnetUsage = new Map(); // subnet -> { hourly: [], daily: [] }

        this.metrics = {
            leasesGranted: 0,
            denialsByReason: {},
            periodLeasesGranted: 0,
            periodDenialsByReason: {}
        };

        this.dailySalt = randomUUID();
        this.saltDay = new Date().toISOString().slice(0, 10);

        this.saveTimeout = null;
        this.initPersistence();

        this.summaryInterval = setInterval(() => this.logSummary(), 10 * 60 * 1000);
        this.summaryInterval.unref();

        this.sweepInterval = setInterval(() => this.sweepCaches(), 5 * 60 * 1000);
        this.sweepInterval.unref();
    }

    isEnabled() {
        return Boolean(this.pool && this.pool.isEnabled() && !this.isKillSwitched());
    }

    isKillSwitched() {
        if (!this.pool || !this.pool.dirPath) return false;
        try {
            return fs.existsSync(path.join(this.pool.dirPath, '.disabled'));
        } catch {
            return false;
        }
    }

    getDailySalt() {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== this.saltDay) {
            this.saltDay = today;
            this.dailySalt = randomUUID();
        }
        return this.dailySalt;
    }

    initServerSecret(secretFile) {
        if (!secretFile) {
            return crypto.randomBytes(32).toString('hex');
        }
        try {
            const dir = path.dirname(secretFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            if (fs.existsSync(secretFile)) {
                const stat = fs.statSync(secretFile);
                if ((stat.mode & 0o077) !== 0) {
                    this.logger.warn(`[cookie_guard] Server secret file permissions broader than owner-only (mode 0${(stat.mode & 0o777).toString(8)})`);
                }
                const secret = fs.readFileSync(secretFile, 'utf8').trim();
                if (secret.length >= 32) return secret;
            }

            const newSecret = crypto.randomBytes(32).toString('hex');
            const fd = fs.openSync(secretFile, 'w', 0o600);
            fs.writeSync(fd, newSecret);
            fs.closeSync(fd);
            return newSecret;
        } catch (err) {
            this.logger.warn(`[cookie_guard] Could not initialize secret file: ${err.message}. Using ephemeral in-memory secret.`);
            return crypto.randomBytes(32).toString('hex');
        }
    }

    hmacKey(val) {
        if (!val || typeof val !== 'string') return 'unknown';
        return crypto.createHmac('sha256', this.serverSecret).update(val).digest('hex');
    }

    hashIp(ip) {
        if (!ip || typeof ip !== 'string') return 'unknown';
        const salt = this.getDailySalt();
        return crypto.createHash('sha256').update(salt + ip).digest('hex').slice(0, 12);
    }

    getSubnet(ip) {
        if (!ip || typeof ip !== 'string') return 'unknown';
        let clean = ip.trim();
        if (clean.startsWith('::ffff:')) clean = clean.slice(7);
        if (clean.includes('.')) {
            const parts = clean.split('.');
            if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
        } else if (clean.includes(':')) {
            const parts = clean.split(':');
            return parts.slice(0, 4).join(':') + '::/64';
        }
        return clean;
    }

    getIpRecord(ip) {
        const key = this.hmacKey(ip);
        let rec = this.ipUsage.get(key);
        if (!rec) {
            rec = {
                hourly: [],
                daily: [],
                videoIds: new Map(),
                blockedUntil: 0,
                strikes: 0,
                lastSeen: Date.now()
            };
            this.ipUsage.set(key, rec);
        }
        rec.lastSeen = Date.now();
        return rec;
    }

    getSubnetRecord(subnet) {
        const key = this.hmacKey(subnet);
        let rec = this.subnetUsage.get(key);
        if (!rec) {
            rec = { hourly: [], daily: [], lastSeen: Date.now() };
            this.subnetUsage.set(key, rec);
        }
        rec.lastSeen = Date.now();
        return rec;
    }

    pruneBudgets() {
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        const oneDayAgo = now - 86400000;
        const sevenDaysAgo = now - 7 * 86400000;

        this.globalUsage = this.globalUsage.filter(ts => ts > oneHourAgo);

        for (const [key, rec] of this.ipUsage.entries()) {
            rec.hourly = rec.hourly.filter(ts => ts > oneHourAgo);
            rec.daily = rec.daily.filter(ts => ts > oneDayAgo);
            for (const [v, ts] of rec.videoIds.entries()) {
                if (ts <= oneHourAgo) rec.videoIds.delete(v);
            }

            const lastActivity = Math.max(rec.lastSeen || 0, rec.blockedUntil || 0, ...rec.daily);
            if (rec.hourly.length === 0 && rec.daily.length === 0 && rec.videoIds.size === 0) {
                if (rec.strikes > 0) {
                    if (lastActivity < sevenDaysAgo) {
                        this.ipUsage.delete(key);
                    }
                } else if (lastActivity < oneDayAgo) {
                    this.ipUsage.delete(key);
                }
            }
        }

        for (const [key, rec] of this.subnetUsage.entries()) {
            rec.hourly = rec.hourly.filter(ts => ts > oneHourAgo);
            rec.daily = rec.daily.filter(ts => ts > oneDayAgo);
            const lastActivity = Math.max(rec.lastSeen || 0, ...rec.daily);
            if (rec.hourly.length === 0 && rec.daily.length === 0 && lastActivity < oneDayAgo) {
                this.subnetUsage.delete(key);
            }
        }
    }

    getAccountUsage(accountId) {
        let rec = this.accountUsage.get(accountId);
        if (!rec) {
            rec = { hourly: [], daily: [], gapUntil: 0 };
            this.accountUsage.set(accountId, rec);
        }
        return rec;
    }

    recordDenial(reason) {
        this.metrics.denialsByReason[reason] = (this.metrics.denialsByReason[reason] || 0) + 1;
        this.metrics.periodDenialsByReason[reason] = (this.metrics.periodDenialsByReason[reason] || 0) + 1;
    }

    checkLimits(ip, subnet, videoId) {
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        const oneDayAgo = now - 86400000;

        const ipRecord = this.getIpRecord(ip);
        if (ipRecord.blockedUntil && now < ipRecord.blockedUntil) {
            return { ok: false, reason: 'IP_BLOCKED' };
        }

        this.globalUsage = this.globalUsage.filter(ts => ts > oneHourAgo);
        if (this.globalUsage.length >= this.globalHourlyLimit) {
            return { ok: false, reason: 'GLOBAL_HOURLY_LIMIT' };
        }

        ipRecord.hourly = ipRecord.hourly.filter(ts => ts > oneHourAgo);
        ipRecord.daily = ipRecord.daily.filter(ts => ts > oneDayAgo);

        for (const [vid, ts] of ipRecord.videoIds.entries()) {
            if (ts <= oneHourAgo) ipRecord.videoIds.delete(vid);
        }

        if (ipRecord.hourly.length >= this.perIpHourlyLimit) {
            this.escalateIp(ip, ipRecord);
            return { ok: false, reason: 'IP_HOURLY_LIMIT' };
        }
        if (ipRecord.daily.length >= this.perIpDailyLimit) {
            this.escalateIp(ip, ipRecord);
            return { ok: false, reason: 'IP_DAILY_LIMIT' };
        }
        if (videoId && !ipRecord.videoIds.has(videoId) && ipRecord.videoIds.size >= this.perIpDistinctIdsLimit) {
            this.escalateIp(ip, ipRecord);
            return { ok: false, reason: 'IP_DISTINCT_IDS_LIMIT' };
        }

        const subnetRecord = this.getSubnetRecord(subnet);
        subnetRecord.hourly = subnetRecord.hourly.filter(ts => ts > oneHourAgo);
        subnetRecord.daily = subnetRecord.daily.filter(ts => ts > oneDayAgo);
        if (subnetRecord.hourly.length >= this.perSubnetHourlyLimit) {
            return { ok: false, reason: 'SUBNET_HOURLY_LIMIT' };
        }
        if (subnetRecord.daily.length >= this.perSubnetDailyLimit) {
            return { ok: false, reason: 'SUBNET_DAILY_LIMIT' };
        }

        return { ok: true };
    }

    escalateIp(ip, ipRecord) {
        ipRecord.strikes = (ipRecord.strikes || 0) + 1;
        const blockDuration = ipRecord.strikes === 1 ? 3600000 : 24 * 3600000;
        ipRecord.blockedUntil = Date.now() + blockDuration;
        this.logger.warn(`[cookie_guard] Anomaly detected: IP [${this.hashIp(ip)}] escalated to strike ${ipRecord.strikes}, blocked from cookie path for ${Math.round(blockDuration / 3600000)}h`);
    }

    checkCircuitBreaker() {
        const now = Date.now();
        if (this.circuitBreaker.state === 'PAUSED') {
            if (now >= this.circuitBreaker.pausedUntil) {
                this.circuitBreaker.state = 'HALF_OPEN';
                this.circuitBreaker.probeInFlight = false;
                this.logger.info('[cookie_guard] Circuit breaker transitioning to HALF_OPEN (probing)');
                this.scheduleSave();
            } else {
                return { ok: false, reason: 'CIRCUIT_BREAKER_PAUSED' };
            }
        }

        if (this.circuitBreaker.state === 'HALF_OPEN') {
            if (this.circuitBreaker.probeInFlight) {
                return { ok: false, reason: 'CIRCUIT_BREAKER_PROBE_BUSY' };
            }
            return { ok: true, isProbe: true };
        }

        return { ok: true, isProbe: false };
    }

    recordBotCheck(accountId) {
        const now = Date.now();
        const windowStart = now - 15 * 60 * 1000;
        this.circuitBreaker.botChecks.push({ accountId, ts: now });
        this.circuitBreaker.botChecks = this.circuitBreaker.botChecks.filter(b => b.ts > windowStart);

        const distinctAccounts = new Set(this.circuitBreaker.botChecks.map(b => b.accountId));
        if (distinctAccounts.size >= 2 && this.circuitBreaker.state !== 'PAUSED') {
            this.circuitBreaker.state = 'PAUSED';
            this.circuitBreaker.pausedUntil = now + 45 * 60 * 1000;
            this.logger.warn(`[cookie_guard] Circuit breaker TRIPPED: bot check on multiple accounts (${distinctAccounts.size}). All cookie use paused for 45 min.`);
            this.scheduleSave();
        }
    }

    getAvailableAccount() {
        if (!this.pool || !this.pool.isEnabled()) return null;
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        const oneDayAgo = now - 86400000;

        const count = this.pool.accounts.length;
        for (let i = 0; i < count; i++) {
            const idx = (this.pool.currentIndex + i) % count;
            const acc = this.pool.accounts[idx];
            const usage = this.getAccountUsage(acc.id);

            usage.hourly = usage.hourly.filter(ts => ts > oneHourAgo);
            usage.daily = usage.daily.filter(ts => ts > oneDayAgo);

            if (!acc.active &&
                now >= acc.cooldownUntil &&
                now >= (usage.gapUntil || 0) &&
                usage.hourly.length < this.perAccountHourlyLimit &&
                usage.daily.length < this.perAccountDailyLimit) {
                this.pool.currentIndex = (idx + 1) % count;
                return acc;
            }
        }
        return null;
    }

    async acquire({ ip = '127.0.0.1', videoId = null, kind = 'single', signal = null, logger = Logger } = {}) {
        const cleanIp = (typeof ip === 'string' && ip.trim()) ? (ip.startsWith('::ffff:') ? ip.slice(7) : ip) : '127.0.0.1';
        const subnet = this.getSubnet(cleanIp);
        const ipHash = this.hashIp(cleanIp);

        // 1. Kill switch
        if (this.isKillSwitched()) {
            this.recordDenial('KILL_SWITCH');
            logger.info(`[cookie_guard] Lease denied: kill switch active (.disabled file present) [ip=${ipHash}]`);
            return { status: 'deny', reason: 'KILL_SWITCH' };
        }

        // 2. Pool enabled
        if (!this.pool || !this.pool.isEnabled()) {
            this.recordDenial('NO_POOL');
            return { status: 'deny', reason: 'NO_POOL' };
        }

        // 3. Known failed cookie check (TTL 1h)
        if (videoId && this.failedCookieCache.has(videoId)) {
            const failedAt = this.failedCookieCache.get(videoId);
            if (Date.now() - failedAt < this.failedCookieTtlMs) {
                this.recordDenial('KNOWN_FAILED_COOKIE');
                logger.info(`[cookie_guard] Video [${videoId}] failed previously with cookies within 1h; skipping retry [ip=${ipHash}]`);
                return { status: 'deny', reason: 'KNOWN_FAILED_COOKIE' };
            } else {
                this.failedCookieCache.delete(videoId);
            }
        }

        // 4. Source Audio Cache check (TTL 15m)
        if (videoId && this.hasCachedSourceAudio(videoId)) {
            const copyPath = this.createSourceAudioCopy(videoId);
            if (copyPath) {
                logger.info(`[cookie_guard] Source audio cache HIT for [${videoId}] [ip=${ipHash}]`);
                return {
                    status: 'allow',
                    fromCache: true,
                    tempAudioPath: copyPath,
                    release: () => {}
                };
            }
        }

        // 5. Coalescing: In-flight download check
        if (videoId && this.inFlightDownloads.has(videoId)) {
            logger.info(`[cookie_guard] Coalescing with in-flight download for [${videoId}] [ip=${ipHash}]`);
            try {
                const inFlightResult = await this.inFlightDownloads.get(videoId);
                if (inFlightResult?.success) {
                    const copyPath = this.createSourceAudioCopy(videoId);
                    if (copyPath) {
                        return {
                            status: 'allow',
                            fromCache: true,
                            tempAudioPath: copyPath,
                            release: () => {}
                        };
                    }
                }
                return { status: 'deny', reason: 'IN_FLIGHT_FAILED' };
            } catch {
                return { status: 'deny', reason: 'IN_FLIGHT_ERROR' };
            }
        }

        // 6. Circuit breaker check
        const breakerCheck = this.checkCircuitBreaker();
        if (!breakerCheck.ok) {
            this.recordDenial(breakerCheck.reason);
            logger.info(`[cookie_guard] Lease denied: circuit breaker ${this.circuitBreaker.state} [ip=${ipHash}]`);
            return { status: 'deny', reason: breakerCheck.reason };
        }

        // 7. Check Limits (IP, Subnet, Global)
        const limits = this.checkLimits(cleanIp, subnet, videoId);
        if (!limits.ok) {
            this.recordDenial(limits.reason);
            logger.info(`[cookie_guard] Lease denied: limit exceeded (${limits.reason}) [ip=${ipHash}]`);
            return { status: 'deny', reason: limits.reason };
        }

        // 8. Try immediate acquisition
        const account = this.getAvailableAccount();
        if (account && this.queue.length === 0) {
            return this.grantLease(cleanIp, subnet, videoId, kind, account, breakerCheck.isProbe);
        }

        // 9. Queue check
        if (this.queue.length >= this.maxQueueSize) {
            this.recordDenial('QUEUE_FULL');
            logger.info(`[cookie_guard] Lease denied: queue full (${this.queue.length}/${this.maxQueueSize}) [ip=${ipHash}]`);
            return { status: 'deny', reason: 'QUEUE_FULL' };
        }

        if (this.queue.some(item => item.ip === cleanIp)) {
            this.recordDenial('IP_ALREADY_PENDING');
            logger.info(`[cookie_guard] Lease denied: IP already has pending request in queue [ip=${ipHash}]`);
            return { status: 'deny', reason: 'IP_ALREADY_PENDING' };
        }

        // Enqueue into FIFO queue
        logger.info(`[cookie_guard] Enqueuing request (queue length: ${this.queue.length + 1}) [ip=${ipHash}]`);
        return new Promise((resolve, reject) => {
            const item = {
                id: randomUUID(),
                ip: cleanIp,
                subnet,
                videoId,
                kind,
                signal,
                resolve,
                reject,
                enqueuedAt: Date.now()
            };

            item.timer = setTimeout(() => {
                const idx = this.queue.indexOf(item);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                    this.recordDenial('QUEUE_TIMEOUT');
                    logger.info(`[cookie_guard] Queued request timed out after ${Math.round(this.queueTimeoutMs / 1000)}s [ip=${ipHash}]`);
                    resolve({ status: 'deny', reason: 'QUEUE_TIMEOUT' });
                }
            }, this.queueTimeoutMs);

            if (signal) {
                const abortHandler = () => {
                    clearTimeout(item.timer);
                    const idx = this.queue.indexOf(item);
                    if (idx !== -1) {
                        this.queue.splice(idx, 1);
                        resolve({ status: 'deny', reason: 'CANCELLED' });
                    }
                };
                if (signal.aborted) abortHandler();
                else signal.addEventListener('abort', abortHandler, { once: true });
            }

            this.queue.push(item);
        });
    }

    async grantLease(ip, subnet, videoId, kind, account, isProbe = false) {
        const ipHash = this.hashIp(ip);
        account.active = true;
        if (isProbe) this.circuitBreaker.probeInFlight = true;

        const tempCookiePath = path.join(this.workDir, `ripcord_cookie_${randomUUID()}.tmp`);
        try {
            const fd = fs.openSync(tempCookiePath, 'w', 0o600);
            const content = fs.readFileSync(account.filePath);
            fs.writeSync(fd, content);
            fs.closeSync(fd);
        } catch (err) {
            account.active = false;
            if (isProbe) this.circuitBreaker.probeInFlight = false;
            try { fs.unlinkSync(tempCookiePath); } catch {}
            throw err;
        }

        let inFlightDeferred = null;
        if (videoId) {
            let resolveInFlight, rejectInFlight;
            const inFlightPromise = new Promise((res, rej) => {
                resolveInFlight = res;
                rejectInFlight = rej;
            });
            inFlightDeferred = { resolve: resolveInFlight, reject: rejectInFlight };
            this.inFlightDownloads.set(videoId, inFlightPromise);
        }

        this.metrics.leasesGranted++;
        this.metrics.periodLeasesGranted++;
        this.logger.info(`[cookie_guard] Lease granted: [${account.id}] for video [${videoId || 'unknown'}] [kind=${kind}, ip=${ipHash}]`);

        let released = false;
        const release = (success = false, err = null, downloadedAudioPath = null) => {
            if (released) return;
            released = true;

            const now = Date.now();
            try {
                if (success) {
                    this.globalUsage.push(now);
                    const ipRec = this.getIpRecord(ip);
                    ipRec.hourly.push(now);
                    ipRec.daily.push(now);
                    if (videoId) ipRec.videoIds.set(videoId, now);

                    const subRec = this.getSubnetRecord(subnet);
                    subRec.hourly.push(now);
                    subRec.daily.push(now);

                    const accUsage = this.getAccountUsage(account.id);
                    accUsage.hourly.push(now);
                    accUsage.daily.push(now);

                    const jitter = this.jitterMinMs + Math.random() * (this.jitterMaxMs - this.jitterMinMs);
                    accUsage.gapUntil = now + jitter;

                    account.failCount = 0;

                    if (this.circuitBreaker.state === 'HALF_OPEN') {
                        this.circuitBreaker.state = 'CLOSED';
                        this.circuitBreaker.botChecks = [];
                        this.circuitBreaker.probeInFlight = false;
                        this.logger.info('[cookie_guard] Circuit breaker probe succeeded. Breaker reset to CLOSED.');
                    }

                    if (videoId && downloadedAudioPath && fs.existsSync(downloadedAudioPath)) {
                        this.cacheSourceAudio(videoId, downloadedAudioPath);
                    }

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
                    } catch (copyErr) {
                        this.logger.warn(`[cookie_guard] Failed atomic copy-back for [${account.id}]: ${copyErr.message}`);
                    }

                    if (inFlightDeferred) {
                        inFlightDeferred.resolve({ success: true, tempAudioPath: downloadedAudioPath });
                    }
                } else {
                    if (isProbe) this.circuitBreaker.probeInFlight = false;
                    const code = err?.code || '';
                    if (code === 'LOGIN_REQUIRED' || code === 'RATE_LIMITED' || /confirm your age|bot verification|captcha/i.test(err?.stderr || '')) {
                        account.failCount = (account.failCount || 0) + 1;
                        const backoffMs = Math.min(3600000, 60000 * Math.pow(2, account.failCount - 1));
                        account.cooldownUntil = now + backoffMs;
                        this.logger.warn(`[cookie_guard] Account [${account.id}] entering backoff cooldown for ${Math.round(backoffMs / 1000)}s (${code})`);
                        this.recordBotCheck(account.id);
                    }

                    if (videoId) {
                        this.failedCookieCache.set(videoId, now);
                    }

                    if (inFlightDeferred) {
                        inFlightDeferred.resolve({ success: false, error: err });
                    }
                }
            } finally {
                try {
                    if (fs.existsSync(tempCookiePath)) fs.unlinkSync(tempCookiePath);
                } catch {}
                account.active = false;
                if (videoId) this.inFlightDownloads.delete(videoId);
                this.scheduleSave();

                setImmediate(() => this.processQueue());

                const gapDelay = (this.getAccountUsage(account.id).gapUntil || now) - now;
                if (gapDelay > 0) {
                    setTimeout(() => this.processQueue(), gapDelay + 100).unref();
                }
            }
        };

        return {
            status: 'allow',
            lease: {
                account,
                cookiePath: tempCookiePath
            },
            release
        };
    }

    processQueue() {
        if (this.queue.length === 0) return;
        if (this.isKillSwitched()) {
            this.drainQueue('KILL_SWITCH');
            return;
        }

        const breakerCheck = this.checkCircuitBreaker();
        if (!breakerCheck.ok) return;

        for (let i = 0; i < this.queue.length; i++) {
            const item = this.queue[i];
            if (item.signal?.aborted) {
                clearTimeout(item.timer);
                this.queue.splice(i, 1);
                i--;
                item.resolve({ status: 'deny', reason: 'CANCELLED' });
                continue;
            }

            const limits = this.checkLimits(item.ip, item.subnet, item.videoId);
            if (!limits.ok) {
                clearTimeout(item.timer);
                this.queue.splice(i, 1);
                i--;
                item.resolve({ status: 'deny', reason: limits.reason });
                continue;
            }

            const account = this.getAvailableAccount();
            if (!account) {
                break;
            }

            clearTimeout(item.timer);
            this.queue.splice(i, 1);
            this.grantLease(item.ip, item.subnet, item.videoId, item.kind, account, breakerCheck.isProbe)
                .then(leaseResult => item.resolve(leaseResult))
                .catch(err => item.reject(err));
            break;
        }
    }

    drainQueue(reason) {
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (item.timer) clearTimeout(item.timer);
            item.resolve({ status: 'deny', reason });
        }
    }

    cacheSourceAudio(videoId, filePath) {
        if (!videoId || !filePath) return;
        try {
            const stat = fs.statSync(filePath);
            const ext = path.extname(filePath) || '.audio';
            const destName = `cached_${videoId}_${randomUUID()}${ext}`;
            const destPath = path.join(this.sourceCacheDir, destName);
            fs.copyFileSync(filePath, destPath);

            const now = Date.now();
            this.sourceAudioCache.set(videoId, {
                filePath: destPath,
                size: stat.size,
                createdAt: now,
                expiresAt: now + this.sourceCacheTtlMs
            });

            this.logger.info(`[cookie_guard] Source audio cached for [${videoId}] (${(stat.size / 1024 / 1024).toFixed(2)} MB, TTL ${Math.round(this.sourceCacheTtlMs / 60000)}m)`);
            this.enforceSourceCacheSize();
        } catch (err) {
            this.logger.warn(`[cookie_guard] Failed to cache source audio for [${videoId}]: ${err.message}`);
        }
    }

    hasCachedSourceAudio(videoId) {
        if (!videoId || !this.sourceAudioCache.has(videoId)) return false;
        const entry = this.sourceAudioCache.get(videoId);
        if (Date.now() > entry.expiresAt) {
            this.unlinkCachedEntry(videoId);
            return false;
        }
        return true;
    }

    createSourceAudioCopy(videoId) {
        const entry = this.sourceAudioCache.get(videoId);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.unlinkCachedEntry(videoId);
            return null;
        }
        try {
            const ext = path.extname(entry.filePath);
            const copyPath = path.join(this.workDir, `ripcord_src_copy_${randomUUID()}${ext}`);
            fs.copyFileSync(entry.filePath, copyPath);
            return copyPath;
        } catch (err) {
            this.logger.warn(`[cookie_guard] Failed to copy cached source audio for [${videoId}]: ${err.message}`);
            return null;
        }
    }

    enforceSourceCacheSize() {
        let totalBytes = 0;
        for (const entry of this.sourceAudioCache.values()) {
            totalBytes += entry.size || 0;
        }
        if (totalBytes <= this.sourceCacheMaxBytes) return;

        const sortedEntries = [...this.sourceAudioCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (const [vid, entry] of sortedEntries) {
            this.unlinkCachedEntry(vid);
            totalBytes -= entry.size || 0;
            if (totalBytes <= this.sourceCacheMaxBytes) break;
        }
    }

    unlinkCachedEntry(videoId) {
        const entry = this.sourceAudioCache.get(videoId);
        if (entry) {
            try {
                if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
            } catch {}
            this.sourceAudioCache.delete(videoId);
        }
    }

    sweepCaches() {
        const now = Date.now();
        for (const [vid, entry] of this.sourceAudioCache.entries()) {
            if (now > entry.expiresAt) {
                this.unlinkCachedEntry(vid);
            }
        }
        for (const [vid, ts] of this.failedCookieCache.entries()) {
            if (now - ts > this.failedCookieTtlMs) {
                this.failedCookieCache.delete(vid);
            }
        }
        this.pruneBudgets();
    }

    logSummary() {
        const accountStates = {};
        if (this.pool?.accounts) {
            const now = Date.now();
            for (const acc of this.pool.accounts) {
                const usage = this.getAccountUsage(acc.id);
                let state = acc.active ? 'active' : 'idle';
                if (now < acc.cooldownUntil) {
                    state = `cooldown (${Math.round((acc.cooldownUntil - now) / 1000)}s left)`;
                } else if (now < (usage.gapUntil || 0)) {
                    state = `gap (${Math.round((usage.gapUntil - now) / 1000)}s left)`;
                }
                accountStates[acc.id] = `${state} [hourly: ${usage.hourly.length}/${this.perAccountHourlyLimit}]`;
            }
        }

        const summary = {
            event: 'cookie_guard_summary',
            periodLeasesGranted: this.metrics.periodLeasesGranted,
            totalLeasesGranted: this.metrics.leasesGranted,
            periodDenials: { ...this.metrics.periodDenialsByReason },
            circuitBreaker: this.circuitBreaker.state,
            queueLength: this.queue.length,
            cachedSourceAudioFiles: this.sourceAudioCache.size,
            activeHashedIpsCount: this.ipUsage.size,
            accountStates
        };

        this.logger.info(`[cookie_guard] 10-minute summary: leases=${summary.periodLeasesGranted} (total=${summary.totalLeasesGranted}), breaker=${summary.circuitBreaker}, queue=${summary.queueLength}, denials=${JSON.stringify(summary.periodDenials)}`);

        this.metrics.periodLeasesGranted = 0;
        this.metrics.periodDenialsByReason = {};
    }

    initPersistence() {
        if (!this.budgetFile) return;
        try {
            if (fs.existsSync(this.budgetFile)) {
                const data = JSON.parse(fs.readFileSync(this.budgetFile, 'utf8'));
                if (data.version === 1) {
                    const now = Date.now();
                    const oneDayAgo = now - 86400000;

                    this.globalUsage = (data.globalUsage || []).filter(ts => ts > oneDayAgo);

                    if (data.accountUsage) {
                        for (const [id, acc] of Object.entries(data.accountUsage)) {
                            this.accountUsage.set(id, {
                                hourly: (acc.hourly || []).filter(ts => ts > now - 3600000),
                                daily: (acc.daily || []).filter(ts => ts > oneDayAgo),
                                gapUntil: acc.gapUntil || 0
                            });
                        }
                    }

                    if (data.ipUsage) {
                        let discardedCount = 0;
                        for (const [key, rec] of Object.entries(data.ipUsage)) {
                            if (!/^[0-9a-f]{64}$/i.test(key)) {
                                discardedCount++;
                                continue;
                            }
                            const videoIds = new Map();
                            if (rec.videoIds) {
                                for (const [v, ts] of Object.entries(rec.videoIds)) {
                                    if (ts > now - 3600000) videoIds.set(v, ts);
                                }
                            }
                            this.ipUsage.set(key, {
                                hourly: (rec.hourly || []).filter(ts => ts > now - 3600000),
                                daily: (rec.daily || []).filter(ts => ts > oneDayAgo),
                                videoIds,
                                blockedUntil: rec.blockedUntil || 0,
                                strikes: rec.strikes || 0,
                                lastSeen: rec.lastSeen || now
                            });
                        }
                        if (discardedCount > 0) {
                            this.logger.info(`[cookie_guard] Discarded ${discardedCount} legacy unhashed IP entries from cookie_budgets.json for privacy`);
                        }
                    }

                    if (data.subnetUsage) {
                        for (const [key, rec] of Object.entries(data.subnetUsage)) {
                            if (!/^[0-9a-f]{64}$/i.test(key)) continue;
                            this.subnetUsage.set(key, {
                                hourly: (rec.hourly || []).filter(ts => ts > now - 3600000),
                                daily: (rec.daily || []).filter(ts => ts > oneDayAgo),
                                lastSeen: rec.lastSeen || now
                            });
                        }
                    }

                    if (data.circuitBreaker) {
                        this.circuitBreaker.state = data.circuitBreaker.state || 'CLOSED';
                        this.circuitBreaker.pausedUntil = data.circuitBreaker.pausedUntil || 0;
                        this.circuitBreaker.botChecks = (data.circuitBreaker.botChecks || []).filter(b => b.ts > now - 15 * 60 * 1000);
                    }

                    this.pruneBudgets();
                    this.logger.info(`[cookie_guard] Restored persisted budgets from ${path.basename(this.budgetFile)}`);
                }
            }
        } catch (err) {
            this.logger.warn(`[cookie_guard] Could not load cookie budgets: ${err.message}`);
        }
    }

    scheduleSave() {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.flush();
        }, 1000);
    }

    flush() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        if (!this.budgetFile) return;
        try {
            this.pruneBudgets();
            const dir = path.dirname(this.budgetFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const accountUsageObj = {};
            for (const [id, acc] of this.accountUsage.entries()) {
                accountUsageObj[id] = acc;
            }

            const ipUsageObj = {};
            for (const [key, rec] of this.ipUsage.entries()) {
                const vidObj = {};
                for (const [vid, ts] of rec.videoIds.entries()) {
                    vidObj[vid] = ts;
                }
                ipUsageObj[key] = {
                    hourly: rec.hourly,
                    daily: rec.daily,
                    videoIds: vidObj,
                    blockedUntil: rec.blockedUntil,
                    strikes: rec.strikes,
                    lastSeen: rec.lastSeen || Date.now()
                };
            }

            const subnetUsageObj = {};
            for (const [key, rec] of this.subnetUsage.entries()) {
                subnetUsageObj[key] = {
                    hourly: rec.hourly,
                    daily: rec.daily,
                    lastSeen: rec.lastSeen || Date.now()
                };
            }

            const payload = JSON.stringify({
                version: 1,
                updatedAt: new Date().toISOString(),
                globalUsage: this.globalUsage,
                accountUsage: accountUsageObj,
                ipUsage: ipUsageObj,
                subnetUsage: subnetUsageObj,
                circuitBreaker: {
                    state: this.circuitBreaker.state,
                    pausedUntil: this.circuitBreaker.pausedUntil,
                    botChecks: this.circuitBreaker.botChecks
                }
            }, null, 2);

            const tmpPath = `${this.budgetFile}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tmpPath, payload, 'utf8');
            fs.renameSync(tmpPath, this.budgetFile);
        } catch (err) {
            this.logger.warn(`[cookie_guard] Failed to atomically save cookie budgets: ${err.message}`);
        }
    }

    destroy() {
        if (this.summaryInterval) clearInterval(this.summaryInterval);
        if (this.sweepInterval) clearInterval(this.sweepInterval);
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.drainQueue('SERVER_SHUTDOWN');
        this.flush();
    }
}

const ageGateCookiePool = new AgeGateCookiePool({
    enabled: AGE_GATE_COOKIES_ENABLED,
    dirPath: YTDLP_AGE_COOKIES_DIR,
    logger: Logger
});
ageGateCookiePool.init();

const ageRestrictedCache = new AgeGateLruCache(1000, 24 * 60 * 60 * 1000);

const cookieGuard = new CookieGuard({
    pool: ageGateCookiePool,
    budgetFile: COOKIE_BUDGET_CACHE_FILE,
    secretFile: COOKIE_GUARD_SECRET_FILE,
    workDir: WORK_DIR,
    logger: Logger
});

module.exports = {
    AgeGateCookiePool,
    ageGateCookiePool,
    AgeGateLruCache,
    ageRestrictedCache,
    CookieGuard,
    cookieGuard
};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, STATIC_CACHE_ENABLED } = require('./config');

const FINGERPRINT_FILES = ['script.js', 'styles.css', 'theme-init.js'];

let cachedHtml = null;
let assetHashes = {};
let currentHeadersHandler = null;
let cacheEnabled = STATIC_CACHE_ENABLED;

function computeHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
}

function computeAssetHashes(publicDir = PUBLIC_DIR) {
    const hashes = {};
    for (const file of FINGERPRINT_FILES) {
        const filePath = path.join(publicDir, file);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath);
            hashes[file] = computeHash(content);
        }
    }
    return hashes;
}

function buildRewrittenHtml(publicDir = PUBLIC_DIR, hashes = null) {
    const indexPath = path.join(publicDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
        return '';
    }
    let html = fs.readFileSync(indexPath, 'utf8');
    const hashesToApply = hashes || computeAssetHashes(publicDir);
    for (const [file, hash] of Object.entries(hashesToApply)) {
        const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`((?:src|href)=["'])(/?${escaped})(?:\\?[^"']*)?(["'])`, 'g');
        html = html.replace(regex, `$1$2?v=${hash}$3`);
    }
    return html;
}

function createStaticHeaders(publicDir = PUBLIC_DIR, hashes = null, enabled = STATIC_CACHE_ENABLED) {
    const resolvedHashes = hashes || computeAssetHashes(publicDir);
    return function configuredSetStaticHeaders(res, filePath) {
        const baseName = path.basename(filePath);
        if (baseName === 'index.html') {
            res.setHeader('Cache-Control', 'no-cache');
            return;
        }

        if (!enabled) {
            res.setHeader('Cache-Control', 'no-cache');
            return;
        }

        const relPath = path.relative(publicDir, filePath).split(path.sep).join('/');
        let v = null;
        if (res.req) {
            if (res.req.query && typeof res.req.query.v === 'string') {
                v = res.req.query.v;
            } else if (typeof res.req.url === 'string' && res.req.url.includes('?')) {
                try {
                    const parsed = new URL(res.req.url, 'http://localhost');
                    v = parsed.searchParams.get('v');
                } catch {}
            }
        }

        const expectedHash = resolvedHashes[relPath];
        if (expectedHash && v === expectedHash) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (relPath.startsWith('assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        }
    };
}

function initStaticCache(publicDir = PUBLIC_DIR, enabled = STATIC_CACHE_ENABLED) {
    cacheEnabled = enabled;
    assetHashes = computeAssetHashes(publicDir);
    if (enabled) {
        cachedHtml = buildRewrittenHtml(publicDir, assetHashes);
    } else {
        cachedHtml = null;
    }
    currentHeadersHandler = createStaticHeaders(publicDir, assetHashes, enabled);
}

function getIndexHtml(publicDir = PUBLIC_DIR, enabled = cacheEnabled) {
    if (enabled) {
        if (cachedHtml === null) {
            initStaticCache(publicDir, true);
        }
        return cachedHtml;
    }
    const indexPath = path.join(publicDir, 'index.html');
    return fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
}

function setStaticHeaders(res, filePath) {
    if (!currentHeadersHandler) {
        initStaticCache();
    }
    return currentHeadersHandler(res, filePath);
}

// Initial cache setup
initStaticCache();

module.exports = {
    FINGERPRINT_FILES,
    computeHash,
    computeAssetHashes,
    buildRewrittenHtml,
    createStaticHeaders,
    initStaticCache,
    getIndexHtml,
    setStaticHeaders
};

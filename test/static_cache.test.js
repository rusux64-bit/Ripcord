const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const {
    computeHash,
    computeAssetHashes,
    buildRewrittenHtml,
    initStaticCache,
    getIndexHtml,
    setStaticHeaders,
    createStaticHeaders
} = require('../src/static_cache');
const { PUBLIC_DIR } = require('../src/config');
const { registerRoutes } = require('../src/routes');

function request(server, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const { port } = server.address();
        http.get({
            hostname: '127.0.0.1',
            port,
            path,
            headers
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body
            }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

test('hash calculation changes when file content changes', () => {
    const hashA = computeHash('console.log("version 1");');
    const hashB = computeHash('console.log("version 2");');
    assert.equal(hashA.length, 10);
    assert.equal(hashB.length, 10);
    assert.notEqual(hashA, hashB);
});

test('buildRewrittenHtml injects version queries into asset references', () => {
    const customHashes = {
        'script.js': '1111111111',
        'styles.css': '2222222222',
        'theme-init.js': '3333333333'
    };
    const html = buildRewrittenHtml(PUBLIC_DIR, customHashes);
    assert.ok(html.includes('theme-init.js?v=3333333333'));
    assert.ok(html.includes('styles.css?v=2222222222'));
    assert.ok(html.includes('script.js?v=1111111111'));
});

test('static cache headers in production mode (enabled)', async () => {
    const hashes = computeAssetHashes(PUBLIC_DIR);
    initStaticCache(PUBLIC_DIR, true);

    const app = express();
    app.get(['/', '/index.html'], (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(getIndexHtml(PUBLIC_DIR, true));
    });

    app.use(express.static(PUBLIC_DIR, {
        dotfiles: 'deny',
        index: false,
        setHeaders: setStaticHeaders
    }));

    registerRoutes(app);

    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
        // 1. / returns no-cache and contains ?v= URLs
        const resRoot = await request(server, '/');
        assert.equal(resRoot.statusCode, 200);
        assert.equal(resRoot.headers['cache-control'], 'no-cache');
        assert.ok(resRoot.headers.etag, 'ETag must be present on HTML');
        assert.ok(resRoot.body.includes(`script.js?v=${hashes['script.js']}`));
        assert.ok(resRoot.body.includes(`styles.css?v=${hashes['styles.css']}`));
        assert.ok(resRoot.body.includes(`theme-init.js?v=${hashes['theme-init.js']}`));

        // 2. Conditional request with If-None-Match returns 304 for HTML
        const resRoot304 = await request(server, '/', { 'If-None-Match': resRoot.headers.etag });
        assert.equal(resRoot304.statusCode, 304);

        // 3. /script.js?v=<hash> returns immutable
        const resHashedScript = await request(server, `/script.js?v=${hashes['script.js']}`);
        assert.equal(resHashedScript.statusCode, 200);
        assert.equal(resHashedScript.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.ok(resHashedScript.headers.etag);

        // 4. Plain /script.js returns must-revalidate
        const resPlainScript = await request(server, '/script.js');
        assert.equal(resPlainScript.statusCode, 200);
        assert.equal(resPlainScript.headers['cache-control'], 'public, max-age=0, must-revalidate');

        // 5. /script.js?v=stale returns must-revalidate
        const resStaleScript = await request(server, '/script.js?v=outdated123');
        assert.equal(resStaleScript.statusCode, 200);
        assert.equal(resStaleScript.headers['cache-control'], 'public, max-age=0, must-revalidate');

        // 6. Conditional request on static file returns 304
        const resScript304 = await request(server, `/script.js?v=${hashes['script.js']}`, {
            'If-None-Match': resHashedScript.headers.etag
        });
        assert.equal(resScript304.statusCode, 304);

        // 7. assets/ returns 7-day cache
        const resAsset = await request(server, '/assets/favicon.svg');
        assert.equal(resAsset.statusCode, 200);
        assert.equal(resAsset.headers['cache-control'], 'public, max-age=604800');

        // 8. SPA fallback gets no-cache rewritten HTML
        const resSpa = await request(server, '/non-existent-spa-page');
        assert.equal(resSpa.statusCode, 200);
        assert.equal(resSpa.headers['cache-control'], 'no-cache');
        assert.ok(resSpa.body.includes(`script.js?v=${hashes['script.js']}`));

        // 9. /api/... is untouched by static caching
        const resApi = await request(server, '/api/health');
        assert.equal(resApi.statusCode, 200);
        assert.notEqual(resApi.headers['cache-control'], 'public, max-age=31536000, immutable');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('static cache headers in dev mode (STATIC_CACHE=off)', async () => {
    const hashes = computeAssetHashes(PUBLIC_DIR);
    const devStaticHeaders = createStaticHeaders(PUBLIC_DIR, hashes, false);

    const app = express();
    app.get(['/', '/index.html'], (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(getIndexHtml(PUBLIC_DIR, false));
    });

    app.use(express.static(PUBLIC_DIR, {
        dotfiles: 'deny',
        index: false,
        setHeaders: devStaticHeaders
    }));

    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
        // Dev mode: HTML is not fingerprinted
        const resRoot = await request(server, '/');
        assert.equal(resRoot.statusCode, 200);
        assert.equal(resRoot.headers['cache-control'], 'no-cache');
        assert.ok(!resRoot.body.includes(`script.js?v=${hashes['script.js']}`));
        assert.ok(resRoot.body.includes('src="script.js"') || resRoot.body.includes('src="theme-init.js"'));

        // Dev mode: assets get no-cache
        const resScript = await request(server, `/script.js?v=${hashes['script.js']}`);
        assert.equal(resScript.statusCode, 200);
        assert.equal(resScript.headers['cache-control'], 'no-cache');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

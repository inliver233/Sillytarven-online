import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';

import { computeAssetVersion, createVersionedAssetsMiddleware, normalizeAssetCdnBaseUrl, transformAppHtml } from '../src/asset-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-asset-version-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('index.html loads its modules through the import map', () => {
    const html = `<html><head>
    <base href="/">
</head><body>
    <script src="lib/jquery-3.5.1.min.js"></script>
    <script type="module" src="lib/eventemitter.js"></script>
    <script type="module" src="script.js"></script>
</body></html>`;
    const page = transformAppHtml(html, { version: 'abc123def456' });
    assert.match(page, /<script src="lib\/jquery-3\.5\.1\.min\.js"><\/script>/);
    assert.match(page, /<script type="module">import "\/lib\/eventemitter\.js";<\/script>/);
    assert.match(page, /<script type="module">import "\/script\.js";<\/script>/);
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(page)[1]);
    assert.deepEqual(map.imports, {
        '/script.js': '/v/abc123def456/script.js',
        '/lib.js': '/v/abc123def456/lib.js',
        '/scripts/': '/v/abc123def456/scripts/',
        '/lib/': '/v/abc123def456/lib/',
        '/scripts/extensions/third-party/': '/scripts/extensions/third-party/',
    });
    assert.ok(page.indexOf('type="importmap"') < page.indexOf('</head>'));

    // Anything it cannot convert leaves the page alone: a module loaded by src next
    // to mapped imports would run twice.
    assert.equal(transformAppHtml(html.replace('type="module" src="script.js"', 'src="script.js" type="module"'), { version: 'abc123def456' }), null);
    assert.equal(transformAppHtml(page, { version: 'abc123def456' }), null);
    assert.equal(transformAppHtml(html, { version: 'not-a-version' }), null);
});

test('local stylesheets carry the version so a deploy reaches cached browsers', () => {
    const html = `<html><head>
    <link rel="stylesheet" type="text/css" href="css/announcements.css">
    <link rel="stylesheet" href="style.css?x=1">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto">
    <link rel="icon" href="favicon.ico">
</head><body><script type="module" src="script.js"></script></body></html>`;
    const page = transformAppHtml(html, { version: 'abc123def456' });
    assert.match(page, /href="css\/announcements\.css\?v=abc123def456"/);
    assert.match(page, /href="style\.css\?x=1&v=abc123def456"/);
    assert.match(page, /href="https:\/\/fonts\.googleapis\.com\/css2\?family=Noto"/);
    assert.match(page, /href="favicon\.ico"/);
});

test('versioned URLs are rewritten, cached by version, and limited to the app modules', () => {
    const middleware = createVersionedAssetsMiddleware(() => 'abc123def456');
    const run = (url, method = 'GET') => {
        const request = { url, method, get path() { return this.url.split('?')[0]; } };
        const response = { locals: {}, headers: {}, status: null, sendStatus(code) { this.status = code; return this; }, setHeader(name, value) { this.headers[name] = value; } };
        let nextCalled = false;
        middleware(request, response, () => { nextCalled = true; });
        return { url: request.url, locals: response.locals, headers: response.headers, status: response.status, nextCalled };
    };

    const current = run('/v/abc123def456/scripts/extensions/regex/engine.js?x=1');
    assert.equal(current.url, '/scripts/extensions/regex/engine.js?x=1');
    assert.equal(current.locals.versionedAssetCacheControl, 'public, max-age=31536000, immutable');
    assert.equal(current.headers['Access-Control-Allow-Origin'], '*', 'a CDN mirror serves them cross-origin');
    assert.equal(current.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.equal(run('/v/abc123def456/lib.js').url, '/lib.js');
    assert.equal(run('/v/0123456789ab/script.js').locals.versionedAssetCacheControl, 'no-store');

    assert.equal(run('/v/abc123def456/scripts/extensions/third-party/foo/index.js').status, 404);
    assert.equal(run('/v/abc123def456/index.html').status, 404);
    assert.equal(run('/v/abc123def456/scripts/../../config.yaml').status, 404);
    assert.equal(run('/v/nothex/script.js').status, 404);

    const plain = run('/scripts/i18n.js');
    assert.equal(plain.url, '/scripts/i18n.js');
    assert.equal(plain.nextCalled, true);
    assert.deepEqual(plain.locals, {});
    assert.deepEqual(plain.headers, {});
    assert.equal(run('/v/abc123def456/script.js', 'POST').locals.versionedAsset, undefined);
});

test('the version changes when a served file changes', () => {
    fs.mkdirSync(path.join(root, 'scripts', 'extensions', 'third-party', 'ext'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'script.js'), 'one');
    fs.writeFileSync(path.join(root, 'scripts', 'a.js'), 'a');
    const first = computeAssetVersion(root, null);
    assert.equal(computeAssetVersion(root, null), first);

    fs.writeFileSync(path.join(root, 'scripts', 'extensions', 'third-party', 'ext', 'index.js'), 'user extension');
    assert.equal(computeAssetVersion(root, null), first, 'third-party extensions are not part of the version');

    fs.writeFileSync(path.join(root, 'scripts', 'a.js'), 'a changed');
    assert.notEqual(computeAssetVersion(root, null), first);
});

/**
 * Runs the import map script of a page that has a CDN mirror, with a stand-in browser.
 * @param {string} page Page
 * @param {{zone: string, storage?: Record<string, string>}} browser Time zone and localStorage
 */
function runCdnScript(page, { zone, storage = {} }) {
    const script = /<script>(\(function \(o\)[\s\S]*?)<\/script>/.exec(page)[1];
    const listeners = {};
    let inserted = null;
    const context = {
        localStorage: { getItem: key => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; } },
        Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: zone }) }) },
        document: { createElement: () => ({}), currentScript: { after: element => { inserted = element; } } },
        addEventListener: (type, listener) => { listeners[type] = listener; },
        location: { origin: 'https://example.org', reload: () => { context.reloaded = true; } },
        console: { warn: () => {} },
        reloaded: false,
    };
    context.window = context;
    vm.runInNewContext(script, context);
    return { type: inserted.type, imports: JSON.parse(inserted.textContent).imports, listeners, storage, context };
}

test('a CDN mirror of /v/ is used by pages in its time zones and dropped when it fails', () => {
    const html = '<html><head></head><body><script type="module" src="script.js"></script></body></html>';
    const cdn = { baseUrl: 'https://static.example.cn/st', timeZones: ['Asia/Shanghai'] };
    const page = transformAppHtml(html, { version: 'abc123def456', cdn });
    assert.doesNotMatch(page, /<script type="importmap">/, 'the map is chosen in the browser');
    assert.ok(page.indexOf('static.example.cn') < page.indexOf('</head>'));
    assert.match(page, /<script type="module">import "\/script\.js";<\/script>/);

    const china = runCdnScript(page, { zone: 'Asia/Shanghai' });
    assert.equal(china.type, 'importmap');
    assert.equal(china.imports['/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/');
    assert.equal(china.imports['/script.js'], 'https://static.example.cn/st/v/abc123def456/script.js');
    assert.equal(china.imports['/scripts/extensions/third-party/'], '/scripts/extensions/third-party/', 'third-party stays here');
    // "/scripts/x.js" imported by a mirrored module resolves to the mirror's root.
    assert.equal(china.imports['https://static.example.cn/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/');
    assert.equal(china.imports['https://static.example.cn/lib.js'], 'https://static.example.cn/st/v/abc123def456/lib.js');
    assert.equal(china.imports['https://static.example.cn/scripts/extensions/third-party/'], 'https://example.org/scripts/extensions/third-party/');

    const elsewhere = runCdnScript(page, { zone: 'America/New_York' });
    assert.equal(elsewhere.imports['/scripts/'], '/v/abc123def456/scripts/');
    assert.equal(Object.keys(elsewhere.imports).some(key => key.includes('static.example.cn')), false);
    assert.equal(elsewhere.listeners.error, undefined);

    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn': 'off' } }).imports['/scripts/'], '/v/abc123def456/scripts/');
    assert.equal(runCdnScript(page, { zone: 'Europe/Berlin', storage: { 'st-asset-cdn': 'on' } }).imports['/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/');
    const failed = (minutesAgo, count) => ({ 'st-asset-cdn-failed': JSON.stringify({ at: Date.now() - minutesAgo * 60e3, count }) });
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: failed(10, 2) }).imports['/scripts/'], '/v/abc123def456/scripts/', 'paused');
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: failed(31, 2) }).imports['/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/', 'tried again after half an hour');
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: failed(0.1, 1) }).imports['/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/', 'one failure: retried');
    // The old format (a bare timestamp) counts as a confirmed failure, paused for half an hour.
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn-failed': String(Date.now() - 10 * 60e3) } }).imports['/scripts/'], '/v/abc123def456/scripts/');
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn-failed': String(Date.now() - 40 * 60e3) } }).imports['/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/');

    // A module of this server failing is not the mirror's fault.
    const unrelated = runCdnScript(page, { zone: 'Asia/Shanghai' });
    unrelated.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://example.org/scripts/extensions/third-party/x/index.js' } });
    unrelated.listeners.error({ target: { tagName: 'IMG', src: '' } });
    assert.equal(unrelated.storage['st-asset-cdn-failed'], undefined);
    assert.equal(unrelated.context.reloaded, false);

    // The app's entry modules cannot be loaded from the mirror: reload and try it once more...
    const broken = runCdnScript(page, { zone: 'Asia/Shanghai' });
    broken.listeners.error({ target: { tagName: 'SCRIPT', src: '' } });
    assert.equal(JSON.parse(broken.storage['st-asset-cdn-failed']).count, 1);
    assert.equal(broken.context.reloaded, true);
    const retry = runCdnScript(page, { zone: 'Asia/Shanghai', storage: broken.storage });
    assert.equal(retry.imports['/scripts/'], 'https://static.example.cn/st/v/abc123def456/scripts/');
    // ...and when that fails too, load from here for a while; the failed file is kept.
    retry.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://static.example.cn/st/v/abc123def456/script.js' } });
    assert.equal(retry.context.reloaded, true);
    assert.equal(JSON.parse(retry.storage['st-asset-cdn-failed']).count, 2);
    assert.equal(JSON.parse(retry.storage['st-asset-cdn-failed']).what, 'https://static.example.cn/st/v/abc123def456/script.js');
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: retry.storage }).imports['/scripts/'], '/v/abc123def456/scripts/');

    // A lazy import failing after the app started is noted for the next load, without a reload.
    const late = runCdnScript(page, { zone: 'Asia/Shanghai' });
    late.context.SillyTavern = {};
    late.listeners.unhandledrejection({ reason: new TypeError('Failed to fetch dynamically imported module: https://static.example.cn/st/v/abc123def456/scripts/a.js') });
    assert.equal(JSON.parse(late.storage['st-asset-cdn-failed']).count, 2, 'paused from the next page on');
    late.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://static.example.cn/st/v/abc123def456/scripts/b.js' } });
    assert.equal(late.context.reloaded, false);

    // Configuration cannot close the script early.
    const hostile = transformAppHtml(html, { version: 'abc123def456', cdn: { baseUrl: 'https://static.example.cn', timeZones: ['</script><script>alert(1)</script>'] } });
    assert.doesNotMatch(hostile, /alert\(1\)<\/script>/);
});

test('with no time zones listed, every page uses the CDN mirror', () => {
    const html = '<html><head></head><body><script type="module" src="script.js"></script></body></html>';
    const page = transformAppHtml(html, { version: 'abc123def456', cdn: { baseUrl: 'https://s1.example.cn', timeZones: [] } });
    for (const zone of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin']) {
        assert.equal(runCdnScript(page, { zone }).imports['/scripts/'], 'https://s1.example.cn/v/abc123def456/scripts/', zone);
    }
    assert.equal(runCdnScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn': 'off' } }).imports['/scripts/'], '/v/abc123def456/scripts/');
    const recentFailure = { 'st-asset-cdn-failed': JSON.stringify({ at: Date.now() - 60_000, count: 2 }) };
    assert.equal(runCdnScript(page, { zone: 'Europe/Berlin', storage: recentFailure }).imports['/scripts/'], '/v/abc123def456/scripts/');
});

test('the CDN mirror address is checked', () => {
    assert.equal(normalizeAssetCdnBaseUrl('https://static.example.cn/'), 'https://static.example.cn');
    assert.equal(normalizeAssetCdnBaseUrl(' https://cdn.example.cn/st// '), 'https://cdn.example.cn/st');
    assert.equal(normalizeAssetCdnBaseUrl('http://127.0.0.1:8152'), 'http://127.0.0.1:8152');
    for (const value of ['', '   ', 'static.example.cn', 'ftp://static.example.cn', 'https://static.example.cn/?x=1', 'https://a:b@static.example.cn', 'javascript:alert(1)', null, 42]) {
        assert.equal(normalizeAssetCdnBaseUrl(value), null, String(value));
    }
});

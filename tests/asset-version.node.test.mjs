import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';

import { computeAssetManifest, createVersionedAssetsMiddleware, getQueryVersionCacheControl, getStartupModules, normalizeAssetCdnBaseUrl, transformAppHtml } from '../src/asset-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-asset-version-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const MANIFEST = Object.freeze({
    version: 'abc123def456',
    files: {
        'script.js': '11111111',
        'lib.js': '22222222',
        'scripts/a.js': '33333333',
        'scripts/templates/t.html': '44444444',
        'lib/eventemitter.js': '55555555',
        'lib/jquery-3.5.1.min.js': '66666666',
        'scripts/extensions/memory/style.css': '99999999',
    },
    styles: { 'css/announcements.css': '77777777', 'style.css': '88888888' },
});

/**
 * Runs the page's import map script with a stand-in browser.
 * @param {string} page Page
 * @param {{zone?: string, storage?: Record<string, string>, importMaps?: boolean}} [browser] Time zone, localStorage, import map support
 */
function runAssetScript(page, { zone = 'Asia/Shanghai', storage = {}, importMaps = true, language = 'zh-CN' } = {}) {
    const script = /<script>(\(function \(o\)[\s\S]*?)<\/script>/.exec(page)[1];
    const listeners = {};
    const inserted = [];
    const element = tagName => ({ tagName, after(next) { inserted.push(next); } });
    const context = {
        HTMLScriptElement: { supports: type => importMaps && type === 'importmap' },
        localStorage: { getItem: key => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; } },
        Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: zone }) }) },
        document: { createElement: element, currentScript: element('SCRIPT') },
        addEventListener: (type, listener) => { listeners[type] = listener; },
        location: { origin: 'https://example.org', reload: () => { context.reloaded = true; } },
        navigator: { language },
        console: { warn: () => {} },
        reloaded: false,
    };
    context.window = context;
    vm.runInNewContext(script, context);
    const map = inserted.find(item => item.type === 'importmap');
    return {
        imports: map ? JSON.parse(map.textContent).imports : null,
        preloads: inserted.filter(item => item.rel === 'modulepreload').map(item => item.href),
        fetchPreloads: inserted.filter(item => item.rel === 'preload').map(item => `${item.as} ${item.crossOrigin} ${item.href}`),
        urls: context.__stAssets.urls,
        listeners,
        storage,
        context,
    };
}

test('index.html loads its modules through an import map of the file versions', () => {
    const html = `<html><head>
    <base href="/">
    <meta charset="utf-8">
    <link rel="stylesheet" href="style.css">
</head><body>
    <script src="lib/jquery-3.5.1.min.js"></script>
    <script type="module" src="lib/eventemitter.js"></script>
    <script type="module" src="script.js"></script>
</body></html>`;
    const page = transformAppHtml(html, { manifest: MANIFEST, preload: ['script.js', 'scripts/a.js', 'scripts/gone.js'] });
    assert.match(page, /<script src="lib\/jquery-3\.5\.1\.min\.js\?v=66666666"><\/script>/, 'classic scripts carry their version too');
    assert.match(page, /<script type="module">import "\/lib\/eventemitter\.js";<\/script>/);
    assert.match(page, /<script type="module">import "\/script\.js";<\/script>/);
    // Before the stylesheets: an inline script after them waits until they have loaded.
    assert.ok(page.indexOf('<meta charset="utf-8">') < page.indexOf('(function (o)'));
    assert.ok(page.indexOf('(function (o)') < page.indexOf('rel="stylesheet"'));

    const { imports, preloads, urls } = runAssetScript(page);
    assert.equal(imports['/script.js'], '/v/s/script.js?v=11111111');
    assert.equal(imports['/lib.js'], '/v/s/lib.js?v=22222222');
    assert.equal(imports['/scripts/a.js'], '/v/s/scripts/a.js?v=33333333');
    // A relative import inside a versioned module resolves under /v/s/ and must reach the same URL.
    assert.equal(imports['/v/s/scripts/a.js'], '/v/s/scripts/a.js?v=33333333');
    assert.equal(imports['/scripts/extensions/third-party/'], '/scripts/extensions/third-party/');
    assert.equal(imports['/scripts/templates/t.html'], undefined, 'only modules are in the map');
    assert.equal(urls['/scripts/templates/t.html'], '/v/s/scripts/templates/t.html?v=44444444', 'templates are versioned too');
    assert.deepEqual(preloads, ['/v/s/script.js?v=11111111', '/v/s/scripts/a.js?v=33333333'], 'unknown modules are not preloaded');

    // Without import maps the plain URLs stay in use everywhere, or a module could run twice.
    const old = runAssetScript(page, { importMaps: false });
    assert.equal(old.imports, null);
    assert.deepEqual(old.preloads, []);
    assert.equal(Object.keys(old.urls).length, 0);

    // Anything it cannot convert leaves the page alone: a module loaded by src next
    // to mapped imports would run twice.
    assert.equal(transformAppHtml(html.replace('type="module" src="script.js"', 'src="script.js" type="module"'), { manifest: MANIFEST }), null);
    assert.equal(transformAppHtml(page, { manifest: MANIFEST }), null);
    assert.equal(transformAppHtml(html, { manifest: { ...MANIFEST, version: 'not-a-version' } }), null);
    assert.equal(transformAppHtml(html, {}), null);
});

test('the files the app fetches as it starts are downloaded with the modules', () => {
    const manifest = {
        ...MANIFEST,
        files: {
            ...MANIFEST.files,
            'locales/lang.json': 'aaaaaaaa',
            'locales/zh-cn.json': 'bbbbbbbb',
            'locales/en.json': 'cccccccc',
            'scripts/templates/welcome.html': 'dddddddd',
            'scripts/extensions/memory/manifest.json': 'eeeeeeee',
            'scripts/extensions/memory/settings.html': 'ffffffff',
        },
    };
    const page = transformAppHtml('<html><head><meta charset="utf-8"></head><body><script type="module" src="script.js"></script></body></html>', { manifest });
    const expected = [
        'fetch anonymous /v/s/locales/lang.json?v=aaaaaaaa',
        'fetch anonymous /v/s/scripts/templates/welcome.html?v=dddddddd',
        'fetch anonymous /v/s/scripts/extensions/memory/manifest.json?v=eeeeeeee',
    ];
    assert.deepEqual(runAssetScript(page, { language: 'zh-CN' }).fetchPreloads, [...expected, 'fetch anonymous /v/s/locales/zh-cn.json?v=bbbbbbbb']);
    assert.deepEqual(runAssetScript(page, { language: 'en-US' }).fetchPreloads, expected, 'English has no language file to fetch');
    assert.deepEqual(runAssetScript(page, { language: 'xx-yy' }).fetchPreloads, expected, 'nor does a language without one');
    assert.deepEqual(runAssetScript(page, { language: 'en-US', storage: { language: 'zh-cn' } }).fetchPreloads, [...expected, 'fetch anonymous /v/s/locales/zh-cn.json?v=bbbbbbbb'], 'the chosen language wins');
    const mirrored = runAssetScript(transformAppHtml('<html><head></head><body></body></html>', { manifest, cdn: { baseUrl: 'https://s1.example.cn', timeZones: [] } }));
    assert.ok(mirrored.fetchPreloads.includes('fetch anonymous https://s1.example.cn/v/s/locales/lang.json?v=aaaaaaaa'), 'from the mirror when the page uses it');
});

test('local stylesheets carry their version so a deploy reaches cached browsers', () => {
    const html = `<html><head>
    <link rel="preload" as="style" href="style.css">
    <link rel="stylesheet" type="text/css" href="css/announcements.css">
    <link rel="stylesheet" href="style.css?x=1">
    <link rel="stylesheet" href="css/unknown.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto">
    <link rel="icon" href="favicon.ico">
</head><body><script type="module" src="script.js"></script></body></html>`;
    const page = transformAppHtml(html, { manifest: MANIFEST });
    assert.match(page, /rel="preload" as="style" href="style\.css\?v=88888888"/, 'the preload is the same request as the stylesheet');
    assert.match(page, /href="css\/announcements\.css\?v=77777777"/);
    assert.match(page, /href="style\.css\?x=1&v=88888888"/);
    assert.match(page, /href="css\/unknown\.css\?v=abc123def456"/, 'a file without its own version gets the page version');
    assert.match(page, /href="https:\/\/fonts\.googleapis\.com\/css2\?family=Noto"/);
    assert.match(page, /href="favicon\.ico"/);

    assert.equal(getQueryVersionCacheControl(MANIFEST, 'css/announcements.css', '77777777'), 'public, max-age=31536000, immutable');
    assert.equal(getQueryVersionCacheControl(MANIFEST, 'scripts/extensions/memory/style.css', '99999999'), 'public, max-age=31536000, immutable');
    assert.equal(getQueryVersionCacheControl(MANIFEST, 'css/announcements.css', '00000000'), null, 'an old version is not kept');
    assert.equal(getQueryVersionCacheControl(MANIFEST, 'css/user.css', 'abc123def456'), null, 'nor a file without a version (user.css)');
    assert.equal(getQueryVersionCacheControl(MANIFEST, 'css/announcements.css', undefined), null);
});

test('versioned URLs are rewritten, cached by version, and limited to the app files', () => {
    const middleware = createVersionedAssetsMiddleware(() => MANIFEST);
    const run = (url, method = 'GET') => {
        const request = { url, method, headers: { host: 'site.example' }, get path() { return this.url.split('?')[0]; } };
        const response = {
            locals: {}, headers: {}, status: null, location: null,
            sendStatus(code) { this.status = code; return this; },
            setHeader(name, value) { this.headers[name] = value; },
            redirect(code, location) { this.status = code; this.location = location; return this; },
        };
        let nextCalled = false;
        middleware(request, response, () => { nextCalled = true; });
        return { url: request.url, locals: response.locals, headers: response.headers, status: response.status, location: response.location, nextCalled };
    };

    const current = run('/v/s/scripts/a.js?v=33333333');
    assert.equal(current.url, '/scripts/a.js?v=33333333');
    assert.equal(current.nextCalled, true);
    assert.equal(current.locals.versionedAssetCacheControl, 'public, max-age=31536000, immutable');
    assert.equal(current.headers['Access-Control-Allow-Origin'], '*', 'a CDN mirror serves them cross-origin');
    assert.equal(current.headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.equal(run('/v/s/lib.js?v=22222222').url, '/lib.js?v=22222222');
    assert.equal(run('/v/s/locales/zh-cn.json?v=12345678').url, '/locales/zh-cn.json?v=12345678');
    // A tab opened before a deploy gets the current file, not kept under its old URL.
    assert.equal(run('/v/s/scripts/a.js?v=00000000').locals.versionedAssetCacheControl, 'no-store');
    assert.equal(run('/v/abc123def456/scripts/a.js').locals.versionedAssetCacheControl, 'no-store', 'the old form still works');
    assert.equal(run('/v/abc123def456/scripts/a.js').url, '/scripts/a.js');

    // Without a version (found through import.meta.url) the plain file is used: a CDN keeps /v/ for a year.
    const plain = run('/v/s/scripts/extensions/tts/lib/model.wasm');
    assert.equal(plain.status, 302);
    assert.equal(plain.location, '//site.example/scripts/extensions/tts/lib/model.wasm');
    assert.equal(plain.headers['Cache-Control'], 'no-store');
    assert.equal(plain.nextCalled, false);

    assert.equal(run('/v/s/scripts/extensions/third-party/foo/index.js?v=33333333').status, 404);
    assert.equal(run('/v/s/index.html?v=33333333').status, 404);
    assert.equal(run('/v/s/scripts/../../config.yaml?v=33333333').status, 404);
    assert.equal(run('/v/abc123def456/scripts/extensions/third-party/foo/index.js').status, 404);
    assert.equal(run('/v/nothex/script.js').status, 404);

    const untouched = run('/scripts/i18n.js');
    assert.equal(untouched.url, '/scripts/i18n.js');
    assert.equal(untouched.nextCalled, true);
    assert.deepEqual(untouched.locals, {});
    assert.deepEqual(untouched.headers, {});
    assert.equal(run('/v/s/script.js?v=11111111', 'POST').locals.versionedAsset, undefined);
});

test('a deploy changes the versions of the files it changed, and only those', () => {
    const write = (name, content, mtime) => {
        const file = path.join(root, ...name.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        if (mtime) fs.utimesSync(file, mtime, mtime);
    };
    const old = new Date('2026-01-01T00:00:00Z');
    write('script.js', 'import "./scripts/a.js";', old);
    write('scripts/a.js', 'a', old);
    write('scripts/b.js', 'b', old);
    write('scripts/templates/t.html', '<div></div>', old);
    write('scripts/img.png', 'png', old);
    write('locales/zh-cn.json', '{}', old);
    write('css/x.css', 'body{}', old);
    write('style.css', 'body{}', old);
    write('webfonts/Noto/stylesheet.css', '@font-face{}', old);
    const first = computeAssetManifest(root, null);
    assert.deepEqual(Object.keys(first.files).sort(), ['locales/zh-cn.json', 'script.js', 'scripts/a.js', 'scripts/b.js', 'scripts/templates/t.html']);
    assert.deepEqual(Object.keys(first.styles).sort(), ['css/x.css', 'style.css', 'webfonts/Noto/stylesheet.css']);
    assert.match(first.files['scripts/a.js'], /^[0-9a-f]{8}$/);
    assert.deepEqual(computeAssetManifest(root, null), first);

    write('scripts/extensions/third-party/ext/index.js', 'user extension');
    assert.deepEqual(computeAssetManifest(root, null), first, 'third-party extensions are not versioned');

    write('scripts/a.js', 'a changed');
    const second = computeAssetManifest(root, null);
    assert.notEqual(second.files['scripts/a.js'], first.files['scripts/a.js']);
    assert.equal(second.files['scripts/b.js'], first.files['scripts/b.js'], 'an untouched file keeps its URL');
    assert.notEqual(second.version, first.version);

    // Put back as it was (a revert): a new version all the same, so nothing cached under the
    // old URL in between can come back.
    write('scripts/a.js', 'a', new Date('2026-02-01T00:00:00Z'));
    assert.notEqual(computeAssetManifest(root, null).files['scripts/a.js'], first.files['scripts/a.js']);

    write('css/x.css', 'body{color:red}');
    assert.notEqual(computeAssetManifest(root, null).styles['css/x.css'], first.styles['css/x.css']);
});

test('the modules the page starts with are found from its entry modules', () => {
    const base = fs.mkdtempSync(path.join(root, 'graph-'));
    const write = (name, content) => {
        fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
        fs.writeFileSync(path.join(base, name), content);
    };
    write('script.js', 'import { a } from "./scripts/a.js";\nimport "/lib.js";\nexport * from \'./scripts/b.js\';\nconst lazy = () => import("./scripts/lazy.js");');
    write('scripts/a.js', 'import { b } from "./b.js";import{c}from"./util/c.js"');
    write('scripts/b.js', 'import { a } from "./a.js";');
    write('scripts/util/c.js', 'export const c = 1; // import "./not-a-real-import.js" in a comment is fine to follow');
    write('scripts/lazy.js', '');
    write('scripts/i18n.js', 'import "../script.js";');
    write('dist-lib.js', 'export default 1;');
    const manifest = computeAssetManifest(base, path.join(base, 'dist-lib.js'));
    const modules = getStartupModules(base, path.join(base, 'dist-lib.js'), manifest);
    assert.deepEqual(modules.sort(), ['lib.js', 'script.js', 'scripts/a.js', 'scripts/b.js', 'scripts/i18n.js', 'scripts/util/c.js']);
});

test('a CDN mirror of /v/ is used by pages in its time zones and dropped when it fails', () => {
    const html = '<html><head></head><body><script type="module" src="script.js"></script></body></html>';
    const cdn = { baseUrl: 'https://static.example.cn/st', timeZones: ['Asia/Shanghai'] };
    const page = transformAppHtml(html, { manifest: MANIFEST, preload: ['script.js'], cdn });
    assert.doesNotMatch(page, /<script type="importmap">/, 'the map is chosen in the browser');
    assert.ok(page.indexOf('static.example.cn') < page.indexOf('</head>'));
    assert.match(page, /<script type="module">import "\/script\.js";<\/script>/);
    const mirrored = 'https://static.example.cn/st/v/s/scripts/a.js?v=33333333';
    const local = '/v/s/scripts/a.js?v=33333333';
    const scriptOf = run => run.imports['/scripts/a.js'];

    const china = runAssetScript(page, { zone: 'Asia/Shanghai' });
    assert.equal(scriptOf(china), mirrored);
    assert.equal(china.imports['/script.js'], 'https://static.example.cn/st/v/s/script.js?v=11111111');
    assert.deepEqual(china.preloads, ['https://static.example.cn/st/v/s/script.js?v=11111111']);
    assert.equal(china.urls['/scripts/templates/t.html'], 'https://static.example.cn/st/v/s/scripts/templates/t.html?v=44444444');
    assert.equal(china.imports['/scripts/extensions/third-party/'], '/scripts/extensions/third-party/', 'third-party stays here');
    // A module from the mirror: relative imports resolve under the mirror's /v/s/, absolute ones against its root.
    assert.equal(china.imports['https://static.example.cn/st/v/s/scripts/a.js'], mirrored);
    assert.equal(china.imports['https://static.example.cn/scripts/a.js'], mirrored);
    assert.equal(china.imports['https://static.example.cn/lib.js'], 'https://static.example.cn/st/v/s/lib.js?v=22222222');
    assert.equal(china.imports['https://static.example.cn/scripts/extensions/third-party/'], 'https://example.org/scripts/extensions/third-party/');

    const elsewhere = runAssetScript(page, { zone: 'America/New_York' });
    assert.equal(scriptOf(elsewhere), local);
    assert.equal(Object.keys(elsewhere.imports).some(key => key.includes('static.example.cn')), false);
    assert.deepEqual(elsewhere.preloads, ['/v/s/script.js?v=11111111']);
    assert.equal(elsewhere.listeners.error, undefined);

    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn': 'off' } })), local);
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Europe/Berlin', storage: { 'st-asset-cdn': 'on' } })), mirrored);
    const failed = (minutesAgo, count) => ({ 'st-asset-cdn-failed': JSON.stringify({ at: Date.now() - minutesAgo * 60e3, count }) });
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: failed(10, 2) })), local, 'paused');
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: failed(31, 2) })), mirrored, 'tried again after half an hour');
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: failed(0.1, 1) })), mirrored, 'one failure: retried');
    // The old format (a bare timestamp) counts as a confirmed failure, paused for half an hour.
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn-failed': String(Date.now() - 10 * 60e3) } })), local);
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn-failed': String(Date.now() - 40 * 60e3) } })), mirrored);

    // A module of this server failing is not the mirror's fault.
    const unrelated = runAssetScript(page, { zone: 'Asia/Shanghai' });
    unrelated.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://example.org/scripts/extensions/third-party/x/index.js' } });
    unrelated.listeners.error({ target: { tagName: 'IMG', src: '' } });
    assert.equal(unrelated.storage['st-asset-cdn-failed'], undefined);
    assert.equal(unrelated.context.reloaded, false);

    // The app's entry modules cannot be loaded from the mirror: reload and try it once more...
    const broken = runAssetScript(page, { zone: 'Asia/Shanghai' });
    broken.listeners.error({ target: { tagName: 'SCRIPT', src: '' } });
    assert.equal(JSON.parse(broken.storage['st-asset-cdn-failed']).count, 1);
    assert.equal(broken.context.reloaded, true);
    const retry = runAssetScript(page, { zone: 'Asia/Shanghai', storage: broken.storage });
    assert.equal(scriptOf(retry), mirrored);
    // ...and when that fails too, load from here for a while; the failed file is kept.
    retry.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://static.example.cn/st/v/s/script.js?v=11111111' } });
    assert.equal(retry.context.reloaded, true);
    assert.equal(JSON.parse(retry.storage['st-asset-cdn-failed']).count, 2);
    assert.equal(JSON.parse(retry.storage['st-asset-cdn-failed']).what, 'https://static.example.cn/st/v/s/script.js?v=11111111');
    assert.equal(scriptOf(runAssetScript(page, { zone: 'Asia/Shanghai', storage: retry.storage })), local);

    // A lazy import failing after the app started is noted for the next load, without a reload.
    const late = runAssetScript(page, { zone: 'Asia/Shanghai' });
    late.context.SillyTavern = {};
    late.listeners.unhandledrejection({ reason: new TypeError('Failed to fetch dynamically imported module: https://static.example.cn/st/v/s/scripts/a.js?v=33333333') });
    assert.equal(JSON.parse(late.storage['st-asset-cdn-failed']).count, 2, 'paused from the next page on');
    late.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://static.example.cn/st/v/s/scripts/b.js?v=1' } });
    assert.equal(late.context.reloaded, false);

    // Configuration cannot close the script early.
    const hostile = transformAppHtml(html, { manifest: MANIFEST, cdn: { baseUrl: 'https://static.example.cn', timeZones: ['</script><script>alert(1)</script>'] } });
    assert.doesNotMatch(hostile, /alert\(1\)<\/script>/);
    const hostileFile = transformAppHtml(html, { manifest: { ...MANIFEST, files: { '</script><script>alert(2)</script>.js': '11111111' } } });
    assert.doesNotMatch(hostileFile, /alert\(2\)<\/script>/);
});

test('with no time zones listed, every page uses the CDN mirror', () => {
    const html = '<html><head></head><body><script type="module" src="script.js"></script></body></html>';
    const page = transformAppHtml(html, { manifest: MANIFEST, cdn: { baseUrl: 'https://s1.example.cn', timeZones: [] } });
    for (const zone of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin']) {
        assert.equal(runAssetScript(page, { zone }).imports['/scripts/a.js'], 'https://s1.example.cn/v/s/scripts/a.js?v=33333333', zone);
    }
    assert.equal(runAssetScript(page, { zone: 'Asia/Shanghai', storage: { 'st-asset-cdn': 'off' } }).imports['/scripts/a.js'], '/v/s/scripts/a.js?v=33333333');
    const recentFailure = { 'st-asset-cdn-failed': JSON.stringify({ at: Date.now() - 60_000, count: 2 }) };
    assert.equal(runAssetScript(page, { zone: 'Europe/Berlin', storage: recentFailure }).imports['/scripts/a.js'], '/v/s/scripts/a.js?v=33333333');
});

test('the CDN mirror address is checked', () => {
    assert.equal(normalizeAssetCdnBaseUrl('https://static.example.cn/'), 'https://static.example.cn');
    assert.equal(normalizeAssetCdnBaseUrl(' https://cdn.example.cn/st// '), 'https://cdn.example.cn/st');
    assert.equal(normalizeAssetCdnBaseUrl('http://127.0.0.1:8152'), 'http://127.0.0.1:8152');
    for (const value of ['', '   ', 'static.example.cn', 'ftp://static.example.cn', 'https://static.example.cn/?x=1', 'https://a:b@static.example.cn', 'javascript:alert(1)', null, 42]) {
        assert.equal(normalizeAssetCdnBaseUrl(value), null, String(value));
    }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { computeAssetVersion, createVersionedAssetsMiddleware, transformAppHtml } from '../src/asset-version.js';

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

test('versioned URLs are rewritten, cached by version, and limited to the app modules', () => {
    const middleware = createVersionedAssetsMiddleware(() => 'abc123def456');
    const run = (url, method = 'GET') => {
        const request = { url, method, get path() { return this.url.split('?')[0]; } };
        const response = { locals: {}, status: null, sendStatus(code) { this.status = code; return this; } };
        let nextCalled = false;
        middleware(request, response, () => { nextCalled = true; });
        return { url: request.url, locals: response.locals, status: response.status, nextCalled };
    };

    const current = run('/v/abc123def456/scripts/extensions/regex/engine.js?x=1');
    assert.equal(current.url, '/scripts/extensions/regex/engine.js?x=1');
    assert.equal(current.locals.versionedAssetCacheControl, 'public, max-age=31536000, immutable');
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

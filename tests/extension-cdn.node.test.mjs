import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';

import { ExtensionCdn, createExtensionCdnMiddleware, isCdnCleanStatus, normalizeRepository, parseAllowedExtensions, readGitHead } from '../src/extension-cdn.js';
import { transformAppHtml } from '../src/asset-version.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-cdn-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

/** A user's extensions folder with one git-installed extension. */
function makeUser(user, folder, remote, files) {
    const directory = path.join(root, user, 'extensions', folder);
    fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-q');
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), content);
    }
    git(directory, 'add', '-A');
    git(directory, 'commit', '-q', '-m', 'init');
    git(directory, 'remote', 'add', 'origin', remote);
    return { extensions: path.join(root, user, 'extensions'), directory, sha: git(directory, 'rev-parse', 'HEAD') };
}

test('repository identities survive mirror proxies, case and .git', () => {
    assert.equal(normalizeRepository('https://github.com/N0VI028/JS-Slash-Runner.git'), 'github.com/n0vi028/js-slash-runner');
    assert.equal(normalizeRepository('https://gh-proxy.org/https://github.com/baibai-git/ST-BaiBai-Book.git'), 'github.com/baibai-git/st-baibai-book');
    assert.equal(normalizeRepository('https://github.com/zonde306/ST-Prompt-Template/'), 'github.com/zonde306/st-prompt-template');
    assert.equal(normalizeRepository('git@github.com:owner/repo.git'), 'github.com/owner/repo');
    assert.equal(normalizeRepository('https://example.com/owner/repo'), null);
    assert.deepEqual(parseAllowedExtensions([{ name: 'A', repos: ['github.com/o/a'] }, { name: '../x', repos: ['github.com/o/x'] }, { name: 'B', repos: [] }]),
        [{ folder: 'A', repos: ['github.com/o/a'] }]);
});

test('only clean checkouts of the listed repositories use the CDN, and it serves committed files only', async () => {
    const allowed = parseAllowedExtensions([{ name: 'Helper', repos: ['github.com/author/Helper'] }]);
    const official = makeUser('alice', 'Helper', 'https://gh-proxy.org/https://github.com/author/Helper.git', {
        'manifest.json': '{"js":"index.js"}',
        'index.js': 'import "../../../extensions.js";\nexport const v = 1;\n',
        'lib/data.mjs': 'export default 2;\n',
    });
    const fork = makeUser('bob', 'Helper', 'https://github.com/someone-else/Helper', { 'index.js': 'export const v = 666;\n' });
    const notListed = makeUser('carol', 'Other', 'https://github.com/author/Other', { 'index.js': '' });
    const cdn = new ExtensionCdn(allowed);

    assert.deepEqual(readGitHead(official.directory), { sha: official.sha, remote: 'https://gh-proxy.org/https://github.com/author/Helper.git' });
    // Checked in the background: the page is never held up by git.
    assert.deepEqual(cdn.getUserExtensions(official.extensions), []);
    await cdn.settle();
    assert.deepEqual(cdn.getUserExtensions(official.extensions), [{ name: 'Helper', sha: official.sha }]);
    assert.deepEqual(cdn.getUserExtensions(fork.extensions), [], 'a fork is not the listed repository');
    await cdn.settle();
    assert.deepEqual(cdn.getUserExtensions(fork.extensions), []);
    assert.deepEqual(cdn.getUserExtensions(notListed.extensions), []);

    // A changed tracked file keeps that user on this server.
    const edited = makeUser('dave', 'Helper', 'https://github.com/author/Helper', { 'index.js': 'export const v = 1;\n' });
    fs.writeFileSync(path.join(edited.directory, 'index.js'), 'export const v = 2;\n');
    cdn.getUserExtensions(edited.extensions);
    await cdn.settle();
    assert.deepEqual(cdn.getUserExtensions(edited.extensions), []);

    // Source maps deleted from the copy (a past disk cleanup) still count as clean; anything else does not.
    const mapless = makeUser('erin', 'Helper', 'https://github.com/author/Helper', { 'index.js': 'export const v = 1;\n', 'dist/index.js.map': '{}' });
    fs.rmSync(path.join(mapless.directory, 'dist', 'index.js.map'));
    const missingCode = makeUser('frank', 'Helper', 'https://github.com/author/Helper', { 'index.js': 'export const v = 1;\n', 'dist/index.js': '1' });
    fs.rmSync(path.join(missingCode.directory, 'dist', 'index.js'));
    cdn.getUserExtensions(mapless.extensions);
    cdn.getUserExtensions(missingCode.extensions);
    await cdn.settle();
    assert.deepEqual(cdn.getUserExtensions(mapless.extensions), [{ name: 'Helper', sha: mapless.sha }]);
    assert.deepEqual(cdn.getUserExtensions(missingCode.extensions), [], 'a deleted script keeps the user on this server');
    assert.equal(isCdnCleanStatus(''), true);
    assert.equal(isCdnCleanStatus(' D dist/a.js.map\nD  "dist/b c.css.map"\n'), true);
    assert.equal(isCdnCleanStatus(' D dist/a.js.map\n M index.js\n'), false);
    assert.equal(isCdnCleanStatus(' M dist/a.js.map\n'), false, 'a changed map is a change');

    const list = () => [official.extensions, fork.extensions];
    assert.equal(String(await cdn.readFile('Helper', official.sha, 'lib/data.mjs', list)), 'export default 2;\n');
    // Always the committed file, never the working tree.
    fs.writeFileSync(path.join(official.directory, 'index.js'), 'tampered\n');
    assert.match(String(await cdn.readFile('Helper', official.sha, 'index.js', list)), /export const v = 1/);
    for (const bad of ['../index.js', 'lib/../index.js', '.git/config', '', 'lib', 'missing.js']) {
        assert.equal(await cdn.readFile('Helper', official.sha, bad, list), null, bad);
    }
    assert.equal(await cdn.readFile('Helper', fork.sha, 'index.js', list), null, 'commits of a fork are not served');
    assert.equal(await cdn.readFile('Other', notListed.sha, 'index.js', () => [notListed.extensions]), null);

    // Found again from the folder list after a restart (nothing remembered).
    const fresh = new ExtensionCdn(allowed);
    assert.equal(String(await fresh.readFile('Helper', official.sha, 'lib/data.mjs', list)), 'export default 2;\n');

    const middleware = createExtensionCdnMiddleware(fresh, list);
    const call = (url, method = 'GET') => new Promise(resolve => {
        const response = {
            headers: {}, status: 200, body: null,
            setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
            type(value) { this.headers['content-type'] = value; return this; },
            sendStatus(code) { this.status = code; resolve(this); return this; },
            send(body) { this.body = body; resolve(this); return this; },
        };
        void middleware({ method, path: url, url }, response, () => resolve({ next: true }));
    });
    const served = await call(`/v/e/${official.sha}/scripts/extensions/third-party/Helper/lib/data.mjs`);
    assert.equal(String(served.body), 'export default 2;\n');
    assert.equal(served.headers['content-type'], 'text/javascript; charset=utf-8', 'module scripts need a JavaScript type');
    assert.equal(served.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(served.headers['access-control-allow-origin'], '*');
    const missing = await call(`/v/e/${official.sha}/scripts/extensions/third-party/Helper/missing.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cache-control'], 'no-store', 'a CDN must not keep a 404');
    assert.equal((await call(`/v/e/${official.sha}/scripts/extensions/third-party/Helper/index.js`, 'POST')).status, 405);
    assert.equal((await call(`/v/e/${'0'.repeat(40)}/scripts/extensions/third-party/Helper/index.js`)).status, 404);
    assert.equal((await call('/v/abc123def456/script.js')).next, true, 'other /v/ paths are left to the next handler');
});

test('a mirrored extension resolves its relative imports to the app, to itself and to other extensions', () => {
    const html = '<html><head></head><body><script type="module" src="script.js"></script></body></html>';
    const manifest = { version: 'abc123def456', files: { 'script.js': '11111111', 'scripts/extensions.js': '22222222' }, styles: {} };
    const page = transformAppHtml(html, { manifest, cdn: { baseUrl: 'https://s1.example.cn', timeZones: [] } });
    const sha = 'a'.repeat(40);
    const withUser = page.replace('"thirdParty":[]', JSON.stringify({ thirdParty: [{ name: 'Helper', sha }, { name: 'Other', sha: 'b'.repeat(40) }] }).slice(1, -1));
    assert.notEqual(withUser, page);
    const script = /<script>(\(function \(o\)[\s\S]*?)<\/script>/.exec(withUser)[1];
    const inserted = [];
    const element = tagName => ({ tagName, after(next) { inserted.push(next); } });
    const context = {
        HTMLScriptElement: { supports: type => type === 'importmap' },
        localStorage: { getItem: () => null, setItem: () => {} },
        Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) },
        document: { createElement: element, currentScript: element('SCRIPT') },
        addEventListener: () => {},
        location: { origin: 'https://site.example', reload: () => {} },
        console: { warn: () => {} },
        Worker: function Worker(url, options) { this.url = String(url); this.options = options; },
    };
    context.window = context;
    const NativeWorker = context.Worker;
    vm.runInNewContext(script, context);
    const imports = JSON.parse(inserted.find(item => item.type === 'importmap').textContent).imports;
    const base = `https://s1.example.cn/v/e/${sha}`;
    const extensions = 'https://s1.example.cn/v/s/scripts/extensions.js?v=22222222';
    assert.equal(imports['/scripts/extensions/third-party/Helper/'], `${base}/scripts/extensions/third-party/Helper/`);
    // "../../../extensions.js" from the extension: the app's own module on the mirror, the same instance.
    assert.equal(imports[`${base}/scripts/extensions.js`], extensions);
    assert.equal(imports['/scripts/extensions.js'], extensions);
    assert.equal(imports[`${base}/script.js`], 'https://s1.example.cn/v/s/script.js?v=11111111');
    // Its own files stay where they are; another mirrored extension at its own commit; others come from this server.
    assert.equal(imports[`${base}/scripts/extensions/third-party/Other/`], `https://s1.example.cn/v/e/${'b'.repeat(40)}/scripts/extensions/third-party/Other/`);
    assert.equal(imports[`${base}/scripts/extensions/third-party/`], 'https://site.example/scripts/extensions/third-party/');
    assert.equal(imports[`${base}/scripts/extensions/third-party/Helper/`], `${base}/scripts/extensions/third-party/Helper/`);
    assert.deepEqual(JSON.parse(JSON.stringify(context.__stAssetCdn)), { thirdParty: { Helper: base, Other: `https://s1.example.cn/v/e/${'b'.repeat(40)}` } }, 'the extension loader uses the same URL');

    // Workers cannot come from another origin: one made from a mirrored module is created from this server.
    const fromExtension = new context.Worker(`${base}/scripts/extensions/third-party/Helper/assets/runtime.worker.js`, { type: 'module' });
    assert.equal(fromExtension.url, 'https://site.example/scripts/extensions/third-party/Helper/assets/runtime.worker.js');
    assert.deepEqual(fromExtension.options, { type: 'module' });
    assert.ok(fromExtension instanceof NativeWorker && fromExtension instanceof context.Worker);
    assert.equal(new context.Worker({ href: 'https://s1.example.cn/v/s/scripts/extensions/tts/kokoro-worker.js?v=12345678' }).url,
        'https://site.example/v/s/scripts/extensions/tts/kokoro-worker.js?v=12345678');
    assert.equal(new context.Worker('blob:https://site.example/1234').url, 'blob:https://site.example/1234', 'other workers are left alone');
    assert.equal(new context.Worker('/scripts/extensions/third-party/Other/w.js').url, '/scripts/extensions/third-party/Other/w.js');
});

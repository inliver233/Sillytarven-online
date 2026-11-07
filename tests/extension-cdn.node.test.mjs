import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import vm from 'node:vm';

import { ExtensionCdn, createExtensionCdnMiddleware, normalizeRepository, parseAllowedExtensions, readGitHead } from '../src/extension-cdn.js';
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
    assert.equal((await call(`/v/e/${official.sha}/scripts/extensions/third-party/Helper/missing.js`)).status, 404);
    assert.equal((await call(`/v/e/${official.sha}/scripts/extensions/third-party/Helper/index.js`, 'POST')).status, 405);
    assert.equal((await call(`/v/e/${'0'.repeat(40)}/scripts/extensions/third-party/Helper/index.js`)).status, 404);
    assert.equal((await call('/v/abc123def456/script.js')).next, true, 'other /v/ paths are left to the next handler');
});

test('a mirrored extension resolves its relative imports to the app, to itself and to other extensions', () => {
    const html = '<html><head></head><body><script type="module" src="script.js"></script></body></html>';
    const page = transformAppHtml(html, { version: 'abc123def456', cdn: { baseUrl: 'https://s1.example.cn', timeZones: [] } });
    const sha = 'a'.repeat(40);
    const withUser = page.replace('"thirdParty":[]', JSON.stringify({ thirdParty: [{ name: 'Helper', sha }] }).slice(1, -1));
    assert.notEqual(withUser, page);
    const script = /<script>(\(function \(o\)[\s\S]*?)<\/script>/.exec(withUser)[1];
    let inserted = null;
    const context = {
        localStorage: { getItem: () => null, setItem: () => {} },
        Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }) },
        document: { createElement: () => ({}), currentScript: { after: element => { inserted = element; } } },
        addEventListener: () => {},
        location: { origin: 'https://site.example', reload: () => {} },
        Worker: function Worker(url, options) { this.url = String(url); this.options = options; },
    };
    context.window = context;
    const NativeWorker = context.Worker;
    vm.runInNewContext(script, context);
    const imports = JSON.parse(inserted.textContent).imports;
    const base = `https://s1.example.cn/v/e/${sha}`;
    assert.equal(imports['/scripts/extensions/third-party/Helper/'], `${base}/scripts/extensions/third-party/Helper/`);
    // "../../../extensions.js" from the extension: the app's own module on the mirror.
    assert.equal(imports[`${base}/scripts/`], 'https://s1.example.cn/v/abc123def456/scripts/');
    assert.equal(imports[`${base}/script.js`], 'https://s1.example.cn/v/abc123def456/script.js');
    // Its own files stay where they are; other third-party extensions come from this server.
    assert.equal(imports[`${base}/scripts/extensions/third-party/Helper/`], `${base}/scripts/extensions/third-party/Helper/`);
    assert.equal(imports[`${base}/scripts/extensions/third-party/`], '/scripts/extensions/third-party/');
    assert.deepEqual(JSON.parse(JSON.stringify(context.__stAssetCdn)), { thirdParty: { Helper: base } }, 'the extension loader uses the same URL');

    // Workers cannot come from another origin: one made from a mirrored module is created from this server.
    const fromExtension = new context.Worker(`${base}/scripts/extensions/third-party/Helper/assets/runtime.worker.js`, { type: 'module' });
    assert.equal(fromExtension.url, 'https://site.example/scripts/extensions/third-party/Helper/assets/runtime.worker.js');
    assert.deepEqual(fromExtension.options, { type: 'module' });
    assert.ok(fromExtension instanceof NativeWorker && fromExtension instanceof context.Worker);
    assert.equal(new context.Worker({ href: 'https://s1.example.cn/v/abc123def456/scripts/extensions/tts/kokoro-worker.js' }).url,
        'https://site.example/v/abc123def456/scripts/extensions/tts/kokoro-worker.js');
    assert.equal(new context.Worker('blob:https://site.example/1234').url, 'blob:https://site.example/1234', 'other workers are left alone');
    assert.equal(new context.Worker('/scripts/extensions/third-party/Other/w.js').url, '/scripts/extensions/third-party/Other/w.js');
});

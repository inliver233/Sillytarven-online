import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

// Default configuration: local repositories are not allowed.
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
delete process.env.SILLYTAVERN_EXTENSIONS_ALLOWLOCALREPOSITORIES;
const { router } = await import('../src/endpoints/extensions.js');

function createRepository(directory) {
    fs.mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: directory, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Extension Test'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'extension-test@example.invalid'], { cwd: directory });
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ display_name: 'Local', js: 'index.js' }));
    fs.writeFileSync(path.join(directory, 'private.txt'), 'not for other users');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: directory, stdio: 'ignore' });
}

async function startServer(extensionsDirectory) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: 'extension-test-user', admin: false },
            directories: { extensions: extensionsDirectory },
        };
        next();
    });
    app.use('/api/extensions', router);
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/extensions/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { post, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('extensions cannot be installed from local paths or non-HTTP transports', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-protocol-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = path.join(root, 'local-repository');
    const extensionsDirectory = path.join(root, 'extensions');
    createRepository(repository);
    fs.mkdirSync(extensionsDirectory);
    const server = await startServer(extensionsDirectory);
    t.after(() => server.close());

    for (const url of [`file://${repository}`, repository, 'git@github.com:example/extension.git', 'ssh://git@example.invalid/extension.git', `ext::git -C ${repository} upload-pack .`]) {
        const response = await server.post('install', { url });
        assert.equal(response.status, 400, url);
    }
    assert.deepEqual(fs.readdirSync(extensionsDirectory), []);
});

test('an installed extension whose origin is a local repository cannot be updated from it', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-protocol-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = path.join(root, 'local-repository');
    const extensionsDirectory = path.join(root, 'extensions');
    createRepository(repository);
    fs.mkdirSync(extensionsDirectory);
    // An extension cloned from a local path before the check existed.
    execFileSync('git', ['clone', '--depth', '1', `file://${repository}`, path.join(extensionsDirectory, 'old-extension')], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repository, 'private.txt'), 'changed secret');
    execFileSync('git', ['commit', '-am', 'change'], { cwd: repository, stdio: 'ignore' });
    const server = await startServer(extensionsDirectory);
    t.after(() => server.close());

    const response = await server.post('update', { extensionName: 'old-extension' });
    assert.notEqual(response.status, 200);
    assert.equal(fs.readFileSync(path.join(extensionsDirectory, 'old-extension', 'private.txt'), 'utf8'), 'not for other users');

    // The same update goes through once local repositories are allowed: only the transport was refused.
    process.env.SILLYTAVERN_EXTENSIONS_ALLOWLOCALREPOSITORIES = 'true';
    t.after(() => { delete process.env.SILLYTAVERN_EXTENSIONS_ALLOWLOCALREPOSITORIES; });
    const allowed = await server.post('update', { extensionName: 'old-extension' });
    assert.equal(allowed.status, 200, await allowed.text());
    assert.equal(fs.readFileSync(path.join(extensionsDirectory, 'old-extension', 'private.txt'), 'utf8'), 'changed secret');
});

test('HTTP(S) extension URLs still reach git', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-protocol-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const extensionsDirectory = path.join(root, 'extensions');
    fs.mkdirSync(extensionsDirectory);
    const server = await startServer(extensionsDirectory);
    t.after(() => server.close());

    // Nothing listens on port 9: git itself has to report the failed connection.
    const response = await server.post('install', { url: 'http://127.0.0.1:9/example/extension.git' });
    const text = await response.text();
    assert.equal(response.status, 500, text);
    assert.doesNotMatch(text, /not permitted|not allowed|Only HTTP/);
    assert.match(text, /127\.0\.0\.1|connect/i);
});

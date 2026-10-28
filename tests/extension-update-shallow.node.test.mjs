import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { router } from '../src/endpoints/extensions.js';

function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function commitBlob(repository, message) {
    fs.writeFileSync(path.join(repository, 'bundle.bin'), crypto.randomBytes(64 * 1024));
    fs.writeFileSync(path.join(repository, 'version.txt'), message);
    git(repository, 'add', '-A');
    git(repository, 'commit', '-m', message);
}

function createUpstream(directory) {
    fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init', '--initial-branch=main');
    git(directory, 'config', 'user.name', 'Extension Test');
    git(directory, 'config', 'user.email', 'extension-test@example.invalid');
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ display_name: 'Shallow', version: '1.0.0' }));
    commitBlob(directory, 'initial');
}

function historyLength(repository) {
    return Number(git(repository, 'rev-list', '--count', 'HEAD'));
}

function packedKiB(repository) {
    const stats = Object.fromEntries(git(repository, 'count-objects', '-v').split('\n').map(line => line.split(': ')));
    return Number(stats['size-pack']) + Number(stats.size);
}

async function waitFor(predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
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
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        post: async (route, body) => {
            const response = await fetch(`${baseUrl}/api/extensions/${route}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            const isJson = response.headers.get('content-type')?.includes('application/json');
            return { status: response.status, body: isJson ? await response.json() : await response.text() };
        },
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}

test('update checks and updates keep extension clones shallow', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-shallow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const upstream = path.join(root, 'upstream', 'shallow-extension');
    const extensionsDirectory = path.join(root, 'extensions');
    const extension = path.join(extensionsDirectory, 'shallow-extension');
    createUpstream(upstream);
    const server = await startServer(extensionsDirectory);
    t.after(server.close);

    assert.equal((await server.post('install', { url: `file://${upstream}` })).status, 200);
    fs.writeFileSync(path.join(extension, 'user-data.json'), 'kept');
    for (let i = 0; i < 20; i++) commitBlob(upstream, `change ${i}`);

    const version = await server.post('version', { extensionName: 'shallow-extension' });
    assert.equal(version.status, 200);
    assert.equal(version.body.isUpToDate, false);
    assert.equal(Number(git(extension, 'rev-list', '--count', 'origin/main')), 1, 'checking must fetch only the tip');

    const updated = await server.post('update', { extensionName: 'shallow-extension' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.isUpToDate, false);
    assert.equal(git(extension, 'rev-parse', 'HEAD'), git(upstream, 'rev-parse', 'HEAD'));
    assert.equal(fs.readFileSync(path.join(extension, 'version.txt'), 'utf8'), 'change 19');
    assert.equal(fs.readFileSync(path.join(extension, 'user-data.json'), 'utf8'), 'kept');
    assert.equal(historyLength(extension), 1);
    assert.equal(git(extension, 'rev-parse', '--is-shallow-repository'), 'true');

    const again = await server.post('version', { extensionName: 'shallow-extension' });
    assert.equal(again.body.isUpToDate, true);
});

test('a clone whose history already grew is compacted once it is up to date', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-compact-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const upstream = path.join(root, 'upstream', 'grown-extension');
    const extensionsDirectory = path.join(root, 'extensions');
    const extension = path.join(extensionsDirectory, 'grown-extension');
    createUpstream(upstream);
    const server = await startServer(extensionsDirectory);
    t.after(server.close);

    assert.equal((await server.post('install', { url: `file://${upstream}` })).status, 200);
    for (let i = 0; i < 30; i++) commitBlob(upstream, `change ${i}`);
    // What the old plain fetch + pull left behind
    git(extension, 'fetch', 'origin');
    git(extension, 'merge', '--ff-only', 'origin/main');
    assert.equal(historyLength(extension), 31);
    const grownKiB = packedKiB(extension);
    assert.ok(grownKiB > 30 * 64, `expected the grown history on disk, got ${grownKiB} KiB`);

    const version = await server.post('version', { extensionName: 'grown-extension' });
    assert.equal(version.body.isUpToDate, true);
    await waitFor(() => packedKiB(extension) < grownKiB / 5);
    assert.equal(historyLength(extension), 1);
    assert.equal(fs.readFileSync(path.join(extension, 'version.txt'), 'utf8'), 'change 29');
    assert.equal(git(extension, 'status', '--porcelain'), '');
});

test('listing and switching branches does not unshallow the clone', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-branches-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const upstream = path.join(root, 'upstream', 'branchy-extension');
    const extensionsDirectory = path.join(root, 'extensions');
    const extension = path.join(extensionsDirectory, 'branchy-extension');
    createUpstream(upstream);
    for (let i = 0; i < 10; i++) commitBlob(upstream, `main ${i}`);
    git(upstream, 'checkout', '-b', 'beta');
    for (let i = 0; i < 10; i++) commitBlob(upstream, `beta ${i}`);
    git(upstream, 'checkout', 'main');
    const server = await startServer(extensionsDirectory);
    t.after(server.close);

    assert.equal((await server.post('install', { url: `file://${upstream}` })).status, 200);
    const branches = await server.post('branches', { extensionName: 'branchy-extension' });
    assert.equal(branches.status, 200);
    assert.ok(branches.body.some(branch => branch.name === 'origin/beta'));
    assert.equal(git(extension, 'rev-parse', '--is-shallow-repository'), 'true');

    const switched = await server.post('switch', { extensionName: 'branchy-extension', branch: 'origin/beta' });
    assert.equal(switched.status, 204);
    assert.equal(fs.readFileSync(path.join(extension, 'version.txt'), 'utf8'), 'beta 9');
    assert.equal(historyLength(extension), 1);

    const missing = await server.post('switch', { extensionName: 'branchy-extension', branch: 'nope' });
    assert.equal(missing.status, 404);
});

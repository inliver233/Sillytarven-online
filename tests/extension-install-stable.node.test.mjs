import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { normalizeExtensionCloneUrl, router } from '../src/endpoints/extensions.js';

function createRepository(directory, manifest) {
    fs.mkdirSync(directory, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: directory, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Extension Test'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'extension-test@example.invalid'], { cwd: directory });
    if (manifest) {
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    } else {
        fs.writeFileSync(path.join(directory, 'README.md'), 'missing manifest');
    }
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
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    };
}

test('canonicalizes only standard GitLab HTTPS repository URLs', () => {
    assert.equal(
        normalizeExtensionCloneUrl('https://gitlab.com/novi028/JS-Slash-Runner'),
        'https://gitlab.com/novi028/JS-Slash-Runner.git',
    );
    assert.equal(
        normalizeExtensionCloneUrl('https://gitlab.com/group/subgroup/repository/'),
        'https://gitlab.com/group/subgroup/repository.git',
    );
    assert.equal(
        normalizeExtensionCloneUrl('https://gitlab.com/group/repository.git'),
        'https://gitlab.com/group/repository.git',
    );
    assert.equal(
        normalizeExtensionCloneUrl('https://gitlab.com/group/repository/-/tree/main'),
        'https://gitlab.com/group/repository/-/tree/main',
    );
    assert.equal(
        normalizeExtensionCloneUrl('https://gitlab.com.example/group/repository'),
        'https://gitlab.com.example/group/repository',
    );
    assert.equal(
        normalizeExtensionCloneUrl('http://gitlab.com/group/repository'),
        'http://gitlab.com/group/repository',
    );
});

test('installs a default-branch extension transactionally and cleans a failed install', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-install-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const extensionsDirectory = path.join(temporaryRoot, 'extensions');
    const validRepository = path.join(temporaryRoot, 'valid-extension');
    const invalidRepository = path.join(temporaryRoot, 'invalid-extension');
    createRepository(validRepository, { version: '1.2.3', author: 'test', display_name: 'Valid Extension' });
    createRepository(invalidRepository, null);
    const server = await startServer(extensionsDirectory);
    t.after(server.close);

    const installed = await fetch(`${server.baseUrl}/api/extensions/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `file://${validRepository}`, branch: '' }),
    });
    assert.equal(installed.status, 200);
    assert.equal((await installed.json()).display_name, 'Valid Extension');
    assert.ok(fs.existsSync(path.join(extensionsDirectory, 'valid-extension', 'manifest.json')));

    const failed = await fetch(`${server.baseUrl}/api/extensions/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `file://${invalidRepository}`, branch: '' }),
    });
    assert.equal(failed.status, 500);
    assert.equal(fs.existsSync(path.join(extensionsDirectory, 'invalid-extension')), false);
    assert.deepEqual(
        fs.readdirSync(extensionsDirectory).filter(name => name.includes('.install-')),
        [],
    );
});

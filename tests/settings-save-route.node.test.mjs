/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import writeFileAtomic from 'write-file-atomic';

import { createSettingsSaveHandler } from '../src/settings-save.js';

async function startSettingsServer(root, writer) {
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'settings-user' }, directories: { root } };
        next();
    });
    app.post('/api/settings/save', createSettingsSaveHandler({ writeSettings: writer }));
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function postSettings(baseUrl, payload) {
    return await fetch(`${baseUrl}/api/settings/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

test('failed settings write returns 507 and the identical payload retries after storage recovers', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-save-'));
    let attempts = 0;
    const writer = async (filePath, data) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        await writeFileAtomic(filePath, data, 'utf8');
    };
    const { server, baseUrl } = await startSettingsServer(root, writer);
    try {
        const payload = { theme: 'dark', amount_gen: 200 };
        const failed = await postSettings(baseUrl, payload);
        assert.equal(failed.status, 507);
        assert.deepEqual(await failed.json(), {
            error: 'settings_storage_exhausted',
            message: 'The server does not have enough storage space to save settings.',
        });
        assert.equal(fs.existsSync(path.join(root, 'settings.json')), false);

        const retried = await postSettings(baseUrl, payload);
        assert.equal(retried.status, 200);
        assert.deepEqual(await retried.json(), { result: 'ok' });
        assert.equal(attempts, 2);
        assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(root, 'settings.json'), 'utf8')), payload);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('settings write failures expose stable permission and generic error codes', async () => {
    const cases = [
        { code: 'EACCES', status: 500, error: 'settings_permission_denied' },
        { code: 'EPERM', status: 500, error: 'settings_permission_denied' },
        { code: 'EDQUOT', status: 507, error: 'settings_storage_exhausted' },
        { code: 'EIO', status: 500, error: 'settings_write_failed' },
    ];
    for (const item of cases) {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-error-'));
        const { server, baseUrl } = await startSettingsServer(root, async () => {
            throw Object.assign(new Error('injected write failure'), { code: item.code });
        });
        try {
            const response = await postSettings(baseUrl, { code: item.code });
            assert.equal(response.status, item.status);
            assert.equal((await response.json()).error, item.error);
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    }
});

test('overlapping settings saves serialize per user and leave the newest payload on disk', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-overlap-'));
    let active = 0;
    let maxActive = 0;
    let releaseFirst;
    let announceFirst;
    const firstStarted = new Promise(resolve => { announceFirst = resolve; });
    const firstRelease = new Promise(resolve => { releaseFirst = resolve; });
    let writes = 0;
    const writer = async (filePath, data) => {
        writes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (writes === 1) {
            announceFirst();
            await firstRelease;
        }
        await writeFileAtomic(filePath, data, 'utf8');
        active -= 1;
    };
    const { server, baseUrl } = await startSettingsServer(root, writer);
    try {
        const first = postSettings(baseUrl, { revision: 1 });
        await firstStarted;
        const second = postSettings(baseUrl, { revision: 2 });
        releaseFirst();
        const responses = await Promise.all([first, second]);
        assert.deepEqual(responses.map(response => response.status), [200, 200]);
        assert.equal(maxActive, 1);
        assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(root, 'settings.json'), 'utf8')), { revision: 2 });
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

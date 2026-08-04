/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import writeFileAtomic from 'write-file-atomic';

import {
    createSettingsSaveHandler,
    MAX_SETTINGS_MIGRATION_PAYLOAD_BYTES,
} from '../src/settings-save.js';

async function startSettingsServer(root, writer) {
    const app = express();
    app.use(express.json({ limit: MAX_SETTINGS_MIGRATION_PAYLOAD_BYTES }));
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: 'settings-user' },
            directories: {
                root,
                backups: path.join(root, 'backups'),
                extensionData: path.join(root, 'extension-data'),
            },
        };
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

test('oversized extension settings migrate while core settings still save', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-migrate-'));
    const { server, baseUrl } = await startSettingsServer(root);
    try {
        const response = await postSettings(baseUrl, {
            theme: 'dark',
            extension_settings: {
                disabledExtensions: [],
                chatu8: { cache: 'x'.repeat(600 * 1024) },
            },
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.result, 'ok');
        assert.equal(result.migratedExtensionSettings.chatu8.cache, '');

        const saved = JSON.parse(await fs.promises.readFile(path.join(root, 'settings.json'), 'utf8'));
        assert.equal(saved.theme, 'dark');
        assert.equal(saved.extension_settings._storageReferences.chatu8.kind, 'legacy-extension-settings');
        assert.equal(JSON.stringify(saved).includes('x'.repeat(1024)), false);
        assert.equal(fs.existsSync(path.join(root, 'extension-data', 'chatu8', 'legacy', 'settings.json.gz')), true);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('legacy requests larger than 5 MiB reach migration before the compact limit is enforced', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-large-migrate-'));
    const { server, baseUrl } = await startSettingsServer(root);
    try {
        const response = await postSettings(baseUrl, {
            theme: 'dark',
            extension_settings: {
                chatu8: { imageIndex: 'x'.repeat(6 * 1024 * 1024) },
            },
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).result, 'ok');

        const savedText = await fs.promises.readFile(path.join(root, 'settings.json'), 'utf8');
        assert.ok(Buffer.byteLength(savedText) < 5 * 1024 * 1024);
        assert.equal(JSON.parse(savedText).extension_settings.chatu8.imageIndex, '');
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('OpenAI extension data migrates and updates the browser compatibility value', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-oai-migrate-'));
    const { server, baseUrl } = await startSettingsServer(root);
    try {
        const response = await postSettings(baseUrl, {
            oai_settings: {
                extensions: {
                    tavernHelper: { cache: 'x'.repeat(600 * 1024) },
                },
            },
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.migratedOaiExtensionSettings.tavernHelper.cache, '');

        const saved = JSON.parse(await fs.promises.readFile(path.join(root, 'settings.json'), 'utf8'));
        assert.equal(saved.oai_settings.extensions.tavernHelper.cache, '');
        assert.equal(
            saved.oai_settings.extensions._storageReferences.tavernHelper.source,
            'oai_settings.extensions',
        );
        assert.equal(
            fs.existsSync(path.join(root, 'extension-data', 'tavernHelper', 'legacy', 'oai-settings.json.gz')),
            true,
        );
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('non-extension settings still cannot exceed the compact 5 MiB limit', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-compact-limit-'));
    const { server, baseUrl } = await startSettingsServer(root);
    try {
        const response = await postSettings(baseUrl, { unrelatedCache: 'x'.repeat(6 * 1024 * 1024) });
        assert.equal(response.status, 413);
        assert.deepEqual(await response.json(), {
            error: 'settings_compact_payload_too_large',
            message: 'Settings still exceed the 5 MiB limit after extension data migration.',
        });
        assert.equal(fs.existsSync(path.join(root, 'settings.json')), false);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test('migration failure preserves the previous extension value while saving core settings', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-migrate-failure-'));
    await fs.promises.writeFile(path.join(root, 'extension-data'), 'not-a-directory');
    await fs.promises.writeFile(path.join(root, 'settings.json'), JSON.stringify({
        theme: 'old',
        extension_settings: { chatu8: { preserved: true } },
    }));
    const { server, baseUrl } = await startSettingsServer(root);
    try {
        const response = await postSettings(baseUrl, {
            theme: 'new',
            extension_settings: { chatu8: { cache: 'x'.repeat(600 * 1024) } },
        });
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.rejectedExtensionSettings[0].extensionId, 'chatu8');
        const saved = JSON.parse(await fs.promises.readFile(path.join(root, 'settings.json'), 'utf8'));
        assert.equal(saved.theme, 'new');
        assert.deepEqual(saved.extension_settings.chatu8, { preserved: true });
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

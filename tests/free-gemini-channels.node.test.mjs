import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createFreeGeminiChannel,
    deleteFreeGeminiChannel,
    getEnabledFreeGeminiChannel,
    listAdminFreeGeminiChannels,
    listPublicFreeGeminiChannels,
    updateFreeGeminiChannel,
} from '../src/free-gemini-channels.js';

async function withTempDataRoot(callback) {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-free-gemini-'));
    globalThis.DATA_ROOT = dataRoot;
    try {
        await callback(dataRoot);
    } finally {
        globalThis.DATA_ROOT = previousDataRoot;
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
    }
}

test('free Gemini channels keep credentials server-side', async () => {
    await withTempDataRoot(async () => {
        const created = await createFreeGeminiChannel({
            name: '  free-gemini  ',
            url: 'https://generativelanguage.googleapis.com/',
            key: 'secret-api-key-123',
            enabled: true,
            ignored: 'not persisted',
        });

        assert.match(created.id, /^[0-9a-f-]{36}$/i);
        assert.equal(created.name, 'free-gemini');
        assert.equal(created.url, 'https://generativelanguage.googleapis.com');
        assert.equal(created.hasKey, true);
        assert.equal(created.maskedKey.endsWith('123'), true);
        assert.equal(Object.hasOwn(created, 'key'), false);

        const publicChannels = await listPublicFreeGeminiChannels();
        assert.deepEqual(publicChannels, [{ id: created.id, name: 'free-gemini' }]);
        assert.equal(Object.hasOwn(publicChannels[0], 'url'), false);
        assert.equal(Object.hasOwn(publicChannels[0], 'key'), false);

        const resolved = await getEnabledFreeGeminiChannel(created.id);
        assert.equal(resolved.key, 'secret-api-key-123');
        assert.equal(Object.hasOwn(resolved, 'ignored'), false);
    });
});

test('updating with an empty key preserves the existing credential', async () => {
    await withTempDataRoot(async () => {
        const created = await createFreeGeminiChannel({
            name: 'free-gemini',
            url: 'https://example.com/v1beta',
            key: 'original-secret',
        });

        const updated = await updateFreeGeminiChannel(created.id, {
            name: 'free-gemini-2',
            url: 'https://example.com/v1beta/',
            key: '   ',
            enabled: true,
        });

        assert.equal(updated.name, 'free-gemini-2');
        assert.equal(updated.url, 'https://example.com/v1beta');
        assert.equal((await getEnabledFreeGeminiChannel(created.id)).key, 'original-secret');
    });
});

test('disabled and deleted channels are unavailable to members', async () => {
    await withTempDataRoot(async () => {
        const created = await createFreeGeminiChannel({
            url: 'https://example.com',
            key: 'secret',
        });

        await updateFreeGeminiChannel(created.id, { enabled: false });
        assert.deepEqual(await listPublicFreeGeminiChannels(), []);
        assert.equal(await getEnabledFreeGeminiChannel(created.id), null);

        assert.equal(await deleteFreeGeminiChannel(created.id), true);
        assert.equal(await deleteFreeGeminiChannel(created.id), false);
        assert.deepEqual(await listAdminFreeGeminiChannels(), []);
    });
});

test('free Gemini channel validation rejects unsafe URLs and missing keys', async () => {
    await withTempDataRoot(async () => {
        await assert.rejects(
            createFreeGeminiChannel({ url: 'file:///tmp/gemini', key: 'secret' }),
            /仅支持 http 或 https/,
        );
        await assert.rejects(
            createFreeGeminiChannel({ url: 'https://user:pass@example.com', key: 'secret' }),
            /不能包含用户名或密码/,
        );
        await assert.rejects(
            createFreeGeminiChannel({ url: 'https://example.com?key=leak', key: 'secret' }),
            /不能包含查询参数或锚点/,
        );
        await assert.rejects(
            createFreeGeminiChannel({ url: 'https://example.com', key: '' }),
            /必须填写 API Key/,
        );
    });
});

test('concurrent channel creation does not lose entries', async () => {
    await withTempDataRoot(async () => {
        await Promise.all(Array.from({ length: 5 }, (_, index) => createFreeGeminiChannel({
            name: `free-gemini-${index}`,
            url: `https://example${index}.com`,
            key: `secret-${index}`,
        })));

        const channels = await listAdminFreeGeminiChannels();
        assert.equal(channels.length, 5);
        assert.equal(channels.every(channel => !Object.hasOwn(channel, 'key')), true);
    });
});

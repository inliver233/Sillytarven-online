import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';

import {
    createFreeGeminiChannel,
    deleteFreeGeminiChannel,
    getEnabledFreeGeminiChannel,
    getFreeGeminiChannelModels,
    listAdminFreeGeminiChannels,
    listPublicFreeGeminiChannels,
    migrateLegacyFreeGeminiChannels,
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
        const previousNodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
        try {
            await assert.rejects(
                createFreeGeminiChannel({ url: 'file:///tmp/gemini', key: 'secret' }),
                /必须使用 https/,
            );
            await assert.rejects(
                createFreeGeminiChannel({ url: 'http://example.com', key: 'secret' }),
                /必须使用 https/,
            );
            await assert.rejects(
                createFreeGeminiChannel({ url: 'https://127.0.0.1', key: 'secret' }),
                /必须使用公网主机/,
            );
            await assert.rejects(
                createFreeGeminiChannel({ url: 'https://169.254.169.254', key: 'secret' }),
                /必须使用公网主机/,
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
        } finally {
            process.env.NODE_ENV = previousNodeEnv;
        }
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

test('channel routing settings are normalized, returned to admins, and validated', async () => {
    await withTempDataRoot(async () => {
        const created = await createFreeGeminiChannel({
            name: 'policy-channel',
            url: 'https://example.com',
            key: 'secret',
            priority: 900,
            modelPolicy: 'allowlist',
            models: ['models/gemini-b', 'gemini-a', 'gemini-a'],
            timeoutMs: 5000,
            maxRetries: 3,
            modelCacheTtlMs: 30000,
            maxOutputTokens: 65536,
        });

        assert.deepEqual({
            priority: created.priority,
            modelPolicy: created.modelPolicy,
            models: created.models,
            timeoutMs: created.timeoutMs,
            maxRetries: created.maxRetries,
            modelCacheTtlMs: created.modelCacheTtlMs,
            maxOutputTokens: created.maxOutputTokens,
        }, {
            priority: 900,
            modelPolicy: 'allowlist',
            models: ['gemini-b', 'gemini-a'],
            timeoutMs: 5000,
            maxRetries: 3,
            modelCacheTtlMs: 30000,
            maxOutputTokens: 65536,
        });

        await assert.rejects(updateFreeGeminiChannel(created.id, { priority: 1001 }), /0\.\.1000/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { modelPolicy: 'sometimes' }), /all、allowlist 或 denylist/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { timeoutMs: 4999 }), /5000\.\.120000/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { maxRetries: 4 }), /0\.\.3/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { modelCacheTtlMs: 29999 }), /30000\.\.3600000/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { maxOutputTokens: -1 }), /0 或 1\.\.65536/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { models: ['ok', 123] }), /模型 ID/);
        await assert.rejects(updateFreeGeminiChannel(created.id, { models: ['../models?key=leak'] }), /模型 ID/);
    });
});

test('legacy channels receive backward-compatible routing defaults', async () => {
    await withTempDataRoot(async dataRoot => {
        const storagePath = path.join(dataRoot, '_global', 'free-gemini-channels.json');
        await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
        await fs.promises.writeFile(storagePath, JSON.stringify({
            version: 1,
            channels: [{
                id: 'old-channel',
                name: 'old',
                url: 'https://example.com',
                key: 'secret',
                enabled: true,
            }],
        }));

        const [channel] = await listAdminFreeGeminiChannels();
        assert.deepEqual({
            priority: channel.priority,
            modelPolicy: channel.modelPolicy,
            models: channel.models,
            timeoutMs: channel.timeoutMs,
            maxRetries: channel.maxRetries,
            modelCacheTtlMs: channel.modelCacheTtlMs,
            maxOutputTokens: channel.maxOutputTokens,
        }, {
            priority: 0,
            modelPolicy: 'all',
            models: [],
            timeoutMs: 30000,
            maxRetries: 1,
            modelCacheTtlMs: 300000,
            maxOutputTokens: 0,
        });
    });
});

test('model discovery uses TTL caching, single-flight, and stale-if-error without hiding admin refresh failures', async () => {
    await withTempDataRoot(async () => {
        let requests = 0;
        let failRequests = false;
        const upstream = http.createServer((_request, response) => {
            requests++;
            setTimeout(() => {
                response.setHeader('Content-Type', 'application/json');
                if (failRequests) {
                    response.statusCode = 503;
                    response.end(JSON.stringify({ error: { message: 'temporary failure' } }));
                    return;
                }
                response.end(JSON.stringify({
                    models: [{
                        name: 'models/gemini-cache',
                        supportedGenerationMethods: ['generateContent'],
                        inputTokenLimit: 1000,
                        outputTokenLimit: 200,
                    }],
                }));
            }, 20);
        });
        await new Promise((resolve, reject) => {
            upstream.once('error', reject);
            upstream.listen(0, '127.0.0.1', resolve);
        });

        try {
            const address = upstream.address();
            const channel = await createFreeGeminiChannel({
                url: `http://127.0.0.1:${address.port}`,
                key: 'secret',
                modelCacheTtlMs: 30000,
            });
            const resolved = await getEnabledFreeGeminiChannel(channel.id);
            const [first, second] = await Promise.all([
                getFreeGeminiChannelModels(resolved),
                getFreeGeminiChannelModels(resolved),
            ]);
            assert.deepEqual(first, [{ id: 'gemini-cache', inputTokenLimit: 1000, outputTokenLimit: 200 }]);
            assert.deepEqual(second, first);
            assert.equal(requests, 1);

            await getFreeGeminiChannelModels(resolved);
            assert.equal(requests, 1);
            await Promise.all([
                getFreeGeminiChannelModels(resolved, { refresh: true }),
                getFreeGeminiChannelModels(resolved, { refresh: true }),
            ]);
            assert.equal(requests, 2);

            failRequests = true;
            const adminRefresh = getFreeGeminiChannelModels(resolved, { refresh: true });
            const adminFailure = assert.rejects(adminRefresh, error => error?.status === 503);
            const ordinaryRequest = getFreeGeminiChannelModels(resolved);
            assert.deepEqual(await ordinaryRequest, first);
            await adminFailure;
            assert.equal(requests, 3);
        } finally {
            await new Promise(resolve => upstream.close(resolve));
        }
    });
});

test('legacy free Gemini storage is moved out of node-persist directory', async () => {
    await withTempDataRoot(async dataRoot => {
        const legacyDirectory = path.join(dataRoot, '_storage');
        const legacyPath = path.join(legacyDirectory, 'free-gemini-channels.json');
        const targetPath = path.join(dataRoot, '_global', 'free-gemini-channels.json');
        await fs.promises.mkdir(legacyDirectory, { recursive: true });
        await fs.promises.writeFile(legacyPath, JSON.stringify({
            version: 1,
            channels: [{
                id: 'legacy-channel',
                name: 'legacy-free-gemini',
                url: 'https://legacy.example.com',
                key: 'legacy-secret',
                enabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }],
        }), 'utf8');

        assert.equal(await migrateLegacyFreeGeminiChannels(), true);
        assert.equal(fs.existsSync(legacyPath), false);
        assert.equal(fs.existsSync(targetPath), true);
        assert.deepEqual(await listPublicFreeGeminiChannels(), [{ id: 'legacy-channel', name: 'legacy-free-gemini' }]);
    });
});

test('admin channel creation cannot fall back to browser form navigation', async () => {
    const template = await fs.promises.readFile(new URL('../public/scripts/templates/admin.html', import.meta.url), 'utf8');
    const adminScript = await fs.promises.readFile(new URL('../public/scripts/admin-extensions.js', import.meta.url), 'utf8');
    const userScript = await fs.promises.readFile(new URL('../public/scripts/user.js', import.meta.url), 'utf8');
    const channelBlock = template.match(/<!-- 全局免费 Gemini 渠道管理 -->([\s\S]*?)<!-- 旧管理员邀请码管理选项卡 -->/)?.[1] || '';

    assert.doesNotMatch(channelBlock, /<form\b/i);
    assert.match(channelBlock, /<button type="button"[^>]+id="saveFreeGeminiChannel">/);
    assert.match(adminScript, /findInScope\('#saveFreeGeminiChannel'\)[\s\S]*?\.on\('click\.freeGeminiChannels', saveFreeGeminiChannel\)/);
    assert.match(adminScript, /findInScope\('\.freeGeminiChannelsButton'\)[\s\S]*?setTimeout\(loadFreeGeminiChannelsAdmin, 0\)/);
    assert.match(adminScript, /headers: await getFreeGeminiRequestHeaders\(\)/);
    assert.match(userScript, /window\.bindFreeGeminiChannelEvents\(template\)/);
});

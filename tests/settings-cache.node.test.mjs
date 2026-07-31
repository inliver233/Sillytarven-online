import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    SettingsCache,
    clearSettingsCache,
    getSettingsCacheStatus,
    invalidateSettingsCache,
    registerSettingsCache,
    settingsCacheInvalidationMiddleware,
} from '../src/settings-cache.js';

const DIRECTORY_KEYS = [
    'koboldAI_Settings',
    'novelAI_Settings',
    'openAI_Settings',
    'textGen_Settings',
    'worlds',
    'themes',
    'movingUI',
    'quickreplies',
    'instruct',
    'context',
    'sysprompt',
    'reasoning',
];
const RUNTIME_CONFIG = {
    enable_extensions: true,
    enable_extensions_auto_update: false,
    enable_accounts: true,
};

async function withDirectories(callback, { createOptional = true } = {}) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-settings-cache-'));
    const directories = { root };
    for (const key of DIRECTORY_KEYS) {
        directories[key] = path.join(root, key);
        if (createOptional) await fs.promises.mkdir(directories[key], { recursive: true });
    }
    try {
        return await callback(directories);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

async function writeJson(directory, name, value) {
    await fs.promises.writeFile(path.join(directory, name), JSON.stringify(value));
}

test('settings cache preserves native payload shape, ordering, raw presets, and parsed null values', async () => {
    await withDirectories(async directories => {
        const settingsText = '{\n  "username": "Alice",\n  "amount_gen": 123\n}';
        await fs.promises.writeFile(path.join(directories.root, 'settings.json'), settingsText);
        await writeJson(directories.koboldAI_Settings, 'b.json', { order: 2 });
        await writeJson(directories.koboldAI_Settings, 'a.json', { order: 1 });
        await fs.promises.writeFile(path.join(directories.koboldAI_Settings, 'bad.json'), '{bad');
        await writeJson(directories.novelAI_Settings, 'novel.json', { temperature: 1 });
        await writeJson(directories.openAI_Settings, 'openai.json', { model: 'x' });
        await writeJson(directories.textGen_Settings, 'text.json', { preset: true });
        await writeJson(directories.worlds, 'Alpha.json', { entries: {} });
        await writeJson(directories.worlds, 'Beta.JSON', { entries: {} });
        await writeJson(directories.themes, 'theme.json', { name: 'theme' });
        await fs.promises.writeFile(path.join(directories.themes, 'bad.json'), 'not-json');
        await fs.promises.writeFile(path.join(directories.movingUI, 'null.json'), 'null');
        await writeJson(directories.quickreplies, 'qr.json', { name: 'qr' });
        await writeJson(directories.instruct, 'instruct.json', { name: 'instruct' });
        await writeJson(directories.context, 'context.json', { name: 'context' });
        await writeJson(directories.sysprompt, 'system.json', { name: 'system' });
        await writeJson(directories.reasoning, 'reasoning.json', { name: 'reasoning' });

        const cache = new SettingsCache({ ioConcurrency: 3, signatureTtlMs: 0, ttlMs: 60_000 });
        const metricEvents = [];
        const originalWarn = console.warn;
        console.warn = () => {};
        let first;
        try {
            first = await cache.get({
                userKey: 'alice',
                directories,
                runtimeConfig: RUNTIME_CONFIG,
                onMetric: event => metricEvents.push(event),
            });
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(first.state, 'miss');
        assert.equal(first.payload.settings, settingsText);
        assert.deepEqual(first.payload.koboldai_setting_names, ['a', 'b']);
        assert.deepEqual(first.payload.koboldai_settings.map(JSON.parse), [{ order: 1 }, { order: 2 }]);
        assert.deepEqual(first.payload.world_names, ['Alpha', 'Beta']);
        assert.deepEqual(first.payload.themes, [{ name: 'theme' }]);
        assert.deepEqual(first.payload.movingUIPresets, [null]);
        assert.deepEqual(first.payload.quickReplyPresets, [{ name: 'qr' }]);
        assert.deepEqual(first.payload.instruct, [{ name: 'instruct' }]);
        assert.deepEqual(first.payload.context, [{ name: 'context' }]);
        assert.deepEqual(first.payload.sysprompt, [{ name: 'system' }]);
        assert.deepEqual(first.payload.reasoning, [{ name: 'reasoning' }]);
        assert.equal(first.payload.enable_extensions, true);
        assert.equal(first.payload.enable_extensions_auto_update, false);
        assert.equal(first.payload.enable_accounts, true);
        assert.equal(first.metrics.directories, 13);
        assert.equal(first.metrics.invalidFiles, 2);
        assert.ok(first.metrics.filesRead >= 13);
        assert.ok(first.metrics.readBytes > settingsText.length);
        assert.ok(metricEvents.some(event => event.type === 'read'));
        assert.ok(metricEvents.some(event => event.type === 'parse'));

        const hit = await cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG });
        assert.equal(hit.state, 'hit');
        assert.deepEqual(hit.payload, first.payload);
    });
});

test('missing optional directories are empty while a missing settings file fails and can recover', async () => {
    await withDirectories(async directories => {
        const cache = new SettingsCache({ signatureTtlMs: 0 });
        await assert.rejects(() => cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG }), /settings\.json|ENOENT/);
        await fs.promises.writeFile(path.join(directories.root, 'settings.json'), '{}');
        const recovered = await cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG });
        assert.equal(recovered.state, 'miss');
        for (const key of [
            'koboldai_settings', 'koboldai_setting_names', 'world_names', 'novelai_settings',
            'novelai_setting_names', 'openai_settings', 'openai_setting_names',
            'textgenerationwebui_presets', 'textgenerationwebui_preset_names', 'themes',
            'movingUIPresets', 'quickReplyPresets', 'instruct', 'context', 'sysprompt', 'reasoning',
        ]) {
            assert.deepEqual(recovered.payload[key], []);
        }
    }, { createOptional: false });
});

test('concurrent requests single-flight per user while different users remain isolated', async () => {
    await withDirectories(async directories => {
        await fs.promises.writeFile(path.join(directories.root, 'settings.json'), JSON.stringify({ large: 'x'.repeat(1024 * 1024) }));
        await Promise.all(Array.from({ length: 60 }, (_, index) => writeJson(
            directories.openAI_Settings,
            `preset-${String(index).padStart(2, '0')}.json`,
            { index },
        )));
        const cache = new SettingsCache({ ioConcurrency: 4, signatureTtlMs: 1000, ttlMs: 60_000, maxBytes: 10 * 1024 * 1024 });
        const [first, second] = await Promise.all([
            cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG }),
            cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG }),
        ]);
        assert.deepEqual([first.state, second.state].sort(), ['miss', 'shared']);
        assert.equal(first.payload.openai_settings.length, 60);
        assert.deepEqual(second.payload, first.payload);

        const otherUser = await cache.get({ userKey: 'bob', directories, runtimeConfig: RUNTIME_CONFIG });
        assert.equal(otherUser.state, 'miss');
        assert.equal(cache.getStatus().entries, 2);
    });
});

test('file signatures and explicit invalidation refresh settings immediately', async () => {
    await withDirectories(async directories => {
        await fs.promises.writeFile(path.join(directories.root, 'settings.json'), '{"version":1}');
        await writeJson(directories.themes, 'theme.json', { version: 1 });
        const cache = new SettingsCache({ signatureTtlMs: 0, ttlMs: 60_000 });
        registerSettingsCache(cache);

        assert.equal((await cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG })).payload.themes[0].version, 1);
        assert.equal((await cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG })).state, 'hit');
        await writeJson(directories.themes, 'theme.json', { version: 200 });
        const external = await cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG });
        assert.equal(external.state, 'miss');
        assert.equal(external.payload.themes[0].version, 200);

        invalidateSettingsCache('alice');
        assert.equal((await cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG })).state, 'miss');
        assert.ok(getSettingsCacheStatus().entries >= 1);
        clearSettingsCache();
        assert.deepEqual(getSettingsCacheStatus(), { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 });
    });
});

test('settings mutation middleware invalidates successful writes but not failed requests', async () => {
    await withDirectories(async directories => {
        await fs.promises.writeFile(path.join(directories.root, 'settings.json'), '{}');
        const cache = new SettingsCache({ signatureTtlMs: 1000, ttlMs: 60_000 });
        registerSettingsCache(cache);
        const get = () => cache.get({ userKey: 'alice', directories, runtimeConfig: RUNTIME_CONFIG });
        await get();
        assert.equal((await get()).state, 'hit');

        const successfulResponse = new EventEmitter();
        successfulResponse.statusCode = 200;
        let nextCalled = false;
        settingsCacheInvalidationMiddleware({
            baseUrl: '/api/themes',
            path: '/save',
            method: 'POST',
            user: { profile: { handle: 'alice' } },
        }, successfulResponse, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        successfulResponse.emit('finish');
        assert.equal((await get()).state, 'miss');

        const failedResponse = new EventEmitter();
        failedResponse.statusCode = 500;
        settingsCacheInvalidationMiddleware({
            baseUrl: '',
            path: '/api/themes/save',
            method: 'POST',
            user: { profile: { handle: 'alice' } },
        }, failedResponse, () => {});
        failedResponse.emit('finish');
        assert.equal((await get()).state, 'hit');
    });
});

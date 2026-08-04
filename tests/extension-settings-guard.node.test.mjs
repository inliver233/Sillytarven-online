/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import {
    MAX_INLINE_EXTENSION_SETTING_BYTES,
    MAX_TOTAL_INLINE_EXTENSION_SETTINGS_BYTES,
    guardOversizedExtensionSettings,
} from '../src/extension-settings-guard.js';

const gunzipAsync = promisify(gunzip);

async function withDirectories(callback) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-extension-guard-'));
    const directories = {
        root,
        backups: path.join(root, 'backups'),
        extensionData: path.join(root, 'user', 'extension-data'),
    };
    try {
        return await callback(directories);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

test('20,000 legacy image records migrate to verified gzip while preserving an exact backup', async () => {
    await withDirectories(async directories => {
        const images = Array.from({ length: 20_000 }, (_, index) => ({
            id: index,
            thumbnail: `data:image/png;base64,${'a'.repeat(32)}`,
            prompt: `synthetic-${index}`,
        }));
        const original = JSON.stringify({
            username: 'synthetic-user',
            extension_settings: { chatu8: { images }, disabledExtensions: [] },
        });
        assert.ok(Buffer.byteLength(JSON.stringify({ images })) > MAX_INLINE_EXTENSION_SETTING_BYTES);
        await fs.promises.writeFile(path.join(directories.root, 'settings.json'), original);

        const result = await guardOversizedExtensionSettings(original, directories);
        assert.equal(result.migrated.length, 1);
        assert.equal(result.failed.length, 0);
        const compact = JSON.parse(result.settingsText);
        assert.deepEqual(compact.extension_settings.chatu8.images, []);
        assert.equal(compact.extension_settings._storageReferences.chatu8.kind, 'legacy-extension-settings');
        assert.equal(compact.extension_settings.disabledExtensions?.includes('third-party/chatu8'), false);
        assert.ok(Buffer.byteLength(result.settingsText) < MAX_INLINE_EXTENSION_SETTING_BYTES);

        const legacyDirectory = path.join(directories.extensionData, 'chatu8', 'legacy');
        const compressed = await fs.promises.readFile(path.join(legacyDirectory, 'settings.json.gz'));
        assert.deepEqual(JSON.parse((await gunzipAsync(compressed)).toString('utf8')), { images });
        const metadata = JSON.parse(await fs.promises.readFile(path.join(legacyDirectory, 'settings.meta.json'), 'utf8'));
        assert.equal(metadata.sha256, result.migrated[0].sha256);
        assert.equal(metadata.uncompressedBytes, Buffer.byteLength(JSON.stringify({ images })));

        const backups = await fs.promises.readdir(directories.backups);
        assert.equal(backups.length, 1);
        assert.equal(await fs.promises.readFile(path.join(directories.backups, backups[0]), 'utf8'), original);
        assert.equal(await fs.promises.readFile(path.join(directories.root, 'settings.json'), 'utf8'), result.settingsText);

        const repeated = await guardOversizedExtensionSettings(result.settingsText, directories);
        assert.equal(repeated.migrated.length, 0);
        assert.equal((await fs.promises.readdir(directories.backups)).length, 1);
    });
});

test('50 MiB legacy settings are removed from the startup payload without Base64 re-encoding', async () => {
    await withDirectories(async directories => {
        const legacyValue = { cache: 'x'.repeat(50 * 1024 * 1024) };
        const original = JSON.stringify({ extension_settings: { huge: legacyValue } });
        const result = await guardOversizedExtensionSettings(original, directories);
        assert.equal(result.migrated.length, 1);
        assert.ok(result.migrated[0].originalBytes >= 50 * 1024 * 1024);
        assert.ok(result.settingsText.length < 2048);
        const compact = JSON.parse(result.settingsText);
        assert.equal(compact.extension_settings.huge.cache, '');
        const reference = compact.extension_settings._storageReferences.huge;
        assert.equal(reference.format, 'gzip-json');
        assert.equal(JSON.stringify(reference).includes('base64'), false);
    });
});

test('OpenAI extension settings share the inline budget and use a separate archive slot', async () => {
    await withDirectories(async directories => {
        const standardValue = { cache: 'a'.repeat(MAX_INLINE_EXTENSION_SETTING_BYTES + 1) };
        const oaiValue = { cache: 'b'.repeat(MAX_INLINE_EXTENSION_SETTING_BYTES + 1) };
        const original = JSON.stringify({
            extension_settings: { helper: standardValue },
            oai_settings: { extensions: { helper: oaiValue } },
        });
        const result = await guardOversizedExtensionSettings(original, directories);

        assert.deepEqual(result.migrated.map(item => item.source).sort(), [
            'extension_settings',
            'oai_settings.extensions',
        ]);
        assert.equal(result.failed.length, 0);
        const compact = JSON.parse(result.settingsText);
        assert.equal(compact.extension_settings.helper.cache, '');
        assert.equal(compact.oai_settings.extensions.helper.cache, '');
        assert.equal(
            compact.oai_settings.extensions._storageReferences.helper.source,
            'oai_settings.extensions',
        );

        const legacyDirectory = path.join(directories.extensionData, 'helper', 'legacy');
        const standardArchive = await gunzipAsync(await fs.promises.readFile(path.join(legacyDirectory, 'settings.json.gz')));
        const oaiArchive = await gunzipAsync(await fs.promises.readFile(path.join(legacyDirectory, 'oai-settings.json.gz')));
        assert.deepEqual(JSON.parse(standardArchive.toString('utf8')), standardValue);
        assert.deepEqual(JSON.parse(oaiArchive.toString('utf8')), oaiValue);
    });
});

test('dry-run reports migration but writes no extension data, backup, or settings', async () => {
    await withDirectories(async directories => {
        const original = JSON.stringify({
            extension_settings: { large: { value: 'x'.repeat(MAX_INLINE_EXTENSION_SETTING_BYTES + 1) } },
        });
        const result = await guardOversizedExtensionSettings(original, directories, { dryRun: true });
        assert.equal(result.migrated.length, 1);
        assert.equal(fs.existsSync(directories.extensionData), false);
        assert.equal(fs.existsSync(directories.backups), false);
        assert.equal(fs.existsSync(path.join(directories.root, 'settings.json')), false);
    });
});

test('aggregate extension settings cannot bypass the total inline budget', async () => {
    await withDirectories(async directories => {
        const extensionSettings = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
            `extension-${index}`,
            { value: 'x'.repeat(400 * 1024) },
        ]));
        const result = await guardOversizedExtensionSettings(JSON.stringify({
            extension_settings: extensionSettings,
        }), directories);
        assert.ok(result.migrated.length >= 1);
        const compact = JSON.parse(result.settingsText).extension_settings;
        const remainingBytes = Object.entries(compact)
            .filter(([key]) => key.startsWith('extension-'))
            .filter(([, value]) => !value.$storage)
            .reduce((total, [, value]) => total + Buffer.byteLength(JSON.stringify(value)), 0);
        assert.ok(remainingBytes <= MAX_TOTAL_INLINE_EXTENSION_SETTINGS_BYTES);
        assert.equal(compact.disabledExtensions, undefined);
    });
});

test('a corrupt migration blob is rebuilt before its reference is reused', async () => {
    await withDirectories(async directories => {
        const value = { cache: 'x'.repeat(MAX_INLINE_EXTENSION_SETTING_BYTES + 1) };
        const original = JSON.stringify({ extension_settings: { chatu8: value } });
        await guardOversizedExtensionSettings(original, directories);
        const dataPath = path.join(directories.extensionData, 'chatu8', 'legacy', 'settings.json.gz');
        await fs.promises.writeFile(dataPath, Buffer.from('truncated'));

        const repaired = await guardOversizedExtensionSettings(original, directories);
        assert.equal(repaired.failed.length, 0);
        const restored = await gunzipAsync(await fs.promises.readFile(dataPath));
        assert.deepEqual(JSON.parse(restored.toString('utf8')), value);
    });
});

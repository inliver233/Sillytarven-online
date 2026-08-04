import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
    applyExtensionSettingsRehydration,
    planExtensionSettingsRehydration,
    summarizeRehydrationPlan,
} from '../tools/rehydrate-extension-settings.mjs';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function createStoredValue({ dataRoot, user, key, storageId, source, suffix, value }) {
    const serialized = Buffer.from(JSON.stringify(value), 'utf8');
    const digest = sha256(serialized);
    const legacyDirectory = path.join(dataRoot, user, 'user', 'extension-data', storageId, 'legacy');
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, `${suffix}.json.gz`), gzipSync(serialized));
    fs.writeFileSync(path.join(legacyDirectory, `${suffix}.meta.json`), JSON.stringify({
        schemaVersion: 1,
        format: 'gzip-json',
        originalExtensionId: key,
        sha256: digest,
        uncompressedBytes: serialized.byteLength,
        compressedBytes: gzipSync(serialized).byteLength,
        migratedAt: new Date(0).toISOString(),
    }));
    return {
        schemaVersion: 1,
        kind: 'legacy-extension-settings',
        source,
        extensionId: storageId,
        format: 'gzip-json',
        sha256: digest,
        uncompressedBytes: serialized.byteLength,
    };
}

test('rehydrates both legacy settings slots with verified backups', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-rehydrate-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const dataRoot = path.join(temporaryRoot, 'data');
    const backupRoot = path.join(temporaryRoot, 'backup');
    const user = 'fixture-user';
    const settingsPath = path.join(dataRoot, user, 'settings.json');
    const extensionValue = { scripts: [{ name: 'kept', content: 'x'.repeat(2048) }] };
    const oaiValue = { variables: { score: 42 }, enabled: true };
    const extensionReference = createStoredValue({
        dataRoot,
        user,
        key: 'tavern_helper',
        storageId: 'tavern_helper',
        source: 'extension_settings',
        suffix: 'settings',
        value: extensionValue,
    });
    const oaiReference = createStoredValue({
        dataRoot,
        user,
        key: 'tavern_helper',
        storageId: 'tavern_helper',
        source: 'oai_settings.extensions',
        suffix: 'oai-settings',
        value: oaiValue,
    });
    const originalSettings = JSON.stringify({
        extension_settings: {
            tavern_helper: {},
            _storageReferences: { tavern_helper: extensionReference },
        },
        oai_settings: {
            extensions: {
                tavern_helper: {},
                _storageReferences: { tavern_helper: oaiReference },
            },
        },
    }, null, 4);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, originalSettings);

    const plan = await planExtensionSettingsRehydration({ dataRoot });
    assert.deepEqual(summarizeRehydrationPlan(plan), {
        dataRoot,
        users: 1,
        references: 2,
        restoredValueBytes: Buffer.byteLength(JSON.stringify(extensionValue)) + Buffer.byteLength(JSON.stringify(oaiValue)),
        settingsBytesBefore: Buffer.byteLength(originalSettings),
        settingsBytesAfter: plan.files[0].replacement.byteLength,
    });
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings, 'planning must not mutate settings');

    const result = await applyExtensionSettingsRehydration(plan, { backupRoot });
    assert.equal(result.references, 2);
    const restoredSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(restoredSettings.extension_settings.tavern_helper, extensionValue);
    assert.deepEqual(restoredSettings.oai_settings.extensions.tavern_helper, oaiValue);
    assert.equal(restoredSettings.extension_settings._storageReferences, undefined);
    assert.equal(restoredSettings.oai_settings.extensions._storageReferences, undefined);
    assert.equal(fs.readFileSync(path.join(backupRoot, user, 'settings.json'), 'utf8'), originalSettings);
    assert.equal(JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).status, 'complete');
    assert.equal((await planExtensionSettingsRehydration({ dataRoot })).files.length, 0);
});

test('rejects corrupt stored data before changing any settings file', async t => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-rehydrate-corrupt-'));
    t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    const dataRoot = path.join(temporaryRoot, 'data');
    const user = 'fixture-user';
    const settingsPath = path.join(dataRoot, user, 'settings.json');
    const reference = createStoredValue({
        dataRoot,
        user,
        key: 'tavern_helper',
        storageId: 'tavern_helper',
        source: 'extension_settings',
        suffix: 'settings',
        value: { important: 'preserve me' },
    });
    const gzipPath = path.join(dataRoot, user, 'user', 'extension-data', 'tavern_helper', 'legacy', 'settings.json.gz');
    const corruptGzip = fs.readFileSync(gzipPath);
    corruptGzip[Math.floor(corruptGzip.length / 2)] ^= 0xff;
    fs.writeFileSync(gzipPath, corruptGzip);
    const originalSettings = JSON.stringify({
        extension_settings: {
            tavern_helper: {},
            _storageReferences: { tavern_helper: reference },
        },
    }, null, 4);
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, originalSettings);

    await assert.rejects(
        planExtensionSettingsRehydration({ dataRoot }),
        /gzip data is invalid|SHA-256 digest does not match|uncompressed size does not match/u,
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings);
});

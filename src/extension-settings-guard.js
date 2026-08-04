import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import writeFileAtomic from 'write-file-atomic';

import { SETTINGS_FILE } from './constants.js';
import { MAX_EXTENSION_STORAGE_QUOTA_BYTES, validateExtensionStorageId } from './extension-storage.js';
import { KeyedMutex } from './keyed-mutex.js';

export const MAX_INLINE_EXTENSION_SETTING_BYTES = 512 * 1024;
export const MAX_TOTAL_INLINE_EXTENSION_SETTINGS_BYTES = 2 * 1024 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const migrationMutex = new KeyedMutex();
const MAX_COMPATIBILITY_SETTING_BYTES = 128 * 1024;
const RESERVED_EXTENSION_SETTINGS = new Set([
    'apiUrl',
    'apiKey',
    'autoConnect',
    'notifyUpdates',
    'disabledExtensions',
    '_storageReferences',
]);

function byteLength(value) {
    return Buffer.byteLength(value, 'utf8');
}

function toStorageId(extensionId) {
    try {
        return validateExtensionStorageId(extensionId);
    } catch {
        const hash = crypto.createHash('sha256').update(String(extensionId)).digest('hex').slice(0, 32);
        return `legacy-${hash}`;
    }
}

async function fileSize(filePath) {
    try {
        return (await fs.promises.stat(filePath)).size;
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }
}

async function directorySize(directory) {
    let entries;
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }
    const sizes = await Promise.all(entries.map(async entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return await directorySize(entryPath);
        return entry.isFile() ? await fileSize(entryPath) : 0;
    }));
    return sizes.reduce((total, size) => total + size, 0);
}

async function persistLegacySetting(extensionDataRoot, extensionId, serializedValue, { dryRun, slot = 'settings' }) {
    if (!['settings', 'oai-settings'].includes(slot)) {
        throw new TypeError('Unsupported extension settings migration slot');
    }
    const storageId = toStorageId(extensionId);
    const digest = crypto.createHash('sha256').update(serializedValue).digest('hex');
    const extensionDirectory = path.join(extensionDataRoot, storageId);
    const legacyDirectory = path.join(extensionDirectory, 'legacy');
    const dataPath = path.join(legacyDirectory, `${slot}.json.gz`);
    const metadataPath = path.join(legacyDirectory, `${slot}.meta.json`);
    let existingMetadata = null;
    try {
        existingMetadata = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'));
    } catch {
        // A missing or invalid migration manifest is replaced only after data is durable.
    }

    if (existingMetadata?.sha256 === digest && await fileSize(dataPath) > 0) {
        try {
            const restored = await gunzipAsync(await fs.promises.readFile(dataPath));
            const restoredDigest = crypto.createHash('sha256').update(restored).digest('hex');
            if (restoredDigest === digest && restored.byteLength === existingMetadata.uncompressedBytes) {
                return { storageId, ...existingMetadata };
            }
        } catch {
            // Rebuild a corrupt or truncated migration before publishing its reference.
        }
    }

    const compressed = await gzipAsync(Buffer.from(serializedValue, 'utf8'), { level: 6 });
    const metadata = {
        schemaVersion: 1,
        format: 'gzip-json',
        originalExtensionId: String(extensionId),
        sha256: digest,
        uncompressedBytes: byteLength(serializedValue),
        compressedBytes: compressed.byteLength,
        migratedAt: new Date().toISOString(),
    };
    if (dryRun) return { storageId, ...metadata };

    const currentBytes = await directorySize(extensionDirectory);
    const replacedBytes = await fileSize(dataPath) + await fileSize(metadataPath);
    const nextBytes = compressed.byteLength + byteLength(JSON.stringify(metadata));
    if (currentBytes - replacedBytes + nextBytes > MAX_EXTENSION_STORAGE_QUOTA_BYTES) {
        const error = new Error('The extension storage quota has been exceeded.');
        error.code = 'quota_exceeded';
        throw error;
    }
    await fs.promises.mkdir(legacyDirectory, { recursive: true });
    await writeFileAtomic(dataPath, compressed);
    await writeFileAtomic(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    return { storageId, ...metadata };
}

function createReference(migration, source) {
    return {
        schemaVersion: 1,
        kind: 'legacy-extension-settings',
        source,
        extensionId: migration.storageId,
        format: migration.format,
        sha256: migration.sha256,
        uncompressedBytes: migration.uncompressedBytes,
    };
}

function emptyCompatibleValue(value) {
    if (Array.isArray(value)) return [];
    if (typeof value === 'string') return '';
    if (value && typeof value === 'object') return {};
    return value;
}

function createCompatibilityProjection(value, maxBytes = MAX_COMPATIBILITY_SETTING_BYTES, depth = 0) {
    const serialized = JSON.stringify(value);
    if (byteLength(serialized) <= maxBytes) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 4) {
        return emptyCompatibleValue(value);
    }

    const entries = Object.entries(value);
    if (entries.length > 100) return {};
    const result = {};
    let remaining = Math.max(0, maxBytes - 2);
    const ordered = entries
        .map(([key, child]) => ({ key, child, bytes: byteLength(JSON.stringify(child)) }))
        .sort((left, right) => left.bytes - right.bytes);
    for (const { key, child } of ordered) {
        const keyBytes = byteLength(JSON.stringify(key)) + 2;
        if (remaining <= keyBytes) continue;
        const projected = createCompatibilityProjection(child, remaining - keyBytes, depth + 1);
        const projectedBytes = byteLength(JSON.stringify(projected)) + keyBytes;
        if (projectedBytes > remaining) continue;
        result[key] = projected;
        remaining -= projectedBytes;
    }
    return result;
}

/**
 * Moves oversized extension settings out of the startup payload.
 * Migration blobs are committed before the compact settings file, so a crash
 * can leave only harmless orphan data and never a dangling durable reference.
 * @param {string} settingsText Serialized settings JSON
 * @param {object} directories Trusted user directories
 * @param {{dryRun?: boolean, updateSettingsFile?: boolean, backupFilePrefix?: string}} [options] Migration options
 */
export async function guardOversizedExtensionSettings(settingsText, directories, {
    dryRun = false,
    updateSettingsFile = true,
    backupFilePrefix = 'settings_pre_extension_migration_',
} = {}) {
    if (typeof settingsText !== 'string') throw new TypeError('settingsText must be a string');
    const settings = JSON.parse(settingsText);
    const extensionSettings = settings?.extension_settings;
    const oaiSettings = settings?.oai_settings;
    const oaiExtensionSettings = oaiSettings?.extensions;
    const hasExtensionSettings = extensionSettings && typeof extensionSettings === 'object' && !Array.isArray(extensionSettings);
    const hasOaiExtensionSettings = oaiExtensionSettings && typeof oaiExtensionSettings === 'object' && !Array.isArray(oaiExtensionSettings);
    const emptyResult = {
        settingsText,
        settingsObject: settings,
        migrated: [],
        failed: [],
        replacements: {},
        oaiReplacements: {},
    };
    if (!hasExtensionSettings && !hasOaiExtensionSettings) return emptyResult;

    const candidates = [
        ...(hasExtensionSettings ? Object.entries(extensionSettings)
            .filter(([extensionId]) => !RESERVED_EXTENSION_SETTINGS.has(extensionId))
            .map(([extensionId, value]) => ({
                source: 'extension_settings',
                slot: 'settings',
                extensionId,
                value,
                bytes: byteLength(JSON.stringify(value)),
            })) : []),
        ...(hasOaiExtensionSettings ? Object.entries(oaiExtensionSettings)
            .filter(([extensionId]) => extensionId !== '_storageReferences')
            .map(([extensionId, value]) => ({
                source: 'oai_settings.extensions',
                slot: 'oai-settings',
                extensionId,
                value,
                bytes: byteLength(JSON.stringify(value)),
            })) : []),
    ];
    const selected = new Set(candidates
        .filter(item => item.bytes > MAX_INLINE_EXTENSION_SETTING_BYTES)
        .map(item => `${item.source}:${item.extensionId}`));
    let remainingInlineBytes = candidates
        .filter(item => !selected.has(`${item.source}:${item.extensionId}`))
        .reduce((total, item) => total + item.bytes, 0);
    for (const item of [...candidates].sort((left, right) => right.bytes - left.bytes)) {
        if (remainingInlineBytes <= MAX_TOTAL_INLINE_EXTENSION_SETTINGS_BYTES) break;
        const candidateKey = `${item.source}:${item.extensionId}`;
        if (selected.has(candidateKey)) continue;
        selected.add(candidateKey);
        remainingInlineBytes -= item.bytes;
    }
    if (selected.size === 0) return emptyResult;

    return await migrationMutex.runExclusive(String(directories.root), async () => {
        const compactSettings = { ...settings };
        const compactExtensionSettings = hasExtensionSettings ? { ...extensionSettings } : null;
        const compactOaiExtensionSettings = hasOaiExtensionSettings ? { ...oaiExtensionSettings } : null;
        if (compactExtensionSettings) compactSettings.extension_settings = compactExtensionSettings;
        if (compactOaiExtensionSettings) {
            compactSettings.oai_settings = { ...oaiSettings, extensions: compactOaiExtensionSettings };
        }
        const migrated = [];
        const failed = [];
        const replacements = {};
        const oaiReplacements = {};
        const extensionStorageReferences = {
            ...(compactExtensionSettings?._storageReferences
                && typeof compactExtensionSettings._storageReferences === 'object'
                && !Array.isArray(compactExtensionSettings._storageReferences)
                ? compactExtensionSettings._storageReferences
                : {}),
        };
        const oaiStorageReferences = {
            ...(compactOaiExtensionSettings?._storageReferences
                && typeof compactOaiExtensionSettings._storageReferences === 'object'
                && !Array.isArray(compactOaiExtensionSettings._storageReferences)
                ? compactOaiExtensionSettings._storageReferences
                : {}),
        };

        for (const { source, slot, extensionId, value } of candidates) {
            if (!selected.has(`${source}:${extensionId}`)) continue;
            const serializedValue = JSON.stringify(value);
            const target = source === 'extension_settings' ? compactExtensionSettings : compactOaiExtensionSettings;
            const targetReplacements = source === 'extension_settings' ? replacements : oaiReplacements;
            const targetReferences = source === 'extension_settings' ? extensionStorageReferences : oaiStorageReferences;

            try {
                const migration = await persistLegacySetting(
                    directories.extensionData,
                    extensionId,
                    serializedValue,
                    { dryRun, slot },
                );
                const projection = createCompatibilityProjection(value);
                target[extensionId] = projection;
                targetReplacements[extensionId] = projection;
                targetReferences[extensionId] = createReference(migration, source);
                migrated.push({
                    source,
                    extensionId,
                    storageId: migration.storageId,
                    sha256: migration.sha256,
                    originalBytes: migration.uncompressedBytes,
                    compressedBytes: migration.compressedBytes,
                });
            } catch (error) {
                target[extensionId] = createCompatibilityProjection(value);
                failed.push({ source, extensionId, code: error?.code || 'migration_failed' });
                console.error('Oversized extension settings migration failed', {
                    source,
                    extensionId,
                    code: error?.code || 'UNKNOWN',
                });
            }
        }

        if (!migrated.length && !failed.length) {
            return { settingsText, settingsObject: settings, migrated, failed, replacements, oaiReplacements };
        }
        if (migrated.some(item => item.source === 'extension_settings')) {
            compactExtensionSettings._storageReferences = extensionStorageReferences;
            replacements._storageReferences = extensionStorageReferences;
        }
        if (migrated.some(item => item.source === 'oai_settings.extensions')) {
            compactOaiExtensionSettings._storageReferences = oaiStorageReferences;
            oaiReplacements._storageReferences = oaiStorageReferences;
        }
        const compactText = JSON.stringify(compactSettings, null, 4);

        if (updateSettingsFile && !dryRun && failed.length === 0) {
            const backupDirectory = directories.backups ?? path.join(directories.root, 'backups');
            await fs.promises.mkdir(backupDirectory, { recursive: true });
            const backupName = `${backupFilePrefix}${Date.now()}.json`;
            await writeFileAtomic(path.join(backupDirectory, backupName), settingsText, 'utf8');
            await writeFileAtomic(path.join(directories.root, SETTINGS_FILE), compactText, 'utf8');
        }

        return {
            settingsText: compactText,
            settingsObject: compactSettings,
            migrated,
            failed,
            replacements,
            oaiReplacements,
        };
    });
}

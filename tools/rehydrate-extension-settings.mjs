#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const gunzipAsync = promisify(gunzip);
const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RESTORED_VALUE_BYTES = 64 * 1024 * 1024;
const REFERENCE_KIND = 'legacy-extension-settings';
const REFERENCE_FORMAT = 'gzip-json';

const SLOTS = Object.freeze([
    {
        source: 'extension_settings',
        suffix: 'settings',
        getTarget: settings => settings?.extension_settings,
    },
    {
        source: 'oai_settings.extensions',
        suffix: 'oai-settings',
        getTarget: settings => settings?.oai_settings?.extensions,
    },
]);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function formatReferenceError(user, source, key, message) {
    return new Error(`Invalid extension storage reference for ${user}/${source}/${key}: ${message}`);
}

async function readStoredValue({ dataRoot, user, source, suffix, key, reference }) {
    if (!isPlainObject(reference)) {
        throw formatReferenceError(user, source, key, 'reference must be an object');
    }
    const isOriginalSettingsReference = source === 'extension_settings' && reference.source === undefined;
    if (reference.schemaVersion !== 1
        || reference.kind !== REFERENCE_KIND
        || (reference.source !== source && !isOriginalSettingsReference)
        || reference.format !== REFERENCE_FORMAT) {
        throw formatReferenceError(user, source, key, 'unsupported reference metadata');
    }
    if (typeof reference.extensionId !== 'string' || !STORAGE_ID_PATTERN.test(reference.extensionId)) {
        throw formatReferenceError(user, source, key, 'invalid storage ID');
    }
    if (typeof reference.sha256 !== 'string' || !SHA256_PATTERN.test(reference.sha256)) {
        throw formatReferenceError(user, source, key, 'invalid SHA-256 digest');
    }
    if (!Number.isSafeInteger(reference.uncompressedBytes)
        || reference.uncompressedBytes < 0
        || reference.uncompressedBytes > MAX_RESTORED_VALUE_BYTES) {
        throw formatReferenceError(user, source, key, 'invalid uncompressed size');
    }

    const extensionDataRoot = path.resolve(dataRoot, user, 'user', 'extension-data');
    const legacyRoot = path.resolve(extensionDataRoot, reference.extensionId, 'legacy');
    if (!legacyRoot.startsWith(`${extensionDataRoot}${path.sep}`)) {
        throw formatReferenceError(user, source, key, 'storage path escapes the user data root');
    }
    const dataPath = path.join(legacyRoot, `${suffix}.json.gz`);
    const metadataPath = path.join(legacyRoot, `${suffix}.meta.json`);

    let compressed;
    let metadata;
    try {
        [compressed, metadata] = await Promise.all([
            fs.promises.readFile(dataPath),
            fs.promises.readFile(metadataPath, 'utf8').then(JSON.parse),
        ]);
    } catch (error) {
        throw formatReferenceError(user, source, key, `stored data is unavailable (${error?.code || error?.name || 'read_failed'})`);
    }
    if (!isPlainObject(metadata)
        || metadata.schemaVersion !== 1
        || metadata.format !== REFERENCE_FORMAT
        || metadata.originalExtensionId !== key
        || metadata.sha256 !== reference.sha256
        || metadata.uncompressedBytes !== reference.uncompressedBytes) {
        throw formatReferenceError(user, source, key, 'stored metadata does not match the active reference');
    }

    let restored;
    try {
        restored = await gunzipAsync(compressed, { maxOutputLength: MAX_RESTORED_VALUE_BYTES + 1 });
    } catch (error) {
        throw formatReferenceError(user, source, key, `gzip data is invalid (${error?.code || error?.name || 'decompression_failed'})`);
    }
    if (restored.byteLength !== reference.uncompressedBytes) {
        throw formatReferenceError(user, source, key, 'uncompressed size does not match');
    }
    if (sha256(restored) !== reference.sha256) {
        throw formatReferenceError(user, source, key, 'SHA-256 digest does not match');
    }

    let value;
    try {
        value = JSON.parse(restored.toString('utf8'));
    } catch {
        throw formatReferenceError(user, source, key, 'stored value is not valid JSON');
    }
    return {
        value,
        restoredBytes: restored.byteLength,
        storageId: reference.extensionId,
        sha256: reference.sha256,
    };
}

async function listSettingsFiles(dataRoot) {
    const entries = await fs.promises.readdir(dataRoot, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const settingsPath = path.join(dataRoot, entry.name, 'settings.json');
        try {
            const stat = await fs.promises.stat(settingsPath);
            if (stat.isFile()) files.push({ user: entry.name, settingsPath, mode: stat.mode & 0o777 });
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return files.sort((left, right) => left.user.localeCompare(right.user));
}

/**
 * Validates every active reference and builds all replacement files without writing data.
 * The all-or-nothing validation prevents a corrupt reference from causing a partial migration.
 */
export async function planExtensionSettingsRehydration({ dataRoot }) {
    const resolvedDataRoot = path.resolve(dataRoot);
    const settingsFiles = await listSettingsFiles(resolvedDataRoot);
    const files = [];

    for (const item of settingsFiles) {
        const original = await fs.promises.readFile(item.settingsPath);
        let settings;
        try {
            settings = JSON.parse(original.toString('utf8'));
        } catch {
            throw new Error(`Settings file is not valid JSON: ${item.settingsPath}`);
        }

        const restoredReferences = [];
        for (const slot of SLOTS) {
            const target = slot.getTarget(settings);
            if (!isPlainObject(target) || target._storageReferences === undefined) continue;
            if (!isPlainObject(target._storageReferences)) {
                throw formatReferenceError(item.user, slot.source, '_storageReferences', 'reference map must be an object');
            }

            for (const [key, reference] of Object.entries(target._storageReferences)) {
                const restored = await readStoredValue({
                    dataRoot: resolvedDataRoot,
                    user: item.user,
                    source: slot.source,
                    suffix: slot.suffix,
                    key,
                    reference,
                });
                target[key] = restored.value;
                delete target._storageReferences[key];
                restoredReferences.push({
                    source: slot.source,
                    extensionId: key,
                    storageId: restored.storageId,
                    sha256: restored.sha256,
                    restoredBytes: restored.restoredBytes,
                });
            }
            if (Object.keys(target._storageReferences).length === 0) {
                delete target._storageReferences;
            }
        }

        if (restoredReferences.length === 0) continue;
        const replacement = Buffer.from(JSON.stringify(settings, null, 4), 'utf8');
        files.push({
            ...item,
            original,
            replacement,
            originalSha256: sha256(original),
            replacementSha256: sha256(replacement),
            restoredReferences,
        });
    }

    return { dataRoot: resolvedDataRoot, files };
}

export function summarizeRehydrationPlan(plan) {
    return {
        dataRoot: plan.dataRoot,
        users: plan.files.length,
        references: plan.files.reduce((total, item) => total + item.restoredReferences.length, 0),
        restoredValueBytes: plan.files.reduce((total, item) => total
            + item.restoredReferences.reduce((subtotal, reference) => subtotal + reference.restoredBytes, 0), 0),
        settingsBytesBefore: plan.files.reduce((total, item) => total + item.original.byteLength, 0),
        settingsBytesAfter: plan.files.reduce((total, item) => total + item.replacement.byteLength, 0),
    };
}

async function fsyncDirectory(directory) {
    let handle;
    try {
        handle = await fs.promises.open(directory, 'r');
        await handle.sync();
    } finally {
        await handle?.close();
    }
}

async function atomicWrite(filePath, contents, mode) {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
        handle = await fs.promises.open(temporaryPath, 'wx', mode);
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporaryPath, filePath);
        await fsyncDirectory(directory);
    } catch (error) {
        await handle?.close().catch(() => {});
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
    }
}

/** Applies a previously validated plan, keeping exact originals and rolling back write failures. */
export async function applyExtensionSettingsRehydration(plan, { backupRoot }) {
    if (!backupRoot) throw new TypeError('backupRoot is required when applying the migration');
    const resolvedBackupRoot = path.resolve(backupRoot);
    await fs.promises.mkdir(resolvedBackupRoot, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(resolvedBackupRoot, 'rehydration-manifest.json');
    try {
        await fs.promises.access(manifestPath);
        throw new Error(`Backup manifest already exists: ${manifestPath}`);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    for (const item of plan.files) {
        const current = await fs.promises.readFile(item.settingsPath);
        if (sha256(current) !== item.originalSha256) {
            throw new Error(`Settings changed after validation: ${item.settingsPath}`);
        }
        const backupPath = path.join(resolvedBackupRoot, item.user, 'settings.json');
        await fs.promises.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(backupPath, item.original, { flag: 'wx', mode: 0o600 });
        if (sha256(await fs.promises.readFile(backupPath)) !== item.originalSha256) {
            throw new Error(`Backup verification failed: ${backupPath}`);
        }
    }

    const summary = summarizeRehydrationPlan(plan);
    const manifest = {
        schemaVersion: 1,
        status: 'prepared',
        createdAt: new Date().toISOString(),
        ...summary,
        files: plan.files.map(item => ({
            user: item.user,
            settingsPath: path.relative(plan.dataRoot, item.settingsPath),
            originalSha256: item.originalSha256,
            replacementSha256: item.replacementSha256,
            references: item.restoredReferences,
        })),
    };
    await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 0o600);

    const written = [];
    try {
        for (const item of plan.files) {
            const current = await fs.promises.readFile(item.settingsPath);
            if (sha256(current) !== item.originalSha256) {
                throw new Error(`Settings changed during migration: ${item.settingsPath}`);
            }
            await atomicWrite(item.settingsPath, item.replacement, item.mode || 0o600);
            const persisted = await fs.promises.readFile(item.settingsPath);
            if (sha256(persisted) !== item.replacementSha256) {
                throw new Error(`Migrated settings verification failed: ${item.settingsPath}`);
            }
            JSON.parse(persisted.toString('utf8'));
            written.push(item);
        }
    } catch (error) {
        const rollbackErrors = [];
        for (const item of written.reverse()) {
            try {
                await atomicWrite(item.settingsPath, item.original, item.mode || 0o600);
            } catch (rollbackError) {
                rollbackErrors.push(`${item.settingsPath}: ${rollbackError.message}`);
            }
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors.map(message => new Error(message))], 'Migration failed and rollback was incomplete');
        }
        throw error;
    }

    manifest.status = 'complete';
    manifest.completedAt = new Date().toISOString();
    await atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 0o600);
    return { ...summary, backupRoot: resolvedBackupRoot, manifestPath };
}

function parseArguments(argv) {
    const result = { apply: false, dataRoot: null, backupRoot: null };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--apply') {
            result.apply = true;
        } else if (argument === '--dry-run') {
            result.apply = false;
        } else if (argument === '--data-root') {
            result.dataRoot = argv[++index];
        } else if (argument === '--backup-root') {
            result.backupRoot = argv[++index];
        } else if (argument === '--help') {
            result.help = true;
        } else {
            throw new TypeError(`Unknown argument: ${argument}`);
        }
    }
    return result;
}

async function main() {
    const arguments_ = parseArguments(process.argv.slice(2));
    if (arguments_.help) {
        console.log('Usage: node tools/rehydrate-extension-settings.mjs --data-root <path> [--dry-run | --apply --backup-root <path>]');
        return;
    }
    if (!arguments_.dataRoot) throw new TypeError('--data-root is required');
    if (arguments_.apply && !arguments_.backupRoot) throw new TypeError('--backup-root is required with --apply');

    const plan = await planExtensionSettingsRehydration({ dataRoot: arguments_.dataRoot });
    const result = arguments_.apply
        ? await applyExtensionSettingsRehydration(plan, { backupRoot: arguments_.backupRoot })
        : { mode: 'dry-run', ...summarizeRehydrationPlan(plan) };
    console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch(error => {
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}

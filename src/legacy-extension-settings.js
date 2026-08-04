import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

export class LegacyExtensionSettingsReferenceError extends Error {
    constructor(context, source, key, message) {
        super(`Invalid extension storage reference for ${context}/${source}/${key}: ${message}`);
        this.name = 'LegacyExtensionSettingsReferenceError';
        this.code = 'legacy_extension_reference_invalid';
    }
}

function referenceError(context, source, key, message) {
    return new LegacyExtensionSettingsReferenceError(context, source, key, message);
}

function validateReference(reference, { context, source, key }) {
    if (!isPlainObject(reference)) {
        throw referenceError(context, source, key, 'reference must be an object');
    }
    const isOriginalSettingsReference = source === 'extension_settings' && reference.source === undefined;
    if (reference.schemaVersion !== 1
        || reference.kind !== REFERENCE_KIND
        || (reference.source !== source && !isOriginalSettingsReference)
        || reference.format !== REFERENCE_FORMAT) {
        throw referenceError(context, source, key, 'unsupported reference metadata');
    }
    if (typeof reference.extensionId !== 'string' || !STORAGE_ID_PATTERN.test(reference.extensionId)) {
        throw referenceError(context, source, key, 'invalid storage ID');
    }
    if (typeof reference.sha256 !== 'string' || !SHA256_PATTERN.test(reference.sha256)) {
        throw referenceError(context, source, key, 'invalid SHA-256 digest');
    }
    if (!Number.isSafeInteger(reference.uncompressedBytes)
        || reference.uncompressedBytes < 0
        || reference.uncompressedBytes > MAX_RESTORED_VALUE_BYTES) {
        throw referenceError(context, source, key, 'invalid uncompressed size');
    }
    return reference;
}

async function readStoredValue({ extensionDataRoot, context, source, suffix, key, reference }) {
    const legacyRoot = path.resolve(extensionDataRoot, reference.extensionId, 'legacy');
    if (!legacyRoot.startsWith(`${extensionDataRoot}${path.sep}`)) {
        throw referenceError(context, source, key, 'storage path escapes the user data root');
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
        throw referenceError(context, source, key, `stored data is unavailable (${error?.code || error?.name || 'read_failed'})`);
    }
    if (!isPlainObject(metadata)
        || metadata.schemaVersion !== 1
        || metadata.format !== REFERENCE_FORMAT
        || metadata.originalExtensionId !== key
        || metadata.sha256 !== reference.sha256
        || metadata.uncompressedBytes !== reference.uncompressedBytes) {
        throw referenceError(context, source, key, 'stored metadata does not match the active reference');
    }

    let restored;
    try {
        restored = await gunzipAsync(compressed, { maxOutputLength: MAX_RESTORED_VALUE_BYTES + 1 });
    } catch (error) {
        throw referenceError(context, source, key, `gzip data is invalid (${error?.code || error?.name || 'decompression_failed'})`);
    }
    if (restored.byteLength !== reference.uncompressedBytes) {
        throw referenceError(context, source, key, 'uncompressed size does not match');
    }
    if (sha256(restored) !== reference.sha256) {
        throw referenceError(context, source, key, 'SHA-256 digest does not match');
    }

    try {
        return { value: JSON.parse(restored.toString('utf8')), restoredBytes: restored.byteLength };
    } catch {
        throw referenceError(context, source, key, 'stored value is not valid JSON');
    }
}

export function hasLegacyExtensionSettingsReferences(settings) {
    return SLOTS.some(slot => isPlainObject(slot.getTarget(settings))
        && Object.hasOwn(slot.getTarget(settings), '_storageReferences'));
}

/**
 * Replaces references emitted by the retired oversized-settings implementation.
 * A current inline value wins over a stale browser projection; otherwise the
 * validated migration blob is restored.
 */
export async function restoreLegacyExtensionSettingsReferences(settings, {
    currentSettings = null,
    extensionDataRoot,
    context = 'unknown-user',
} = {}) {
    if (!isPlainObject(settings)) {
        return { settings, restored: [] };
    }
    if (typeof extensionDataRoot !== 'string' || !extensionDataRoot) {
        throw new TypeError('extensionDataRoot is required');
    }
    const resolvedExtensionDataRoot = path.resolve(extensionDataRoot);
    const restored = [];

    for (const slot of SLOTS) {
        const target = slot.getTarget(settings);
        if (!isPlainObject(target) || !Object.hasOwn(target, '_storageReferences')) continue;
        if (!isPlainObject(target._storageReferences)) {
            throw referenceError(context, slot.source, '_storageReferences', 'reference map must be an object');
        }

        const currentTarget = slot.getTarget(currentSettings);
        const currentReferences = isPlainObject(currentTarget?._storageReferences)
            ? currentTarget._storageReferences
            : null;

        for (const [key, unvalidatedReference] of Object.entries(target._storageReferences)) {
            const reference = validateReference(unvalidatedReference, { context, source: slot.source, key });
            const hasCurrentInlineValue = isPlainObject(currentTarget)
                && Object.hasOwn(currentTarget, key)
                && !Object.hasOwn(currentReferences ?? {}, key);
            let value;
            let restoredBytes;
            let resolution;

            if (hasCurrentInlineValue) {
                value = currentTarget[key];
                restoredBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
                resolution = 'current-settings';
            } else {
                const stored = await readStoredValue({
                    extensionDataRoot: resolvedExtensionDataRoot,
                    context,
                    source: slot.source,
                    suffix: slot.suffix,
                    key,
                    reference,
                });
                value = stored.value;
                restoredBytes = stored.restoredBytes;
                resolution = 'migration-blob';
            }

            target[key] = value;
            delete target._storageReferences[key];
            restored.push({
                source: slot.source,
                extensionId: key,
                storageId: reference.extensionId,
                sha256: reference.sha256,
                restoredBytes,
                resolution,
            });
        }
        if (Object.keys(target._storageReferences).length === 0) {
            delete target._storageReferences;
        }
    }

    return { settings, restored };
}

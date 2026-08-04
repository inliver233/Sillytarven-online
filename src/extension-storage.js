import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import writeFileAtomic from 'write-file-atomic';

import { KeyedMutex } from './keyed-mutex.js';

export const MAX_EXTENSION_STORAGE_VALUE_BYTES = 1024 * 1024;
export const MAX_EXTENSION_STORAGE_QUOTA_BYTES = 64 * 1024 * 1024;
const MAX_LIST_LIMIT = 100;
const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const extensionStorageMutex = new KeyedMutex();

export class ExtensionStorageError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'ExtensionStorageError';
        this.code = code;
        this.status = status;
    }
}

export function validateExtensionStorageId(value) {
    const id = String(value ?? '');
    if (!STORAGE_ID_PATTERN.test(id) || id === '.' || id === '..') {
        throw new ExtensionStorageError('invalid_extension_id', 400, 'The extension ID is invalid.');
    }
    return id;
}

export function validateExtensionStorageKey(value) {
    const key = String(value ?? '');
    if (!STORAGE_KEY_PATTERN.test(key) || key === '.' || key === '..') {
        throw new ExtensionStorageError('invalid_storage_key', 400, 'The extension storage key is invalid.');
    }
    return key;
}

function getRecordsDirectory(extensionDataRoot, extensionId) {
    return path.join(extensionDataRoot, validateExtensionStorageId(extensionId), 'records');
}

function getRecordPath(extensionDataRoot, extensionId, key) {
    return path.join(getRecordsDirectory(extensionDataRoot, extensionId), `${validateExtensionStorageKey(key)}.json`);
}

async function getDirectorySize(directory) {
    let entries;
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }
    const sizes = await Promise.all(entries.map(async entry => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return await getDirectorySize(entryPath);
        if (!entry.isFile()) return 0;
        return (await fs.promises.stat(entryPath)).size;
    }));
    return sizes.reduce((total, size) => total + size, 0);
}

async function readRecord(filePath) {
    try {
        const text = await fs.promises.readFile(filePath, 'utf8');
        const record = JSON.parse(text);
        if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.version)) {
            throw new Error('Invalid extension storage record');
        }
        return record;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError || error?.message === 'Invalid extension storage record') {
            throw new ExtensionStorageError('storage_corrupt', 500, 'The extension storage record is corrupt.');
        }
        throw error;
    }
}

function parseExpectedVersion(request, body) {
    const header = request.get('if-match');
    const raw = header === '*' ? undefined : header?.replace(/^W\//, '').replace(/^"|"$/g, '') ?? body?.expectedVersion;
    if (raw === undefined || raw === null || raw === '') return null;
    const version = Number(raw);
    if (!Number.isSafeInteger(version) || version < 0) {
        throw new ExtensionStorageError('invalid_storage_version', 400, 'The expected storage version is invalid.');
    }
    return version;
}

async function runStorageMutation(request, callback) {
    const handle = request.user?.profile?.handle;
    if (typeof handle !== 'string' || !handle) {
        throw new ExtensionStorageError('storage_unavailable', 500, 'Extension storage is unavailable.');
    }
    const extensionId = validateExtensionStorageId(request.params.extensionId);
    return await extensionStorageMutex.runExclusive(`${handle}:${extensionId}`, callback);
}

function sendStorageError(response, error) {
    if (error instanceof ExtensionStorageError) {
        return response.status(error.status).json({ error: error.code, message: error.message });
    }
    console.error('Extension storage request failed', { code: error?.code || 'UNKNOWN' });
    return response.status(500).json({
        error: 'storage_write_failed',
        message: 'The extension storage request could not be completed.',
    });
}

const parseStorageJson = express.json({ limit: '1100kb', strict: true });

function storageJsonParser(request, response, next) {
    parseStorageJson(request, response, (error) => {
        if (!error) {
            next();
            return;
        }
        if (error.type === 'entity.too.large') {
            response.status(413).json({
                error: 'payload_too_large',
                message: 'The extension storage request exceeds the 1 MiB value limit.',
            });
            return;
        }
        response.status(400).json({
            error: 'invalid_storage_payload',
            message: 'The extension storage request body must be valid JSON.',
        });
    });
}

export const extensionStorageRouter = express.Router({ mergeParams: true });

extensionStorageRouter.get('/', async (request, response) => {
    try {
        const extensionId = validateExtensionStorageId(request.params.extensionId);
        const recordsDirectory = getRecordsDirectory(request.user.directories.extensionData, extensionId);
        const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number.parseInt(request.query.limit) || 25));
        const offset = Math.max(0, Number.parseInt(request.query.offset) || 0);
        let names = [];
        try {
            names = (await fs.promises.readdir(recordsDirectory, { withFileTypes: true }))
                .filter(entry => entry.isFile() && path.extname(entry.name) === '.json')
                .map(entry => path.basename(entry.name, '.json'))
                .sort();
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        const selected = names.slice(offset, offset + limit);
        const items = await Promise.all(selected.map(async key => {
            const stat = await fs.promises.stat(getRecordPath(request.user.directories.extensionData, extensionId, key));
            return { key, sizeBytes: stat.size, updatedAt: stat.mtime.toISOString() };
        }));
        return response.json({
            schemaVersion: 1,
            items,
            offset,
            limit,
            total: names.length,
            nextOffset: offset + items.length < names.length ? offset + items.length : null,
        });
    } catch (error) {
        return sendStorageError(response, error);
    }
});

extensionStorageRouter.get('/:key', async (request, response) => {
    try {
        const filePath = getRecordPath(request.user.directories.extensionData, request.params.extensionId, request.params.key);
        const record = await readRecord(filePath);
        if (!record) {
            throw new ExtensionStorageError('storage_key_not_found', 404, 'The extension storage key was not found.');
        }
        response.setHeader('ETag', `"${record.version}"`);
        response.setHeader('Cache-Control', 'private, no-store, max-age=0');
        return response.json(record);
    } catch (error) {
        return sendStorageError(response, error);
    }
});

extensionStorageRouter.put('/:key', storageJsonParser, async (request, response) => {
    try {
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
            || !Object.hasOwn(request.body, 'value')) {
            throw new ExtensionStorageError('invalid_storage_payload', 400, 'The extension storage payload must contain a value.');
        }
        const valueBytes = Buffer.byteLength(JSON.stringify(request.body.value), 'utf8');
        if (valueBytes > MAX_EXTENSION_STORAGE_VALUE_BYTES) {
            throw new ExtensionStorageError('payload_too_large', 413, 'The extension storage value exceeds the 1 MiB limit.');
        }
        const schemaVersion = Number(request.body.schemaVersion ?? 1);
        if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
            throw new ExtensionStorageError('invalid_schema_version', 400, 'The extension storage schema version is invalid.');
        }

        return await runStorageMutation(request, async () => {
            const extensionDataRoot = request.user.directories.extensionData;
            const extensionId = validateExtensionStorageId(request.params.extensionId);
            const key = validateExtensionStorageKey(request.params.key);
            const filePath = getRecordPath(extensionDataRoot, extensionId, key);
            const existing = await readRecord(filePath);
            const expectedVersion = parseExpectedVersion(request, request.body);
            if (expectedVersion !== null && expectedVersion !== (existing?.version ?? 0)) {
                throw new ExtensionStorageError('version_conflict', 409, 'The extension storage value changed before this write.');
            }
            const record = {
                schemaVersion,
                version: (existing?.version ?? 0) + 1,
                updatedAt: new Date().toISOString(),
                value: request.body.value,
            };
            const serialized = JSON.stringify(record);
            const extensionDirectory = path.join(extensionDataRoot, extensionId);
            const existingBytes = existing ? (await fs.promises.stat(filePath)).size : 0;
            const usedBytes = await getDirectorySize(extensionDirectory);
            if (usedBytes - existingBytes + Buffer.byteLength(serialized, 'utf8') > MAX_EXTENSION_STORAGE_QUOTA_BYTES) {
                throw new ExtensionStorageError('quota_exceeded', 507, 'The extension storage quota has been exceeded.');
            }
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await writeFileAtomic(filePath, serialized, 'utf8');
            response.setHeader('ETag', `"${record.version}"`);
            return response.json({ schemaVersion, version: record.version, updatedAt: record.updatedAt });
        });
    } catch (error) {
        return sendStorageError(response, error);
    }
});

extensionStorageRouter.delete('/:key', async (request, response) => {
    try {
        return await runStorageMutation(request, async () => {
            const filePath = getRecordPath(request.user.directories.extensionData, request.params.extensionId, request.params.key);
            const existing = await readRecord(filePath);
            if (!existing) {
                throw new ExtensionStorageError('storage_key_not_found', 404, 'The extension storage key was not found.');
            }
            const expectedVersion = parseExpectedVersion(request, request.body);
            if (expectedVersion !== null && expectedVersion !== existing.version) {
                throw new ExtensionStorageError('version_conflict', 409, 'The extension storage value changed before this delete.');
            }
            await fs.promises.unlink(filePath);
            return response.sendStatus(204);
        });
    } catch (error) {
        return sendStorageError(response, error);
    }
});

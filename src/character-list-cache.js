import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { BoundedCache } from './bounded-cache.js';
import { mapWithConcurrency } from './concurrency.js';

/**
 * Builds and caches complete per-user character lists without returning placeholder data.
 */
export class CharacterListCache {
    /**
     * @param {object} [options] Cache options
     * @param {boolean} [options.enabled] Retain completed lists
     * @param {number} [options.concurrency] Character/stat worker limit
     * @param {number} [options.ttlMs] List lifetime
     * @param {number} [options.signatureTtlMs] Maximum delay before a full external-change scan
     * @param {number} [options.maxEntries] User/mode entry capacity
     * @param {number} [options.maxBytes] Approximate memory capacity
     * @param {() => number} [options.now] Clock
     */
    constructor({
        enabled = true,
        concurrency = 6,
        ttlMs = 30_000,
        signatureTtlMs = 5_000,
        maxEntries = 100,
        maxBytes = 100 * 1024 * 1024,
        now = Date.now,
    } = {}) {
        this.concurrency = Math.min(32, Math.max(1, Math.floor(Number(concurrency) || 1)));
        this.signatureTtlMs = Math.max(0, Number(signatureTtlMs) || 0);
        this.maxSignatureEntries = Math.max(1, Math.floor(Number(maxEntries) || 1));
        this.now = now;
        this.cache = new BoundedCache({ enabled, ttlMs, maxEntries, maxBytes, now });
        this.signatures = new Map();
    }

    /**
     * Get a complete character list.
     * @param {object} options Request options
     * @param {string} options.userKey Trusted server-side user key
     * @param {string} options.directory Character PNG directory
     * @param {boolean} options.shallow Current response mode
     * @param {(fileName: string) => Promise<object>} options.loadCharacter Existing compatible card loader
     * @returns {Promise<{characters: object[], state: 'hit'|'miss'|'shared', fileCount: number, failures: number, maxCharacterMs: number, concurrency: number}>}
     */
    async get({ userKey, directory, shallow, loadCharacter }) {
        const trustedKey = String(userKey);
        const signature = await this.#getSignature(trustedKey, directory);
        const cacheKey = this.#cacheKey(trustedKey, shallow);
        const result = await this.cache.getOrLoad(cacheKey, {
            signature: signature.value,
            load: async () => {
                let failures = 0;
                let maxCharacterMs = 0;
                const loaded = await mapWithConcurrency(signature.files, this.concurrency, async fileName => {
                    const startedAt = performance.now();
                    try {
                        const character = await loadCharacter(fileName);
                        if (!character?.name) {
                            failures++;
                            return null;
                        }
                        return character;
                    } catch {
                        failures++;
                        return null;
                    } finally {
                        maxCharacterMs = Math.max(maxCharacterMs, performance.now() - startedAt);
                    }
                });
                return {
                    characters: loaded.filter(Boolean),
                    failures,
                    maxCharacterMs,
                };
            },
            sizeOf: value => Buffer.byteLength(JSON.stringify(value.characters), 'utf8'),
        });

        return {
            ...result.value,
            state: result.state,
            fileCount: signature.files.length,
            concurrency: Math.min(this.concurrency, Math.max(0, signature.files.length)),
        };
    }

    /** Invalidate both shallow and full list modes for one trusted user key. */
    invalidate(userKey) {
        const trustedKey = String(userKey);
        this.signatures.delete(trustedKey);
        this.cache.invalidate(this.#cacheKey(trustedKey, false));
        this.cache.invalidate(this.#cacheKey(trustedKey, true));
    }

    /** Clear all list/signature entries. */
    clear() {
        this.signatures.clear();
        this.cache.clear();
    }

    /** @returns {{entries: number, inflight: number, totalBytes: number, signatures: number}} Cache status */
    getStatus() {
        return { ...this.cache.getStatus(), signatures: this.signatures.size };
    }

    #cacheKey(userKey, shallow) {
        return JSON.stringify([userKey, Boolean(shallow)]);
    }

    async #getSignature(userKey, directory) {
        const directoryStats = await fs.promises.stat(directory);
        const cached = this.signatures.get(userKey);
        if (cached && cached.directoryMtimeMs === directoryStats.mtimeMs && this.now() - cached.checkedAt < this.signatureTtlMs) {
            this.signatures.delete(userKey);
            this.signatures.set(userKey, cached);
            return cached;
        }

        const dirents = await fs.promises.readdir(directory, { withFileTypes: true });
        const pngFiles = dirents
            .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.png')
            .map(entry => entry.name)
            .sort((left, right) => left.localeCompare(right));
        const records = await mapWithConcurrency(pngFiles, this.concurrency, async fileName => {
            try {
                const stats = await fs.promises.stat(path.join(directory, fileName));
                return { fileName, size: stats.size, mtimeMs: stats.mtimeMs };
            } catch {
                return null;
            }
        });
        const validRecords = records.filter(Boolean);
        const hash = crypto.createHash('sha256');
        hash.update(path.resolve(directory));
        for (const record of validRecords) {
            hash.update(`\0${record.fileName}\0${record.size}\0${record.mtimeMs}`);
        }
        const value = hash.digest('hex');
        const result = {
            value,
            files: validRecords.map(record => record.fileName),
            directoryMtimeMs: directoryStats.mtimeMs,
            checkedAt: this.now(),
        };
        this.signatures.delete(userKey);
        this.signatures.set(userKey, result);
        while (this.signatures.size > this.maxSignatureEntries) {
            this.signatures.delete(this.signatures.keys().next().value);
        }
        return result;
    }
}

let activeCharacterListCache = null;

/** Register the process-wide cache used by endpoint invalidation hooks. */
export function registerCharacterListCache(cache) {
    activeCharacterListCache = cache;
}

/** Invalidate one user's character list after a successful character/chat mutation. */
export function invalidateCharacterListCache(userKey) {
    activeCharacterListCache?.invalidate(userKey);
}

/** Clear all retained character lists. */
export function clearCharacterListCache() {
    activeCharacterListCache?.clear();
}

/** Return aggregate cache capacity data without user keys or character content. */
export function getCharacterListCacheStatus() {
    return activeCharacterListCache?.getStatus() ?? { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 };
}

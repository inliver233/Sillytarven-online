import fs from 'node:fs';
import path from 'node:path';

import { BoundedCache } from './bounded-cache.js';

/**
 * Small per-user cache for final recent-chat responses. It avoids all candidate scans on a hit.
 */
export class RecentChatsCache {
    /**
     * @param {object} [options] Cache options
     * @param {boolean} [options.enabled] Retain completed results
     * @param {number} [options.ttlMs] Result lifetime
     * @param {number} [options.signatureTtlMs] Root-directory check interval
     * @param {number} [options.maxEntries] Request-variant capacity
     * @param {number} [options.maxBytes] Approximate memory capacity
     * @param {() => number} [options.now] Clock
     */
    constructor({
        enabled = true,
        ttlMs = 15_000,
        signatureTtlMs = 2_000,
        maxEntries = 300,
        maxBytes = 50 * 1024 * 1024,
        now = Date.now,
    } = {}) {
        this.signatureTtlMs = Math.max(0, Number(signatureTtlMs) || 0);
        this.maxSignatureEntries = Math.max(1, Math.floor(Number(maxEntries) || 1));
        this.now = now;
        this.cache = new BoundedCache({ enabled, ttlMs, maxEntries, maxBytes, now });
        this.signatures = new Map();
    }

    /**
     * Get a final recent-chat list or build it once.
     * @param {object} options Request options
     * @param {string} options.userKey Trusted server-side user key
     * @param {object} options.directories Trusted user directories
     * @param {number} options.max Requested result limit
     * @param {boolean} options.metadata Whether metadata is included
     * @param {() => Promise<object[]>} options.load Native list builder
     * @returns {Promise<{value: object[], state: 'hit'|'miss'|'shared'}>}
     */
    async get({ userKey, directories, max, metadata, load }) {
        const trustedKey = String(userKey);
        const signature = await this.#getSignature(trustedKey, directories);
        const key = this.#cacheKey(trustedKey, max, metadata);
        return await this.cache.getOrLoad(key, {
            signature,
            load,
            sizeOf: value => Buffer.byteLength(JSON.stringify(value), 'utf8'),
        });
    }

    /** Invalidate every max/metadata variant for one user. */
    invalidate(userKey) {
        const trustedKey = String(userKey);
        const prefix = this.#cachePrefix(trustedKey);
        this.signatures.delete(trustedKey);
        this.cache.invalidateWhere(key => key.startsWith(prefix));
    }

    /** Clear all results/signatures. */
    clear() {
        this.signatures.clear();
        this.cache.clear();
    }

    /** @returns {{entries: number, inflight: number, totalBytes: number, signatures: number}} Cache status */
    getStatus() {
        return { ...this.cache.getStatus(), signatures: this.signatures.size };
    }

    #cachePrefix(userKey) {
        return `${Buffer.byteLength(userKey, 'utf8')}:${userKey}:`;
    }

    #cacheKey(userKey, max, metadata) {
        return `${this.#cachePrefix(userKey)}${String(max)}:${Number(Boolean(metadata))}`;
    }

    async #getSignature(userKey, directories) {
        const cached = this.signatures.get(userKey);
        if (cached && this.now() - cached.checkedAt < this.signatureTtlMs) {
            this.signatures.delete(userKey);
            this.signatures.set(userKey, cached);
            return cached.value;
        }

        const roots = ['characters', 'chats', 'groups', 'groupChats'];
        const records = await Promise.all(roots.map(async key => {
            const directory = directories[key];
            try {
                const stats = await fs.promises.stat(directory);
                return `${key}:${path.resolve(directory)}:${stats.size}:${stats.mtimeMs}`;
            } catch {
                return `${key}:missing`;
            }
        }));
        const result = { value: records.join('|'), checkedAt: this.now() };
        this.signatures.delete(userKey);
        this.signatures.set(userKey, result);
        while (this.signatures.size > this.maxSignatureEntries) {
            this.signatures.delete(this.signatures.keys().next().value);
        }
        return result.value;
    }
}

let activeRecentChatsCache = null;

/** Register the process-wide recent-chat cache used by mutation hooks. */
export function registerRecentChatsCache(cache) {
    activeRecentChatsCache = cache;
}

/** Invalidate all recent-list variants for a trusted user. */
export function invalidateRecentChatsCache(userKey) {
    activeRecentChatsCache?.invalidate(userKey);
}

/** Clear all recent-chat results. */
export function clearRecentChatsCache() {
    activeRecentChatsCache?.clear();
}

/** Return aggregate status without user keys or chat content. */
export function getRecentChatsCacheStatus() {
    return activeRecentChatsCache?.getStatus() ?? { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 };
}

const MUTATION_ROUTES = new Set([
    '/api/chats/save',
    '/api/chats/save-tail',
    '/api/chats/rename',
    '/api/chats/delete',
    '/api/chats/import',
    '/api/chats/group/import',
    '/api/chats/group/delete',
    '/api/chats/group/save',
    '/api/chats/group/save-tail',
    '/api/characters/create',
    '/api/characters/rename',
    '/api/characters/edit',
    '/api/characters/edit-avatar',
    '/api/characters/edit-attribute',
    '/api/characters/merge-attributes',
    '/api/characters/delete',
    '/api/characters/import',
    '/api/characters/duplicate',
    '/api/groups/create',
    '/api/groups/edit',
    '/api/groups/delete',
]);

/** Express middleware for precise recent-list invalidation after successful mutations. */
export function recentChatsCacheInvalidationMiddleware(request, response, next) {
    const route = `${request.baseUrl}${request.path}`;
    if (request.method === 'POST' && MUTATION_ROUTES.has(route)) {
        response.once('finish', () => {
            const handle = request.user?.profile?.handle;
            if (response.statusCode < 400 && handle) {
                invalidateRecentChatsCache(handle);
            }
        });
    }
    next();
}

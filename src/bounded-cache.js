/**
 * Bounded TTL/LRU cache with signature validation and per-key single-flight loading.
 */
export class BoundedCache {
    /**
     * @param {object} [options] Cache options
     * @param {boolean} [options.enabled] Whether completed values are retained
     * @param {number} [options.ttlMs] Entry lifetime
     * @param {number} [options.maxEntries] Entry capacity
     * @param {number} [options.maxBytes] Approximate key + value byte capacity
     * @param {() => number} [options.now] Clock
     */
    constructor({
        enabled = true,
        ttlMs = 30_000,
        maxEntries = 100,
        maxBytes = 100 * 1024 * 1024,
        now = Date.now,
    } = {}) {
        this.enabled = Boolean(enabled);
        this.ttlMs = Math.max(0, Number(ttlMs) || 0);
        this.maxEntries = Math.max(0, Math.floor(Number(maxEntries) || 0));
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        this.now = now;
        this.entries = new Map();
        this.inflight = new Map();
        this.generations = new Map();
        this.activeLoads = new Map();
        this.totalBytes = 0;
        this.epoch = 0;
    }

    /**
     * Return a matching unexpired value and refresh its LRU position.
     * @param {string} key Cache key
     * @param {string} signature Resource signature
     * @returns {{hit: boolean, value?: any}}
     */
    get(key, signature) {
        if (!this.enabled) {
            return { hit: false };
        }
        const entry = this.entries.get(key);
        if (!entry) {
            return { hit: false };
        }
        if (entry.signature !== signature || entry.expiresAt <= this.now()) {
            this.#deleteEntry(key);
            return { hit: false };
        }

        this.entries.delete(key);
        this.entries.set(key, entry);
        return { hit: true, value: entry.value };
    }

    /**
     * Get or build a value. Concurrent misses for the same signature share one load.
     * @param {string} key Cache key
     * @param {object} options Load options
     * @param {string} options.signature Resource signature
     * @param {() => Promise<any>} options.load Loader
     * @param {(value: any) => number} [options.sizeOf] Approximate value size
     * @returns {Promise<{value: any, state: 'hit'|'miss'|'shared'}>}
     */
    async getOrLoad(key, { signature, load, sizeOf = () => 0 }) {
        const cached = this.get(key, signature);
        if (cached.hit) {
            return { value: cached.value, state: 'hit' };
        }

        const running = this.inflight.get(key);
        if (running?.signature === signature) {
            return { value: await running.promise, state: 'shared' };
        }

        const generation = Object.freeze({});
        this.generations.set(key, generation);
        const epoch = this.epoch;
        const promise = Promise.resolve().then(load).then(value => {
            if (this.enabled && this.epoch === epoch && this.generations.get(key) === generation) {
                this.#set(key, signature, value, sizeOf(value));
            }
            return value;
        });
        const record = { signature, promise };
        this.inflight.set(key, record);
        const active = this.activeLoads.get(key) ?? new Set();
        active.add(record);
        this.activeLoads.set(key, active);

        try {
            return { value: await promise, state: 'miss' };
        } finally {
            if (this.inflight.get(key) === record) {
                this.inflight.delete(key);
            }
            active.delete(record);
            if (active.size === 0 && this.activeLoads.get(key) === active) {
                this.activeLoads.delete(key);
                this.generations.delete(key);
            }
        }
    }

    /** Invalidate one key and prevent an older in-flight load from being retained. */
    invalidate(key) {
        this.#deleteEntry(key);
        this.inflight.delete(key);
        this.generations.set(key, Object.freeze({}));
        if (!this.activeLoads.has(key)) {
            this.generations.delete(key);
        }
    }

    /** Invalidate all keys matching a predicate. */
    invalidateWhere(predicate) {
        const keys = new Set([
            ...this.entries.keys(),
            ...this.inflight.keys(),
            ...this.generations.keys(),
            ...this.activeLoads.keys(),
        ]);
        for (const key of keys) {
            if (predicate(key)) {
                this.invalidate(key);
            }
        }
    }

    /** Clear entries and detach all in-flight records without cancelling their callers. */
    clear() {
        this.entries.clear();
        this.inflight.clear();
        this.generations.clear();
        this.activeLoads.clear();
        this.totalBytes = 0;
        this.epoch++;
    }

    /** @returns {{entries: number, inflight: number, totalBytes: number, generations: number}} Cache status */
    getStatus() {
        return {
            entries: this.entries.size,
            inflight: this.inflight.size,
            totalBytes: this.totalBytes,
            generations: this.generations.size,
        };
    }

    #set(key, signature, value, rawSize) {
        this.#deleteEntry(key);
        const metadataBytes = Buffer.byteLength(key, 'utf8') + Buffer.byteLength(String(signature), 'utf8');
        const sizeBytes = Math.max(0, Number(rawSize) || 0) + metadataBytes;
        if (this.maxEntries <= 0 || this.maxBytes <= 0 || sizeBytes > this.maxBytes) {
            return;
        }
        const entry = {
            value,
            signature,
            expiresAt: this.now() + this.ttlMs,
            sizeBytes,
        };
        this.entries.set(key, entry);
        this.totalBytes += sizeBytes;
        this.#prune();
    }

    #deleteEntry(key) {
        const entry = this.entries.get(key);
        if (entry) {
            this.totalBytes = Math.max(0, this.totalBytes - entry.sizeBytes);
            this.entries.delete(key);
        }
    }

    #prune() {
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const oldestKey = this.entries.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.#deleteEntry(oldestKey);
        }
    }
}

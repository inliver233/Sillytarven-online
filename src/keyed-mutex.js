/**
 * Serializes asynchronous work per key without blocking unrelated keys.
 */
export class KeyedMutex {
    #tails = new Map();

    /**
     * @template T
     * @param {string} key Stable lock key
     * @param {() => Promise<T>|T} callback Exclusive callback
     * @returns {Promise<T>} Callback result
     */
    async runExclusive(key, callback) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new TypeError('Mutex key must be a non-empty string.');
        }
        if (typeof callback !== 'function') {
            throw new TypeError('Mutex callback must be a function.');
        }

        const previous = this.#tails.get(key) ?? Promise.resolve();
        let release;
        const current = new Promise(resolve => {
            release = resolve;
        });
        this.#tails.set(key, current);

        await previous.catch(() => {});
        try {
            return await callback();
        } finally {
            release();
            if (this.#tails.get(key) === current) {
                this.#tails.delete(key);
            }
        }
    }
}

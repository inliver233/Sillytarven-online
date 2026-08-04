const DEFAULT_SETTLE_WINDOW_MS = 15_000;
const MAX_GUARD_AGE_MS = 2 * 60 * 1000;

/**
 * Persists a small third-party startup marker. If the page disappears before
 * the marker settles, the next startup can quarantine only those extensions.
 */
export class ExtensionStartupGuard {
    constructor({ storage, userId, now = Date.now, settleWindowMs = DEFAULT_SETTLE_WINDOW_MS } = {}) {
        this.storage = storage;
        this.now = now;
        this.settleWindowMs = Math.max(1000, Number(settleWindowMs) || DEFAULT_SETTLE_WINDOW_MS);
        this.key = `st-extension-startup:${String(userId || 'default-user')}`;
    }

    #read() {
        try {
            const record = JSON.parse(this.storage?.getItem(this.key) || 'null');
            if (!record || record.version !== 1 || !Array.isArray(record.extensions)) return null;
            return record;
        } catch {
            return null;
        }
    }

    #write(extensions) {
        try {
            if (!extensions.length) {
                this.storage?.removeItem(this.key);
                return;
            }
            this.storage?.setItem(this.key, JSON.stringify({
                version: 1,
                extensions,
                expiresAt: this.now() + MAX_GUARD_AGE_MS,
            }));
        } catch {
            // Storage may be disabled or full. Startup must continue.
        }
    }

    recover() {
        const record = this.#read();
        try {
            this.storage?.removeItem(this.key);
        } catch {
            // Recovery is best effort.
        }
        if (!record || record.expiresAt < this.now()) return [];
        return [...new Set(record.extensions.filter(name => typeof name === 'string' && name.startsWith('third-party/')))];
    }

    begin(extensionId) {
        if (typeof extensionId !== 'string' || !extensionId.startsWith('third-party/')) return false;
        const record = this.#read();
        const extensions = record?.expiresAt >= this.now() ? record.extensions : [];
        this.#write([...new Set([...extensions, extensionId])]);
        return true;
    }

    settle(extensionId) {
        const record = this.#read();
        if (!record) return;
        this.#write(record.extensions.filter(name => name !== extensionId));
    }

    scheduleSettle(extensionId, setTimeoutFn = setTimeout) {
        return setTimeoutFn(() => this.settle(extensionId), this.settleWindowMs);
    }
}

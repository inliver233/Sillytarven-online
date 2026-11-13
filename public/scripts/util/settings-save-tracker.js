const DEFAULT_MAX_BASELINE_LENGTH = 5 * 1024 * 1024;

/**
 * Requires the server's complete settings-save success contract.
 * @param {Response|{ok: boolean, status: number, statusText?: string, json: () => Promise<unknown>}} response Fetch response
 * @returns {Promise<{result: 'ok'}>}
 */
export async function requireSettingsSaveSuccess(response) {
    if (!response?.ok) {
        throw new Error(`Failed to save settings: HTTP ${response?.status ?? 'unknown'} ${response?.statusText || ''}`.trim());
    }

    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error('Settings server returned an invalid success response.');
    }
    if (!body || typeof body !== 'object' || body.result !== 'ok' || Object.keys(body).length !== 1) {
        throw new Error('Settings server returned an invalid success response.');
    }
    return body;
}

/** Serializes settings saves so responses cannot commit out of order. */
export class SettingsSaveQueue {
    #tail = Promise.resolve();
    #pending = 0;

    get pending() {
        return this.#pending;
    }

    /**
     * @template T
     * @param {() => Promise<T>|T} task Save task
     * @returns {Promise<T>}
     */
    enqueue(task) {
        if (typeof task !== 'function') {
            throw new TypeError('Settings save task must be a function');
        }
        this.#pending += 1;
        const run = this.#tail.then(task);
        this.#tail = run.catch(() => {});
        return run.finally(() => {
            this.#pending -= 1;
        });
    }
}

/**
 * @typedef {object} SettingsFingerprint
 * @property {number} length Serialized length
 * @property {string|null} text The payload itself, when small enough to keep
 * @property {string|null} hash SHA-256 of a larger payload (null when it could not be computed)
 */

/**
 * SHA-256 of a text, hex.
 * @param {string} text
 * @returns {Promise<string|null>} Null without Web Crypto (an http page that is not localhost)
 */
async function sha256Hex(text) {
    if (!globalThis.crypto?.subtle) {
        return null;
    }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Tracks the last confirmed settings payload, so an unchanged one is not uploaded again.
 * Small payloads are compared as they are; larger ones (some are tens of MB) by length and SHA-256,
 * so the page does not keep a second copy of them.
 */
export class SettingsSaveTracker {
    /** @type {SettingsFingerprint|null} */
    #baseline = null;
    #maxBaselineLength;
    #hash;

    /**
     * @param {object} [options] Tracker options
     * @param {number} [options.maxBaselineLength] Largest payload kept as it is (longer ones are hashed)
     * @param {(text: string) => Promise<string|null>} [options.hash] Hash of a larger payload (tests)
     */
    constructor({ maxBaselineLength = DEFAULT_MAX_BASELINE_LENGTH, hash = sha256Hex } = {}) {
        const requestedLimit = Number(maxBaselineLength);
        if (!Number.isFinite(requestedLimit) || requestedLimit < 0) {
            throw new TypeError('maxBaselineLength must be a non-negative finite number');
        }
        this.#maxBaselineLength = Math.floor(requestedLimit);
        this.#hash = hash;
    }

    /**
     * Fingerprint of a serialized payload, for isUnchanged and commit.
     * @param {string} serializedPayload Serialized settings payload
     * @returns {Promise<SettingsFingerprint>}
     */
    async fingerprint(serializedPayload) {
        if (typeof serializedPayload !== 'string') {
            throw new TypeError('serializedPayload must be a string');
        }
        const length = serializedPayload.length;
        if (length <= this.#maxBaselineLength) {
            return { length, text: serializedPayload, hash: null };
        }
        let hash = null;
        try {
            hash = await this.#hash(serializedPayload);
        } catch (error) {
            console.warn('Could not hash the settings payload', error);
        }
        return { length, text: null, hash: typeof hash === 'string' && hash ? hash : null };
    }

    /**
     * Whether a payload exactly matches the last confirmed one.
     * @param {SettingsFingerprint} fingerprint From fingerprint()
     * @returns {boolean} Whether the network save can be skipped
     */
    isUnchanged(fingerprint) {
        const baseline = this.#baseline;
        if (!baseline || !fingerprint || baseline.length !== fingerprint.length) {
            return false;
        }
        if (baseline.text !== null) {
            return fingerprint.text === baseline.text;
        }
        return baseline.hash !== null && fingerprint.hash === baseline.hash;
    }

    /**
     * Retain a payload only after its full save succeeds.
     * @param {SettingsFingerprint} fingerprint From fingerprint()
     * @returns {boolean} Whether the payload was retained
     */
    commit(fingerprint) {
        if (!fingerprint || (fingerprint.text === null && fingerprint.hash === null)) {
            this.clear();
            return false;
        }
        this.#baseline = fingerprint;
        return true;
    }

    /**
     * Invalidate the baseline when settings are reloaded from the server.
     */
    clear() {
        this.#baseline = null;
    }
}

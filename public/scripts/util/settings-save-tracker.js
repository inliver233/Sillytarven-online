const DEFAULT_MAX_BASELINE_LENGTH = 5 * 1024 * 1024;

/**
 * Requires the server's complete settings-save success contract.
 * @param {Response|{ok: boolean, status: number, statusText?: string, json: () => Promise<unknown>}} response Fetch response
 * @returns {Promise<object>}
 */
export async function requireSettingsSaveSuccess(response) {
    if (!response?.ok) {
        let failure = null;
        try {
            failure = await response?.json();
        } catch {
            // Fall back to the stable HTTP error below.
        }
        const error = new Error(failure?.message
            || `Failed to save settings: HTTP ${response?.status ?? 'unknown'} ${response?.statusText || ''}`.trim());
        error.code = failure?.error || 'settings_save_failed';
        error.status = response?.status;
        throw error;
    }

    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error('Settings server returned an invalid success response.');
    }
    const allowedKeys = new Set([
        'result',
        'migratedExtensionSettings',
        'migratedOaiExtensionSettings',
        'rejectedExtensionSettings',
        'disabledExtensions',
    ]);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.result !== 'ok'
        || Object.keys(body).some(key => !allowedKeys.has(key))
        || (body.migratedExtensionSettings !== undefined
            && (!body.migratedExtensionSettings || typeof body.migratedExtensionSettings !== 'object'
                || Array.isArray(body.migratedExtensionSettings)))
        || (body.migratedOaiExtensionSettings !== undefined
            && (!body.migratedOaiExtensionSettings || typeof body.migratedOaiExtensionSettings !== 'object'
                || Array.isArray(body.migratedOaiExtensionSettings)))
        || (body.rejectedExtensionSettings !== undefined && !Array.isArray(body.rejectedExtensionSettings))
        || (body.disabledExtensions !== undefined
            && (!Array.isArray(body.disabledExtensions)
                || body.disabledExtensions.some(value => typeof value !== 'string')))) {
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
 * Tracks the last confirmed serialized settings payload for exact no-op detection.
 */
export class SettingsSaveTracker {
    #baseline = null;
    #maxBaselineLength;

    /**
     * @param {object} [options] Tracker options
     * @param {number} [options.maxBaselineLength] Maximum serialized characters retained in memory
     */
    constructor({ maxBaselineLength = DEFAULT_MAX_BASELINE_LENGTH } = {}) {
        const requestedLimit = Number(maxBaselineLength);
        if (!Number.isFinite(requestedLimit) || requestedLimit < 0) {
            throw new TypeError('maxBaselineLength must be a non-negative finite number');
        }
        this.#maxBaselineLength = Math.floor(requestedLimit);
    }

    /**
     * Check whether an enabled save exactly matches the last confirmed payload.
     * @param {string} serializedPayload Serialized settings payload
     * @param {boolean} enabled Whether no-op detection is enabled
     * @returns {boolean} Whether the network save can be skipped
     */
    isUnchanged(serializedPayload, enabled) {
        if (typeof serializedPayload !== 'string') {
            throw new TypeError('serializedPayload must be a string');
        }
        return Boolean(enabled) && this.#baseline !== null && serializedPayload === this.#baseline;
    }

    /**
     * Retain a payload only after its full save succeeds.
     * @param {string} serializedPayload Serialized settings payload
     * @returns {boolean} Whether the payload was retained
     */
    commit(serializedPayload) {
        if (typeof serializedPayload !== 'string') {
            throw new TypeError('serializedPayload must be a string');
        }
        if (serializedPayload.length > this.#maxBaselineLength) {
            this.clear();
            return false;
        }
        this.#baseline = serializedPayload;
        return true;
    }

    /**
     * Invalidate the baseline when settings are reloaded from the server.
     */
    clear() {
        this.#baseline = null;
    }
}

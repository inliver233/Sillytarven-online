const DEFAULT_MAX_BASELINE_LENGTH = 5 * 1024 * 1024;

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

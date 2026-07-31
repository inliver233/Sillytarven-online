/**
 * Coalesces expensive chat refreshes while the regex settings panel is open.
 */
export class RegexRefreshCoordinator {
    #refresh;
    #panelOpen = false;
    #dirty = false;
    #pendingRequestCount = 0;
    #refreshPromise = null;

    /**
     * @param {(details: {requestCount: number}) => Promise<void>} refresh Refresh callback
     */
    constructor(refresh) {
        if (typeof refresh !== 'function') {
            throw new TypeError('refresh must be a function');
        }
        this.#refresh = refresh;
    }

    /**
     * Update whether the regex settings panel is visible. Closing a dirty panel flushes it.
     * @param {boolean} isOpen Whether the panel is visible
     * @returns {Promise<boolean>} Whether a refresh ran
     */
    setPanelOpen(isOpen) {
        this.#panelOpen = Boolean(isOpen);
        return this.#panelOpen ? Promise.resolve(false) : this.flush();
    }

    /**
     * Mark regex output as stale and refresh immediately when the panel is not open.
     * @returns {Promise<boolean>} Whether a refresh ran
     */
    requestRefresh() {
        this.#dirty = true;
        this.#pendingRequestCount++;
        return this.#panelOpen ? Promise.resolve(false) : this.flush();
    }

    /**
     * Flush pending work unless the panel is open. Concurrent callers share one refresh.
     * @returns {Promise<boolean>} Whether a refresh ran
     */
    flush() {
        if (this.#panelOpen) {
            return Promise.resolve(false);
        }
        if (this.#refreshPromise) {
            return this.#refreshPromise;
        }
        if (!this.#dirty) {
            return Promise.resolve(false);
        }
        this.#refreshPromise = this.#drain().finally(() => {
            this.#refreshPromise = null;
        });
        return this.#refreshPromise;
    }

    async #drain() {
        let refreshed = false;
        while (!this.#panelOpen && this.#dirty) {
            this.#dirty = false;
            const requestCount = this.#pendingRequestCount;
            this.#pendingRequestCount = 0;
            try {
                await this.#refresh({ requestCount });
                refreshed = true;
            } catch (error) {
                this.#dirty = true;
                this.#pendingRequestCount += requestCount;
                throw error;
            }
        }
        return refreshed;
    }
}

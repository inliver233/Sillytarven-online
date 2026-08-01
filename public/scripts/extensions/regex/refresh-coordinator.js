/**
 * Coalesces expensive chat refreshes while the regex settings panel is open.
 */
export class RegexRefreshCoordinator {
    #refresh;
    #panelOpen = false;
    #dirty = false;
    #pendingRequestCount = 0;
    #refreshPromise = null;
    #getContextIdentity;
    #generation = 0;
    #controller = null;

    /**
     * @param {(details: {requestCount: number, contextIdentity: unknown, signal: AbortSignal, isCurrent: () => boolean}) => Promise<void>} refresh Refresh callback
     * @param {object} [options] Coordinator options
     * @param {() => unknown} [options.getContextIdentity] Current character/group/chat identity
     */
    constructor(refresh, { getContextIdentity = () => null } = {}) {
        if (typeof refresh !== 'function') {
            throw new TypeError('refresh must be a function');
        }
        if (typeof getContextIdentity !== 'function') {
            throw new TypeError('getContextIdentity must be a function');
        }
        this.#refresh = refresh;
        this.#getContextIdentity = getContextIdentity;
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

    /** Cancel pending work and make the current character/group/chat refresh stale. */
    invalidate() {
        this.#generation++;
        this.#dirty = false;
        this.#pendingRequestCount = 0;
        this.#controller?.abort();
        this.#controller = null;
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
            const generation = this.#generation;
            const contextIdentity = this.#getContextIdentity();
            const controller = new AbortController();
            this.#controller = controller;
            const isCurrent = () => !controller.signal.aborted
                && generation === this.#generation
                && contextIdentity === this.#getContextIdentity();
            try {
                await this.#refresh({
                    requestCount,
                    contextIdentity,
                    signal: controller.signal,
                    isCurrent,
                });
                refreshed ||= isCurrent();
            } catch (error) {
                if (!isCurrent()) {
                    continue;
                }
                this.#dirty = true;
                this.#pendingRequestCount += requestCount;
                throw error;
            } finally {
                if (this.#controller === controller) {
                    this.#controller = null;
                }
            }
        }
        return refreshed;
    }
}

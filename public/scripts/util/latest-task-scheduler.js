/**
 * Debounces task requests, runs one task at a time, and commits only the latest result.
 */
export class LatestTaskScheduler {
    #run;
    #commit;
    #onError;
    #onDiscard;
    #delayMs;
    #setTimeout;
    #clearTimeout;
    #timer = null;
    #runningPromise = null;
    #pending = false;
    #pendingRequestCount = 0;
    #version = 0;

    /**
     * @template T
     * @param {object} options Scheduler options
     * @param {(details: {version: number, requestCount: number}) => Promise<T>} options.run Background task
     * @param {(result: T, details: {version: number, requestCount: number}) => Promise<void>|void} options.commit Latest-result callback
     * @param {(error: unknown, details: {version: number, requestCount: number}) => Promise<void>|void} [options.onError] Latest-error callback
     * @param {(result: T|undefined, details: {version: number, requestCount: number}) => Promise<void>|void} [options.onDiscard] Superseded-result callback
     * @param {number} [options.delayMs=0] Initial debounce delay
     * @param {(callback: () => void, delay: number) => any} [options.setTimeoutFn] Timer implementation
     * @param {(timer: any) => void} [options.clearTimeoutFn] Timer cancellation implementation
     */
    constructor({
        run,
        commit,
        onError = () => {},
        onDiscard = () => {},
        delayMs = 0,
        setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeoutFn = timer => globalThis.clearTimeout(timer),
    }) {
        if (typeof run !== 'function' || typeof commit !== 'function' || typeof onError !== 'function' || typeof onDiscard !== 'function') {
            throw new TypeError('task callbacks must be functions');
        }
        if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
            throw new TypeError('timer hooks must be functions');
        }
        const requestedDelay = Number(delayMs);
        this.#run = run;
        this.#commit = commit;
        this.#onError = onError;
        this.#onDiscard = onDiscard;
        this.#delayMs = Number.isFinite(requestedDelay) && requestedDelay >= 0 ? requestedDelay : 0;
        this.#setTimeout = setTimeoutFn;
        this.#clearTimeout = clearTimeoutFn;
    }

    /**
     * Request a task run and restart the debounce window when idle.
     * @returns {number} Monotonic request version
     */
    schedule() {
        this.#version++;
        this.#pending = true;
        this.#pendingRequestCount++;

        if (this.#runningPromise) {
            return this.#version;
        }
        this.#clearTimer();
        this.#timer = this.#setTimeout(() => {
            this.#timer = null;
            void this.#startDrain();
        }, this.#delayMs);
        return this.#version;
    }

    /**
     * Invalidate pending and in-flight results. An active task is allowed to finish without committing.
     */
    cancel() {
        this.#version++;
        this.#pending = false;
        this.#pendingRequestCount = 0;
        this.#clearTimer();
    }

    /**
     * Skip the debounce delay and wait until all currently pending work is drained.
     * @returns {Promise<void>}
     */
    async flush() {
        this.#clearTimer();
        if (!this.#runningPromise && this.#pending) {
            this.#startDrain();
        }
        await this.#runningPromise;
    }

    #clearTimer() {
        if (this.#timer === null) {
            return;
        }
        this.#clearTimeout(this.#timer);
        this.#timer = null;
    }

    #startDrain() {
        if (!this.#runningPromise) {
            const drainPromise = Promise.resolve().then(() => this.#drain());
            this.#runningPromise = drainPromise.finally(() => {
                this.#runningPromise = null;
            });
        }
        return this.#runningPromise;
    }

    async #drain() {
        while (this.#pending) {
            this.#pending = false;
            const version = this.#version;
            const requestCount = this.#pendingRequestCount;
            this.#pendingRequestCount = 0;
            const details = { version, requestCount };

            try {
                const result = await this.#run(details);
                if (version === this.#version && !this.#pending) {
                    await this.#commit(result, details);
                } else {
                    await this.#callDiscard(result, details);
                }
            } catch (error) {
                if (version === this.#version && !this.#pending) {
                    try {
                        await this.#onError(error, details);
                    } catch (callbackError) {
                        console.error('Latest task scheduler error callback failed:', callbackError);
                    }
                } else {
                    await this.#callDiscard(undefined, details);
                }
            }
        }
    }

    async #callDiscard(result, details) {
        try {
            await this.#onDiscard(result, details);
        } catch (error) {
            console.error('Latest task scheduler discard callback failed:', error);
        }
    }
}

export const ScrollPriority = Object.freeze({
    HYDRATION: 1,
    STREAMING: 2,
    EXPLICIT_JUMP: 3,
    USER_INPUT: 4,
});

/** Coordinates all programmatic scroll writers through cancellable priority tokens. */
export class ScrollCoordinator {
    #active = null;

    /**
     * Claim scroll ownership. Equal and lower priorities cannot replace current work.
     * @param {string} owner Owner label
     * @param {number} priority ScrollPriority value
     * @returns {{owner: string, priority: number, abortController: AbortController, addCleanup: (callback: Function) => void}|null}
     */
    claim(owner, priority) {
        const numericPriority = Number(priority);
        if (!owner || !Number.isFinite(numericPriority)) {
            return null;
        }
        if (this.#active && this.#active.priority >= numericPriority) {
            return null;
        }

        this.#cancelToken(this.#active);
        const abortController = new AbortController();
        const cleanups = new Set();
        const token = {
            owner: String(owner),
            priority: numericPriority,
            abortController,
            addCleanup: (callback) => {
                if (typeof callback !== 'function') {
                    return;
                }
                if (abortController.signal.aborted) {
                    callback();
                    return;
                }
                cleanups.add(callback);
            },
            _cleanups: cleanups,
        };
        this.#active = token;
        return token;
    }

    /** @param {object} token Ownership token */
    isActive(token) {
        return this.#active === token && !token?.abortController?.signal?.aborted;
    }

    /** @param {object} token Ownership token */
    release(token) {
        if (this.#active !== token) {
            return;
        }
        this.#active = null;
        this.#runCleanups(token);
    }

    /** Immediately abort non-user scroll work when a real gesture begins. */
    cancelForUserInput() {
        if (!this.#active) {
            return false;
        }
        const token = this.#active;
        this.#active = null;
        this.#cancelToken(token);
        return true;
    }

    #cancelToken(token) {
        if (!token) {
            return;
        }
        token.abortController?.abort?.();
        this.#runCleanups(token);
    }

    #runCleanups(token) {
        const cleanups = token?._cleanups;
        if (!(cleanups instanceof Set)) {
            return;
        }
        for (const cleanup of cleanups) {
            try {
                cleanup();
            } catch {
                // Cleanup must never prevent the next scroll owner from taking control.
            }
        }
        cleanups.clear();
    }
}

export const scrollCoordinator = new ScrollCoordinator();

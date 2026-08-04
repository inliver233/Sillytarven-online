/**
 * Coordinates rapid drawer switches so only the latest click may update the UI.
 */
export function getInlineDrawerDuration(contentHeight, {
    adaptive = false,
    fullDuration = 400,
    minimumDuration = 140,
} = {}) {
    if (!adaptive) {
        return undefined;
    }

    const height = Number(contentHeight);
    const maximum = Number.isFinite(fullDuration) ? Math.max(0, fullDuration) : 400;
    const minimum = Number.isFinite(minimumDuration) ? Math.min(maximum, Math.max(0, minimumDuration)) : 140;
    if (!Number.isFinite(height) || height <= 0 || maximum === 0) {
        return maximum;
    }

    return Math.min(maximum, Math.max(minimum, Math.round(90 + height * 0.55)));
}

export class DrawerSwitchCoordinator {
    #version = 0;
    #settleDeadline = 0;
    #pendingWait = null;

    constructor({
        now = () => globalThis.performance.now(),
        setTimeoutFn = (...args) => globalThis.setTimeout(...args),
        clearTimeoutFn = timeoutId => globalThis.clearTimeout(timeoutId),
    } = {}) {
        this.now = now;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
    }

    begin({ closing = false, settleMs = 0 } = {}) {
        this.#cancelPendingWait(false);
        const token = Object.freeze({ version: ++this.#version });
        if (closing) {
            const duration = Number.isFinite(settleMs) ? Math.max(0, settleMs) : 0;
            this.#settleDeadline = Math.max(this.#settleDeadline, this.now() + duration);
        }
        return token;
    }

    isActive(token) {
        return token?.version === this.#version;
    }

    waitForSettle(token, { immediate = false } = {}) {
        if (!this.isActive(token)) {
            return Promise.resolve(false);
        }
        if (immediate) {
            this.#settleDeadline = 0;
            return Promise.resolve(true);
        }

        const remaining = Math.max(0, this.#settleDeadline - this.now());
        if (remaining === 0) {
            return Promise.resolve(true);
        }

        return new Promise(resolve => {
            const timeoutId = this.setTimeoutFn(() => {
                if (this.#pendingWait?.token === token) {
                    this.#pendingWait = null;
                }
                resolve(this.isActive(token));
            }, remaining);
            this.#pendingWait = { token, timeoutId, resolve };
        });
    }

    cancel() {
        this.#cancelPendingWait(false);
        this.#settleDeadline = 0;
        this.#version++;
    }

    #cancelPendingWait(result) {
        if (!this.#pendingWait) {
            return;
        }
        this.clearTimeoutFn(this.#pendingWait.timeoutId);
        this.#pendingWait.resolve(result);
        this.#pendingWait = null;
    }
}

export const drawerSwitchCoordinator = new DrawerSwitchCoordinator();

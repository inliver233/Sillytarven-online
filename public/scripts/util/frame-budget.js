const DEFAULT_FRAME_BUDGET_MS = 8;

function getCurrentTime() {
    return globalThis.performance.now();
}

function waitForAnimationFrame() {
    return new Promise(resolve => globalThis.requestAnimationFrame(() => resolve()));
}

/**
 * Process synchronous items immediately until a frame budget is exhausted, then yield before continuing.
 * @template T
 * @param {T[]} items Items to process in order
 * @param {(item: T, index: number) => void} processItem Synchronous item processor
 * @param {object} [options] Scheduling hooks
 * @param {number} [options.frameBudgetMs=8] Maximum target work time before yielding
 * @param {() => number} [options.now] Monotonic clock
 * @param {() => Promise<void>} [options.waitForNextFrame] Frame-yield implementation
 * @param {() => boolean} [options.shouldContinue] Cancellation guard
 * @param {(details: object) => any} [options.beforeFrame] Per-frame setup hook
 * @param {(state: any, details: object) => void} [options.afterFrame] Per-frame completion hook
 * @returns {Promise<{completed: boolean, inserted: number, frames: number, maxFrameDurationMs: number, workDurationMs: number}>} Processing statistics
 */
export async function processItemsWithFrameBudget(items, processItem, {
    frameBudgetMs = DEFAULT_FRAME_BUDGET_MS,
    now = getCurrentTime,
    waitForNextFrame = waitForAnimationFrame,
    shouldContinue = () => true,
    beforeFrame = () => undefined,
    afterFrame = () => {},
} = {}) {
    if (!Array.isArray(items)) {
        throw new TypeError('Frame-budget items must be an array.');
    }
    if (typeof processItem !== 'function') {
        throw new TypeError('Frame-budget processor must be a function.');
    }
    if (items.length === 0) {
        return { completed: true, inserted: 0, frames: 0, maxFrameDurationMs: 0, workDurationMs: 0 };
    }

    const requestedBudget = Number(frameBudgetMs);
    const budget = Number.isFinite(requestedBudget) && requestedBudget > 0
        ? requestedBudget
        : DEFAULT_FRAME_BUDGET_MS;
    let inserted = 0;
    let frames = 0;
    let maxFrameDurationMs = 0;
    let workDurationMs = 0;

    while (inserted < items.length) {
        if (!shouldContinue()) {
            return { completed: false, inserted, frames, maxFrameDurationMs, workDurationMs };
        }

        const frameStartedAt = now();
        const frameNumber = frames + 1;
        const frameState = beforeFrame({ frame: frameNumber, inserted, total: items.length });
        const frameStartIndex = inserted;

        do {
            processItem(items[inserted], inserted);
            inserted++;
        } while (
            inserted < items.length
            && shouldContinue()
            && now() - frameStartedAt < budget
        );

        const frameDetails = {
            frame: frameNumber,
            frameItems: inserted - frameStartIndex,
            inserted,
            total: items.length,
        };
        afterFrame(frameState, frameDetails);
        const frameDurationMs = Math.max(0, now() - frameStartedAt);
        frames++;
        maxFrameDurationMs = Math.max(maxFrameDurationMs, frameDurationMs);
        workDurationMs += frameDurationMs;

        if (!shouldContinue()) {
            return { completed: false, inserted, frames, maxFrameDurationMs, workDurationMs };
        }
        if (inserted < items.length) {
            await waitForNextFrame();
        }
    }

    return { completed: true, inserted, frames, maxFrameDurationMs, workDurationMs };
}

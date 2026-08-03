export const SWIPE_PICKER_DOM_LIMIT = 48;

/**
 * Select a bounded contiguous swipe range for virtual rendering.
 * @param {number} totalCount Total number of swipes
 * @param {object} [options]
 * @param {number} [options.selectedIndex=0] Selected swipe index
 * @param {number|null} [options.startIndex=null] Scroll-derived first index
 * @param {number} [options.limit=SWIPE_PICKER_DOM_LIMIT] Maximum rendered blocks
 * @returns {{start: number, end: number}}
 */
export function getSwipePickerRenderWindow(totalCount, {
    selectedIndex = 0,
    startIndex = null,
    limit = SWIPE_PICKER_DOM_LIMIT,
} = {}) {
    const total = Math.max(0, Math.trunc(Number(totalCount) || 0));
    const size = Math.min(total, Math.max(1, Math.trunc(Number(limit) || SWIPE_PICKER_DOM_LIMIT)));
    if (!total) return { start: 0, end: 0 };

    const maxStart = Math.max(0, total - size);
    const selected = Math.min(total - 1, Math.max(0, Math.trunc(Number(selectedIndex) || 0)));
    const requestedStart = startIndex === null
        ? selected - Math.floor(size / 2)
        : Math.trunc(Number(startIndex) || 0);
    const start = Math.min(maxStart, Math.max(0, requestedStart));
    return { start, end: start + size };
}

/**
 * Creates an action resolver bound to the message and chat context captured when a picker opens.
 * @param {object} options
 * @param {object} options.message Captured message object
 * @param {number} options.messageId Original local message index
 * @param {number} options.absoluteMessageId Captured source-file message index
 * @param {(messageId: number) => object|null|undefined} options.getMessage
 * @param {(absoluteMessageId: number, message: object) => number|null|Promise<number|null>} options.resolveLocalMessageIndex
 * @param {() => unknown} [options.getContextIdentity]
 * @param {unknown} [options.contextIdentity]
 * @param {(messageId: number, message: object) => boolean} [options.canJumpToSwipe]
 * @param {AbortSignal} options.signal
 * @returns {(swipeId: number, options?: {requireJump?: boolean}) => Promise<object|null>}
 */
export function createSwipePickerActionResolver({
    message,
    messageId,
    absoluteMessageId,
    getMessage,
    resolveLocalMessageIndex,
    getContextIdentity,
    contextIdentity,
    canJumpToSwipe,
    signal,
}) {
    const capturedAbsoluteMessageId = Number.isSafeInteger(absoluteMessageId) && absoluteMessageId >= 0
        ? absoluteMessageId
        : null;
    const isCurrentContext = () => !signal.aborted
        && (typeof getContextIdentity !== 'function' || Object.is(getContextIdentity(), contextIdentity));

    return async (swipeId, { requireJump = false } = {}) => {
        if (!isCurrentContext() || capturedAbsoluteMessageId === null) return null;

        const resolvedMessageId = await resolveLocalMessageIndex(capturedAbsoluteMessageId, message);
        if (!isCurrentContext()
            || !Number.isSafeInteger(resolvedMessageId)
            || resolvedMessageId < 0
            || getMessage(resolvedMessageId) !== message
            || (requireJump && !canJumpToSwipe?.(resolvedMessageId, message))) {
            return null;
        }

        return {
            messageId: resolvedMessageId,
            absoluteMessageId: capturedAbsoluteMessageId,
            swipeId,
            message,
            signal,
        };
    };
}

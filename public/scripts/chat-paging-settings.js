export const CHAT_PAGE_SIZE_DEFAULT = 20;
export const CHAT_PAGE_SIZE_MAX = 1000;

/**
 * Resolves the saved "chat history messages to load" preference for paging.
 * A null result means the user selected "All" and paging must be bypassed.
 * @param {unknown} value Saved chat truncation value
 * @returns {number|null} Page size, or null when all messages should be loaded
 */
export function resolveChatPagingPageSize(value) {
    const configured = Number(value);
    if (!Number.isFinite(configured) || configured < 0) {
        return CHAT_PAGE_SIZE_DEFAULT;
    }
    if (configured === 0) {
        return null;
    }
    return Math.max(1, Math.min(Math.trunc(configured), CHAT_PAGE_SIZE_MAX));
}

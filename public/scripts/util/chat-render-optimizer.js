import { processItemsWithFrameBudget } from './frame-budget.js';

export const CHAT_RENDER_THRESHOLDS = Object.freeze({
    totalChars: 60_000,
    singleMessageChars: 12_000,
    manyMessages: 20,
    manyMessagesChars: 24_000,
    protectedTail: 4,
    refreshDelayMs: 40,
    maxHeights: 1000,
    fallbackHeight: 180,
    widthBucketSize: 80,
});

/**
 * Decide whether a chat is large enough to benefit from browser paint isolation.
 * @param {object[]} messages Chat messages
 * @returns {boolean} Whether optimization should be enabled
 */
export function shouldOptimizeChatRender(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }

    let totalChars = 0;
    let hasLargeMessage = false;
    for (const message of messages) {
        const length = String(message?.mes ?? '').length;
        totalChars += length;
        hasLargeMessage ||= length >= CHAT_RENDER_THRESHOLDS.singleMessageChars;
    }

    return totalChars >= CHAT_RENDER_THRESHOLDS.totalChars
        || hasLargeMessage
        || (messages.length >= CHAT_RENDER_THRESHOLDS.manyMessages
            && totalChars >= CHAT_RENDER_THRESHOLDS.manyMessagesChars);
}

/**
 * Build a height-cache key that cannot leak measurements across layout widths.
 * @param {string} chatId Stable chat identity
 * @param {string|number} messageId Message identifier
 * @param {number} chatWidth Current chat width
 * @param {number} layoutVersion Layout revision
 * @returns {string} Cache key
 */
export function makeChatHeightKey(chatId, messageId, chatWidth, layoutVersion) {
    const bucketSize = CHAT_RENDER_THRESHOLDS.widthBucketSize;
    const widthBucket = Math.round((Number(chatWidth) || 0) / bucketSize) * bucketSize;
    return `${chatId}:${messageId}:${widthBucket}:${layoutVersion}`;
}

function hasPendingMedia(node) {
    const images = typeof node?.querySelectorAll === 'function' ? [...node.querySelectorAll('img')] : [];
    return images.some(image => image.complete === false);
}

function isProtectedMessage(node, index, tailStartIndex, streamingActive) {
    if (index >= tailStartIndex) {
        return true;
    }

    const classList = node?.classList;
    const isEditing = typeof node?.querySelector === 'function'
        && Boolean(node.querySelector('.edit_textarea, [contenteditable="true"]'));
    const isStreaming = classList?.contains('streaming')
        || node?.dataset?.streaming === 'true'
        || (streamingActive && classList?.contains('last_mes'));
    const isHighlighted = classList?.contains('highlighted')
        || classList?.contains('search-found')
        || classList?.contains('selected')
        || node?.dataset?.scrollTarget === 'true';

    return isEditing || isStreaming || isHighlighted || hasPendingMedia(node);
}

/**
 * Keeps distant messages in the DOM while allowing the browser to skip their paint/layout work.
 */
export class ChatRenderOptimizer {
    #chatId = '';
    #chatElement = null;
    #enabled = true;
    #heightCache = new Map();
    #knownNodes = new Set();
    #layoutVersion = 1;
    #refreshTimer = null;
    #refreshVersion = 0;
    #resizeObserver = null;
    #setTimeout;
    #clearTimeout;
    #frameProcessor;
    #getViewportHeight;

    constructor({
        ResizeObserverClass = globalThis.ResizeObserver,
        setTimeoutFn = (...args) => globalThis.setTimeout(...args),
        clearTimeoutFn = (...args) => globalThis.clearTimeout(...args),
        frameProcessor = processItemsWithFrameBudget,
        getViewportHeight = () => globalThis.innerHeight || 0,
    } = {}) {
        this.#setTimeout = setTimeoutFn;
        this.#clearTimeout = clearTimeoutFn;
        this.#frameProcessor = frameProcessor;
        this.#getViewportHeight = getViewportHeight;

        if (typeof ResizeObserverClass === 'function') {
            this.#resizeObserver = new ResizeObserverClass(entries => {
                for (const entry of entries) {
                    const node = entry?.target;
                    const height = Math.round(Number(entry?.contentRect?.height) || 0);
                    if (!node || height <= 0 || !this.#chatElement) {
                        continue;
                    }
                    const messageId = node.getAttribute?.('mesid');
                    if (messageId === null || messageId === undefined) {
                        continue;
                    }
                    const key = makeChatHeightKey(
                        this.#chatId,
                        messageId,
                        this.#chatElement.clientWidth,
                        this.#layoutVersion,
                    );
                    this.#setCachedHeight(key, height);
                }
            });
        }
    }

    /** @param {boolean} enabled Runtime kill switch */
    setEnabled(enabled) {
        this.#enabled = Boolean(enabled);
        if (!this.#enabled) {
            this.dispose();
        }
    }

    /** @param {string} chatId Stable chat identity */
    setChatContext(chatId) {
        const nextChatId = String(chatId ?? '');
        if (nextChatId === this.#chatId) {
            return;
        }
        this.#cancelRefresh();
        this.#cleanupNodes();
        this.#resizeObserver?.disconnect?.();
        this.#chatElement = null;
        this.#chatId = nextChatId;
    }

    /** Clear measurements after a theme, font, width, avatar, or layout change. */
    invalidateLayout() {
        this.#layoutVersion++;
        this.#heightCache.clear();
        this.#cancelRefresh();
        this.#cleanupNodes();
        this.#resizeObserver?.disconnect?.();
    }

    /**
     * Merge repeated render notifications into one refresh.
     * @param {HTMLElement} chatElement Chat scroll container
     * @param {object[]} messages Current chat messages
     * @param {object} [options] Refresh options
     * @param {boolean} [options.streamingActive] Whether the tail is currently streaming
     */
    scheduleRefresh(chatElement, messages, options = {}) {
        this.#cancelTimer();
        const scheduledVersion = ++this.#refreshVersion;
        this.#refreshTimer = this.#setTimeout(() => {
            this.#refreshTimer = null;
            if (scheduledVersion !== this.#refreshVersion) {
                return;
            }
            void this.refresh(chatElement, messages, options);
        }, CHAT_RENDER_THRESHOLDS.refreshDelayMs);
    }

    /**
     * Refresh isolation state in read, compute, and write phases.
     * @param {HTMLElement} chatElement Chat scroll container
     * @param {object[]} messages Current chat messages
     * @param {object} [options] Refresh options
     * @param {boolean} [options.streamingActive] Whether the tail is currently streaming
     * @returns {Promise<{optimized: boolean, messages: number, culled: number, cancelled: boolean}>}
     */
    async refresh(chatElement, messages, { streamingActive = false } = {}) {
        const refreshVersion = ++this.#refreshVersion;
        this.#cancelTimer();

        if (!this.#enabled || !chatElement || !Array.isArray(messages)) {
            this.#cleanupNodes();
            return { optimized: false, messages: 0, culled: 0, cancelled: false };
        }

        this.#chatElement = chatElement;
        const nodes = typeof chatElement.querySelectorAll === 'function'
            ? [...chatElement.querySelectorAll(':scope > .mes')]
            : [];
        for (const node of nodes) {
            this.#knownNodes.add(node);
        }

        const optimize = shouldOptimizeChatRender(messages);
        if (!optimize || nodes.length === 0) {
            this.#resizeObserver?.disconnect?.();
            this.#cleanupNodes();
            return { optimized: false, messages: nodes.length, culled: 0, cancelled: false };
        }

        const chatRect = chatElement.getBoundingClientRect();
        const viewportHeight = Math.max(
            Number(this.#getViewportHeight()) || 0,
            Number(chatRect.height) || 0,
            Number(chatElement.clientHeight) || 0,
        );
        const tailStartIndex = Math.max(0, nodes.length - CHAT_RENDER_THRESHOLDS.protectedTail);
        const chatWidth = chatElement.clientWidth;
        const updates = [];
        const isCurrent = () => refreshVersion === this.#refreshVersion;

        const readResult = await this.#frameProcessor(nodes, (node, index) => {
            const protectedMessage = isProtectedMessage(node, index, tailStartIndex, streamingActive);
            const rect = node.getBoundingClientRect();
            const nearViewport = rect.bottom >= chatRect.top - viewportHeight
                && rect.top <= chatRect.bottom + viewportHeight;
            const messageId = node.getAttribute?.('mesid') ?? index;
            const key = makeChatHeightKey(this.#chatId, messageId, chatWidth, this.#layoutVersion);
            const wasCulled = node.classList?.contains('st-chat-content-culled');

            if (!wasCulled && rect.height > 0) {
                this.#setCachedHeight(key, Math.round(rect.height));
            }

            updates.push({
                node,
                cull: !protectedMessage && !nearViewport,
                observe: !protectedMessage && nearViewport,
                height: this.#heightCache.get(key) || CHAT_RENDER_THRESHOLDS.fallbackHeight,
            });
        }, {
            frameBudgetMs: 8,
            shouldContinue: isCurrent,
        });

        if (!readResult.completed || !isCurrent()) {
            return { optimized: true, messages: nodes.length, culled: 0, cancelled: true };
        }

        let culled = 0;
        const writeResult = await this.#frameProcessor(updates, ({ node, cull, observe, height }) => {
            if (cull) {
                culled++;
                node.classList?.add('st-chat-content-culled');
                node.style?.setProperty?.('--st-cull-height', `${height}px`);
                this.#resizeObserver?.unobserve?.(node);
                return;
            }

            node.classList?.remove('st-chat-content-culled');
            node.style?.removeProperty?.('--st-cull-height');
            if (observe) {
                this.#resizeObserver?.observe?.(node);
            } else {
                this.#resizeObserver?.unobserve?.(node);
            }
        }, {
            frameBudgetMs: 8,
            shouldContinue: isCurrent,
        });

        return {
            optimized: true,
            messages: nodes.length,
            culled,
            cancelled: !writeResult.completed || !isCurrent(),
        };
    }

    /** Remove observers, timers, classes, and temporary CSS properties. */
    dispose({ clearCache = false } = {}) {
        this.#cancelRefresh();
        this.#resizeObserver?.disconnect?.();
        this.#cleanupNodes();
        this.#chatElement = null;
        if (clearCache) {
            this.#heightCache.clear();
        }
    }

    /** @returns {{chatId: string, layoutVersion: number, cachedHeights: number, trackedNodes: number, enabled: boolean}} */
    getDebugState() {
        return {
            chatId: this.#chatId,
            layoutVersion: this.#layoutVersion,
            cachedHeights: this.#heightCache.size,
            trackedNodes: this.#knownNodes.size,
            enabled: this.#enabled,
        };
    }

    #setCachedHeight(key, height) {
        if (this.#heightCache.has(key)) {
            this.#heightCache.delete(key);
        }
        this.#heightCache.set(key, height);
        while (this.#heightCache.size > CHAT_RENDER_THRESHOLDS.maxHeights) {
            this.#heightCache.delete(this.#heightCache.keys().next().value);
        }
    }

    #cleanupNodes() {
        for (const node of this.#knownNodes) {
            node.classList?.remove('st-chat-content-culled');
            node.style?.removeProperty?.('--st-cull-height');
        }
        this.#knownNodes.clear();
    }

    #cancelTimer() {
        if (this.#refreshTimer !== null) {
            this.#clearTimeout(this.#refreshTimer);
            this.#refreshTimer = null;
        }
    }

    #cancelRefresh() {
        this.#cancelTimer();
        this.#refreshVersion++;
    }
}

export const chatRenderOptimizer = new ChatRenderOptimizer();

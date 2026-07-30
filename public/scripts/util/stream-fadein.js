import { morphdom } from '../../lib.js';

/**
 * Check if the current browser supports native segmentation function.
 * @returns {boolean} True if the Segmenter is supported by the current browser.
 */
export function isSegmenterSupported() {
    return typeof Intl.Segmenter === 'function';
}

/**
 * Segment text in the given HTML content using Intl.Segmenter.
 * @param {HTMLElement} htmlElement Target HTML element
 * @param {string} htmlContent HTML content to segment
 * @param {'word'|'grapheme'|'sentence'} [granularity='word'] Text split granularity
 */
export function segmentTextInElement(htmlElement, htmlContent, granularity = 'word') {
    htmlElement.innerHTML = htmlContent;

    if (!isSegmenterSupported()) {
        return;
    }

    // TODO: Support more locales, make granularity configurable.
    const segmenter = new Intl.Segmenter('en-US', { granularity });
    const textNodes = [];
    const walker = document.createTreeWalker(htmlElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = /** @type {Text} */ (walker.currentNode);

        // Skip ancestors of code/pre
        if (textNode.parentElement && textNode.parentElement.closest('pre, code')) {
            continue;
        }

        // Skip text nodes that are empty or only whitespace
        if (/^\s*$/.test(textNode.data)) {
            continue;
        }

        textNodes.push(textNode);
    }

    // Split every text node into segments using spans
    for (const textNode of textNodes) {
        const fragment = document.createDocumentFragment();
        const segments = segmenter.segment(textNode.data);
        for (const segment of segments) {
            // TODO: Apply a different class for different segment length/content?
            // For now, just use a single class for all segments.
            const span = document.createElement('span');
            span.innerText = segment.segment;
            span.className = 'text_segment';
            fragment.appendChild(span);
        }
        textNode.replaceWith(fragment);
    }
}

/**
 * Apply stream fade-in effect to the given message text element by morphing its content.
 * @param {HTMLElement} messageTextElement Message text element
 * @param {string} htmlContent New HTML content to apply
 */
export function applyStreamFadeIn(messageTextElement, htmlContent) {
    const targetElement = /** @type {HTMLElement} */ (messageTextElement.cloneNode());
    segmentTextInElement(targetElement, htmlContent);
    morphdom(messageTextElement, targetElement);
}

/**
 * 流式渲染 rAF 节流合帧器 (Apple / Google 级流畅度优化)
 *
 * 流式输出时每个 Token/Chunk 都会触发昂贵的全量 Markdown 重绘 (messageFormatting + DOM 写)，
 * 长文本后半程 CPU 占用陡增、明显掉帧。本合帧器用 requestAnimationFrame + 固定窗口节流，
 * 将渲染频率收敛到约 20 FPS（每 frameInterval ms 至多一次），并在终帧强制立即完整渲染，确保不丢字。
 *
 * 使用方式：
 *   const buf = new StreamRenderBuffer();
 *   // 每个非终帧 chunk：多次调用只保留最后一次闭包
 *   buf.schedule(() => render(latestPayload));
 *   // 终帧：丢弃未决中间帧并同步完整渲染，防止中间帧回调在终帧之后用过期文本覆盖
 *   buf.cancel(); render(finalPayload);
 *   // 停止 / 错误：立即应用最后一次缓冲状态
 *   buf.flush();
 */
export class StreamRenderBuffer {
    /**
     * @param {number} [frameInterval=50] 两次渲染之间的最小间隔（毫秒），默认 50ms（约 20 FPS）
     */
    constructor(frameInterval = 50) {
        this.frameInterval = frameInterval;
        /** @type {null | (() => void)} 最新一次 schedule 提交的渲染闭包 */
        this.pendingRender = null;
        /** @type {number | null} 待触发的 requestAnimationFrame 句柄 */
        this.rafId = null;
        /** @type {number} 上一次实际渲染的时间戳 */
        this.lastRenderTime = 0;
        // 预绑定帧回调，避免反复创建闭包
        this.onFrame = this.onFrame.bind(this);
    }

    /**
     * 提交一个渲染闭包并按窗口节流排队。多次调用只保留最后一次的闭包。
     * @param {() => void} renderFn 渲染闭包（应捕获最新的文本载荷）
     */
    schedule(renderFn) {
        this.pendingRender = renderFn;
        // 已有排队帧时仅更新闭包，等待其触发即可（合帧）
        if (this.rafId !== null) {
            return;
        }
        this.rafId = requestAnimationFrame(this.onFrame);
    }

    /**
     * rAF 帧回调：到达节流窗口则渲染最新闭包，否则重新排队。
     * @param {number} timestamp rAF 提供的高精度时间戳
     */
    onFrame(timestamp) {
        this.rafId = null;
        // 未到节流窗口，重新排队等待下一帧（pendingRender 仍保留最新闭包）
        if (timestamp - this.lastRenderTime < this.frameInterval) {
            if (this.pendingRender !== null) {
                this.rafId = requestAnimationFrame(this.onFrame);
            }
            return;
        }
        const fn = this.pendingRender;
        this.pendingRender = null;
        this.lastRenderTime = timestamp;
        if (typeof fn === 'function') {
            fn();
        }
    }

    /**
     * 立即应用当前未决的渲染闭包（取消排队帧后同步执行）。
     * 用于需要确保最后缓冲状态被渲染、且其后无进一步渲染的场景（停止 / 错误）。
     */
    flush() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        const fn = this.pendingRender;
        this.pendingRender = null;
        this.lastRenderTime = 0;
        if (typeof fn === 'function') {
            fn();
        }
    }

    /**
     * 丢弃所有未决渲染闭包并取消排队帧（不执行）。
     * 终帧路径调用本方法，防止某个排队中的中间帧回调在终帧之后触发、用过期文本覆盖终帧（丢字）。
     */
    cancel() {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.pendingRender = null;
    }
}

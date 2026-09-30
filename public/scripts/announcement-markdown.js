// 公告内容 Markdown 渲染（主站弹窗 / 登录页 / 管理后台共用）
import { DOMPurify, showdown } from '../lib.js';

/**
 * 链接标题为 "button" 时渲染为按钮样式，例如：
 *   [前往文档](https://example.com "button")
 */
const BUTTON_TITLE_PATTERN = /^\s*button\s*$/i;

let converter = null;

function getConverter() {
    if (!converter) {
        converter = new showdown.Converter({
            tables: true,
            strikethrough: true,
            tasklists: true,
            simplifiedAutoLink: true,
            excludeTrailingPunctuationFromURLs: true,
            literalMidWordUnderscores: true,
            // 与旧的纯文本公告保持一致：单个换行即换行
            simpleLineBreaks: true,
            ghCodeBlocks: true,
            requireSpaceBeforeHeadingText: true,
            emoji: true,
            noHeaderId: true,
            underline: false,
            parseImgDimensions: true,
            openLinksInNewWindow: false,
            backslashEscapesHTMLTags: true,
        });
    }
    return converter;
}

/**
 * 对净化后的 DOM 做后处理：外链新窗口打开、按钮链接、图片懒加载。
 * 不使用 DOMPurify 全局 hook，避免影响聊天消息等其他渲染路径。
 * @param {DocumentFragment} fragment
 */
function decorateFragment(fragment) {
    fragment.querySelectorAll('a[href]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('#')) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        }

        const title = link.getAttribute('title');
        if (title && BUTTON_TITLE_PATTERN.test(title)) {
            link.removeAttribute('title');
            link.classList.add('announcement-button');
        }
    });

    // 仅保留任务列表的只读复选框，避免公告里出现可输入的表单控件
    fragment.querySelectorAll('input').forEach((input) => {
        if ((input.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
            input.remove();
            return;
        }
        input.setAttribute('disabled', '');
    });

    fragment.querySelectorAll('img').forEach((image) => {
        image.setAttribute('loading', 'lazy');
        image.setAttribute('referrerpolicy', 'no-referrer');
        if (!image.hasAttribute('alt')) {
            image.setAttribute('alt', '');
        }
    });

    fragment.querySelectorAll('table').forEach((table) => {
        if (table.parentElement?.classList.contains('announcement-table-wrapper')) {
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'announcement-table-wrapper';
        table.replaceWith(wrapper);
        wrapper.appendChild(table);
    });
}

/**
 * 将公告 Markdown 渲染为已净化的 DOM 片段。
 * @param {string} markdown 公告原文
 * @returns {DocumentFragment}
 */
export function renderAnnouncementMarkdown(markdown) {
    const source = typeof markdown === 'string' ? markdown : String(markdown ?? '');
    const html = getConverter().makeHtml(source);
    const fragment = DOMPurify.sanitize(html, {
        RETURN_DOM_FRAGMENT: true,
        USE_PROFILES: { html: true },
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option'],
        FORBID_ATTR: ['id', 'name'],
    });
    decorateFragment(fragment);
    return fragment;
}

/**
 * 将公告 Markdown 渲染进指定容器（替换其原有内容）。
 * @param {Element} container 目标容器
 * @param {string} markdown 公告原文
 */
export function renderAnnouncementMarkdownInto(container, markdown) {
    if (!container) {
        return;
    }
    container.classList.add('announcement-markdown');
    container.replaceChildren(renderAnnouncementMarkdown(markdown));
}

// 公告内容 Markdown 渲染（主站弹窗 / 登录页 / 管理后台共用）
import { DOMPurify, showdown } from '../lib.js';

/**
 * 链接标题为 "button" 时渲染为按钮样式，例如：
 *   [前往文档](https://example.com "button")
 */
const BUTTON_TITLE_PATTERN = /^\s*button\s*$/i;

/**
 * 链接里的 {{user}} 在点开时换成当前用户名，例如反馈问卷：
 *   [反馈问题](https://example.com/f/report?user={{user}} "button")
 * 渲染时先留空（登录页没有用户），花括号可能已被编码。
 */
const USER_PLACEHOLDER = /\{\{user\}\}|%7B%7Buser%7D%7D/gi;

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

/** <font size> 1–7 对应的字号 */
const FONT_SIZE_STEPS = ['0.75em', '0.85em', '1em', '1.15em', '1.35em', '1.6em', '2em'];
const MIN_FONT_SIZE_EM = 0.75;
const MAX_FONT_SIZE_EM = 2;

/**
 * 把字号限制在 0.75em–2em（px 按 16px 换算），避免公告撑破弹窗。
 * @param {string} value CSS 字号
 * @returns {string} 限制后的字号，无法识别时返回空串
 */
function clampFontSize(value) {
    const match = /^(\d*\.?\d+)(px|em|rem|%)$/i.exec(String(value).trim());
    if (!match) {
        return '';
    }
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const em = unit === 'px' ? amount / 16 : unit === '%' ? amount / 100 : amount;
    const clamped = Math.min(MAX_FONT_SIZE_EM, Math.max(MIN_FONT_SIZE_EM, em));
    return `${Number(clamped.toFixed(3))}em`;
}

/**
 * 公告里的内联样式只保留文字外观（颜色、背景色、字号、粗细、斜体、下划线等），
 * 去掉定位、尺寸、浮层等可能遮挡页面的属性。
 * @param {HTMLElement} element
 */
function sanitizeInlineStyle(element) {
    const style = element.style;
    const kept = {
        color: style.color,
        'background-color': style.backgroundColor,
        'font-size': clampFontSize(style.fontSize),
        'font-weight': style.fontWeight,
        'font-style': style.fontStyle,
        'text-decoration': style.textDecorationLine && style.textDecorationLine !== 'none' ? style.textDecorationLine : '',
        'text-align': ['left', 'center', 'right'].includes(style.textAlign) ? style.textAlign : '',
    };
    element.removeAttribute('style');
    for (const [property, value] of Object.entries(kept)) {
        if (value) {
            element.style.setProperty(property, value);
        }
    }
    if (!element.getAttribute('style')) {
        element.removeAttribute('style');
    }
}

/**
 * <font color size> 换成等价的 <span>，再走同一套样式限制。
 * @param {DocumentFragment} fragment
 */
function convertFontTags(fragment) {
    fragment.querySelectorAll('font').forEach((font) => {
        const span = document.createElement('span');
        const color = font.getAttribute('color');
        if (color) {
            span.style.color = color;
        }
        const size = Number.parseInt(font.getAttribute('size') || '', 10);
        if (size >= 1 && size <= 7) {
            span.style.fontSize = FONT_SIZE_STEPS[size - 1];
        }
        span.append(...font.childNodes);
        font.replaceWith(span);
    });
}

/**
 * 对净化后的 DOM 做后处理：外链新窗口打开、按钮链接、图片懒加载。
 * 不使用 DOMPurify 全局 hook，避免影响聊天消息等其他渲染路径。
 * @param {DocumentFragment} fragment
 */
function decorateFragment(fragment) {
    convertFontTags(fragment);
    fragment.querySelectorAll('[style]').forEach((element) => {
        sanitizeInlineStyle(/** @type {HTMLElement} */ (element));
    });

    // 折叠块里 showdown 会在 <summary> 两侧留下空段落
    fragment.querySelectorAll('details p').forEach((paragraph) => {
        if (!paragraph.childNodes.length) {
            paragraph.remove();
        }
    });

    fragment.querySelectorAll('a[href]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('#')) {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        }

        const withoutUser = href.replace(USER_PLACEHOLDER, '');
        if (withoutUser !== href) {
            link.dataset.userHref = href;
            link.setAttribute('href', withoutUser);
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
    // 折叠块 <details> 里的内容也按 Markdown 解析，写公告时不用另加 markdown="1"
    const html = getConverter().makeHtml(source.replace(/<details(?![^>]*markdown=)([^>]*)>/gi, '<details markdown="1"$1>'));
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
 * 把带 {{user}} 的公告链接填上当前用户名，在链接打开前调用。
 * @param {HTMLAnchorElement} link
 * @param {string} handle
 */
export function fillAnnouncementLinkUser(link, handle) {
    const template = link.dataset.userHref;
    if (template) {
        link.setAttribute('href', template.replace(USER_PLACEHOLDER, encodeURIComponent(handle || '')));
    }
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

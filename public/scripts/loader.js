import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';

/** @type {Popup} */
let loaderPopup;
let preloaderYoinked = false;

/**
 * 动态更新载入屏进度与状态文本
 * @param {number} [percentage] 0 - 100 进度百分比（省略则只更新状态文本）
 * @param {string} [statusText] 中文状态描述（省略则保留原文本）
 */
export function updateLoaderProgress(percentage, statusText) {
    if (typeof percentage === 'number' && !Number.isNaN(percentage)) {
        const clamped = Math.min(100, Math.max(0, percentage));
        const bar = document.getElementById('st-loader-progress-bar');
        const text = document.getElementById('st-loader-progress-text');
        if (bar) bar.style.width = `${clamped}%`;
        if (text) text.textContent = `${clamped}%`;
    }

    if (statusText) {
        const status = document.getElementById('st-loader-status');
        if (status) status.textContent = statusText;
    }
}

/**
 * 显示载入屏
 * - 首屏场景：#preloader 仍在 DOM 中，确保可见即可（不重置进度，由 firstLoadInit 埋点驱动）
 * - 后续场景：#preloader 已被移除，回退到 Popup 备用加载器
 * @param {string} [statusText] 可选的状态文本（仅首屏生效）
 */
export function showLoader(statusText) {
    const preloader = document.getElementById('preloader');
    if (preloader) {
        preloader.style.display = 'flex';
        preloader.style.opacity = '1';
        preloader.style.filter = 'none';
        if (statusText) updateLoaderProgress(undefined, statusText);
        return;
    }

    // 备用 Popup 加载器 (后续加载场景)
    if (loaderPopup) loaderPopup.complete(POPUP_RESULT.CANCELLED);

    loaderPopup = new Popup(`
        <div id="loader">
            <div id="load-spinner" class="fa-solid fa-circle-notch fa-spin fa-3x"></div>
        </div>`, POPUP_TYPE.DISPLAY, null, { transparent: true, animation: 'none', wide: true, large: true });

    // 加载器不可关闭
    loaderPopup.closeButton.style.display = 'none';
    loaderPopup.show();
}

/**
 * 隐藏载入屏
 * - 首屏场景：将进度推到 100%，350ms 平滑淡出后移除 #preloader
 * - Popup 场景：直接关闭备用 Popup
 * @returns {Promise<void>}
 */
export async function hideLoader() {
    const preloader = document.getElementById('preloader');
    if (preloader) {
        updateLoaderProgress(100, '加载完成，准备就绪！');
        return new Promise((resolve) => {
            preloader.style.opacity = '0';
            preloader.style.filter = 'blur(8px)';
            setTimeout(() => {
                yoinkPreloader();
                resolve();
            }, 350);
        });
    }

    if (!loaderPopup) {
        console.warn('There is no loader showing to hide');
        return Promise.resolve();
    }

    const popup = loaderPopup;
    return new Promise((resolve) => {
        popup.complete(POPUP_RESULT.AFFIRMATIVE)
            .catch((err) => console.error('Error completing loaderPopup:', err))
            .finally(() => {
                if (loaderPopup === popup) loaderPopup = null;
                resolve();
            });
    });
}

function yoinkPreloader() {
    if (preloaderYoinked) return;
    const preloader = document.getElementById('preloader');
    if (preloader) preloader.remove();
    preloaderYoinked = true;
}

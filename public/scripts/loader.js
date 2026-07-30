// public/scripts/loader.js
import { POPUP_RESULT, POPUP_TYPE, Popup } from './popup.js';

/** @type {Popup} */
let loaderPopup;
let preloaderYoinked = false;

/**
 * 动态更新载入屏进度与状态文本
 * @param {number} [percentage] 0 - 100 进度百分比（省略则只更新状态文本，不改动进度）
 * @param {string} [statusText] 中文状态描述（省略则保留原文本）
 */
export function updateLoaderProgress(percentage, statusText) {
    // 仅在传入有效数字时更新进度，避免 undefined/NaN 破坏百分比与宽度显示
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
 * - 首屏场景：#preloader 仍在 DOM 中，确保可见并推进基础进度
 * - 后续场景：#preloader 已被移除，回退到 Popup 备用加载器
 * @param {string} [statusText] 可选的状态文本
 */
export function showLoader(statusText = '加载中...') {
    const preloader = document.getElementById('preloader');
    if (preloader) {
        preloader.style.display = 'flex';
        preloader.style.opacity = '1';
        preloader.style.filter = 'none';
        updateLoaderProgress(20, statusText);
        return;
    }

    // 备用 Popup 加载器 (后续加载场景)
    if (loaderPopup) loaderPopup.complete(POPUP_RESULT.CANCELLED);
    loaderPopup = new Popup(`
        <div id="loader">
            <div id="load-spinner" class="fa-solid fa-circle-notch fa-spin fa-2x" style="color: #3b82f6;"></div>
        </div>`, POPUP_TYPE.DISPLAY, null, { transparent: true, animation: 'none', wide: true, large: true });
    loaderPopup.closeButton.style.display = 'none';
    loaderPopup.show();
}

/**
 * 隐藏载入屏：将进度推到 100%，380ms 平滑淡出后移除 #preloader
 * @returns {Promise<void>}
 */
export async function hideLoader() {
    return new Promise((resolve) => {
        updateLoaderProgress(100, '加载完成，准备就绪！');

        const preloader = document.getElementById('preloader');
        if (preloader) {
            preloader.style.opacity = '0';
            preloader.style.filter = 'blur(12px)';

            setTimeout(() => {
                yoinkPreloader();
                resolve();
            }, 380);
            return;
        }

        if (loaderPopup) {
            loaderPopup.complete(POPUP_RESULT.AFFIRMATIVE)
                .catch((err) => console.error('Error completing loaderPopup:', err))
                .finally(() => {
                    loaderPopup = null;
                    resolve();
                });
        } else {
            resolve();
        }
    });
}

function yoinkPreloader() {
    if (preloaderYoinked) return;
    const preloader = document.getElementById('preloader');
    if (preloader) preloader.remove();
    preloaderYoinked = true;
}

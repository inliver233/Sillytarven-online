// public/scripts/loader.js
import { loader } from './action-loader.js';

/**
 * Handle for the legacy loader created by showLoader() after the first screen.
 * @type {import('./action-loader.js').ActionLoaderHandle|null}
 */
let legacyLoaderHandle = null;
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
        // index.html 里的进度推进器：阶段之间也往前走，只进不退
        const creep = globalThis.stLoaderProgress;
        const shown = creep ? Math.max(clamped, creep.shown()) : clamped;
        creep?.set(clamped);
        const bar = document.getElementById('st-loader-progress-bar');
        const text = document.getElementById('st-loader-progress-text');
        if (bar) bar.style.width = `${shown}%`;
        if (text) text.textContent = `${Math.floor(shown)}%`;
    }

    if (statusText) {
        const status = document.getElementById('st-loader-status');
        if (status) status.textContent = statusText;
    }
}

/**
 * 显示载入屏
 * - 首屏场景：#preloader 仍在 DOM 中，确保可见并推进基础进度
 * - 后续场景：#preloader 已被移除，改用 action-loader 的阻塞加载层
 *
 * @deprecated For later loads use `showActionLoader()` from action-loader.js.
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

    // Hide any existing legacy loader first to maintain old behavior
    if (legacyLoaderHandle && legacyLoaderHandle.isActive) {
        legacyLoaderHandle.hide();
    }

    // Create a blocking loader with no toast (matches old behavior)
    legacyLoaderHandle = loader.show({
        slug: 'legacy-loader',
        blocking: true,
        toastMode: loader.ToastMode.NONE,
    });
}

/**
 * 隐藏载入屏：首屏时将进度推到 100%，380ms 平滑淡出后移除 #preloader；
 * 之后隐藏 showLoader() 创建的加载层。
 *
 * @deprecated For later loads use `hideActionLoader()` or `handle.hide()` from action-loader.js.
 * @returns {Promise<void>}
 */
export async function hideLoader() {
    const preloader = document.getElementById('preloader');
    if (preloader) {
        updateLoaderProgress(100, '加载完成，准备就绪！');
        preloader.style.opacity = '0';
        preloader.style.filter = 'blur(12px)';
        await new Promise(resolve => setTimeout(resolve, 380));
        yoinkPreloader();
        return;
    }

    if (!legacyLoaderHandle || !legacyLoaderHandle.isActive) {
        return;
    }

    await legacyLoaderHandle.hide();
    legacyLoaderHandle = null;
}

function yoinkPreloader() {
    if (preloaderYoinked) return;
    const preloader = document.getElementById('preloader');
    if (preloader) preloader.remove();
    preloaderYoinked = true;
}

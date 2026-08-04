const LEGACY_CACHE_NAME = 'character-avatars-cache';
const LEGACY_MIGRATION_MARKER = 'character_avatar_http_cache_v1';
const LEGACY_STORAGE_PREFIXES = ['char_img_time_', 'char_img_cache_'];
const loadingImages = new WeakSet();

function hidePlaceholder(img, setTimeoutFn) {
    const placeholder = img.parentElement?.querySelector('.imagePlaceholder');
    if (!placeholder?.style) {
        return;
    }

    placeholder.style.opacity = '0';
    setTimeoutFn(() => {
        placeholder.style.display = 'none';
    }, 140);
}

/**
 * Load a welcome-screen avatar through the browser's private HTTP cache.
 * @param {HTMLImageElement} img Image element to load
 * @param {string} src Same-origin image URL
 * @param {object} [options] Testable scheduling dependencies
 * @param {typeof setTimeout} [options.setTimeoutFn] Placeholder transition scheduler
 * @returns {boolean} Whether this call started the image load
 */
export function loadWelcomeCharacterImage(img, src, { setTimeoutFn = (...args) => globalThis.setTimeout(...args) } = {}) {
    if (!img?.classList?.contains('lazy-load') || typeof img.addEventListener !== 'function' || !src || loadingImages.has(img)) {
        return false;
    }

    loadingImages.add(img);
    let settled = false;
    const settle = (imageReady = false) => {
        if (settled) {
            return;
        }
        settled = true;
        loadingImages.delete(img);
        img.classList.remove('lazy-load');
        if (imageReady) {
            img.classList.add?.('st-image-ready');
        }
        hidePlaceholder(img, setTimeoutFn);
    };

    const settleLoadedImage = () => {
        if (typeof img.decode !== 'function') {
            settle(true);
            return;
        }
        Promise.resolve()
            .then(() => img.decode())
            .catch(() => {})
            .finally(() => settle(true));
    };

    // Register before assigning src so a memory-cache hit cannot race the handlers.
    img.addEventListener('load', settleLoadedImage, { once: true });
    img.addEventListener('error', () => settle(false), { once: true });
    img.src = src;
    return true;
}

/**
 * Remove the legacy shared CacheStorage layer after switching to private HTTP caching.
 * @param {object} [dependencies] Browser storage dependencies
 * @param {CacheStorage} [dependencies.cacheStorage] Cache API implementation
 * @param {Storage} [dependencies.storage] Local storage implementation
 * @returns {Promise<{cacheDeleted: boolean, removedKeys: number, skipped: boolean}>} Cleanup result
 */
export async function cleanupLegacyWelcomeImageCache({
    cacheStorage = globalThis.caches,
    storage = globalThis.localStorage,
} = {}) {
    if (storage?.getItem(LEGACY_MIGRATION_MARKER) === '1') {
        return { cacheDeleted: false, removedKeys: 0, skipped: true };
    }

    const cacheDeleted = typeof cacheStorage?.delete === 'function'
        ? await cacheStorage.delete(LEGACY_CACHE_NAME)
        : false;
    let removedKeys = 0;

    if (storage) {
        const keys = [];
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key && LEGACY_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) {
                keys.push(key);
            }
        }
        for (const key of keys) {
            storage.removeItem(key);
            removedKeys++;
        }
        storage.setItem(LEGACY_MIGRATION_MARKER, '1');
    }

    return { cacheDeleted, removedKeys, skipped: false };
}

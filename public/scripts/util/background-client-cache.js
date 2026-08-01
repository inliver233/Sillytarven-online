/**
 * Clears every browser-side cache layer used by a background and optionally reloads its URLs.
 * Cleanup failures are returned so a persisted server upload is never reported as unsaved.
 * @param {string} backgroundName Canonical server background name
 * @param {object} options Cache dependencies and resource URLs
 * @returns {Promise<{cacheEntriesDeleted: number, blobRevoked: boolean, refreshed: number, failures: string[]}>}
 */
export async function invalidateBackgroundClientCache(backgroundName, {
    thumbnailStorage,
    thumbnailBlobs,
    resourcePaths = [`/backgrounds/${encodeURIComponent(backgroundName)}`],
    refresh = true,
    urlApi = globalThis.URL,
    urlConstructor = globalThis.URL,
    cacheStorage = globalThis.caches,
    fetchImpl = globalThis.fetch,
    baseUrl = globalThis.location?.href ?? 'http://localhost/',
} = {}) {
    if (typeof backgroundName !== 'string' || !backgroundName) {
        throw new TypeError('backgroundName must be a non-empty string.');
    }
    if (!Array.isArray(resourcePaths) || resourcePaths.some(resource => typeof resource !== 'string' || !resource)) {
        throw new TypeError('resourcePaths must be an array of non-empty strings.');
    }

    const failures = [];
    let blobRevoked = false;
    let cacheEntriesDeleted = 0;
    let refreshed = 0;
    try {
        await thumbnailStorage?.removeItem?.(backgroundName);
    } catch (error) {
        failures.push(`indexeddb:${error?.name || 'error'}`);
    }

    const blobUrl = thumbnailBlobs?.get?.(backgroundName);
    if (blobUrl) {
        try {
            urlApi?.revokeObjectURL?.(blobUrl);
            blobRevoked = true;
        } catch (error) {
            failures.push(`blob:${error?.name || 'error'}`);
        } finally {
            thumbnailBlobs.delete(backgroundName);
        }
    }

    const targetUrls = new Set(resourcePaths.map(resource => new urlConstructor(resource, baseUrl).href));
    if (cacheStorage?.keys && cacheStorage?.open) {
        try {
            for (const cacheName of await cacheStorage.keys()) {
                const cache = await cacheStorage.open(cacheName);
                for (const request of await cache.keys()) {
                    const requestUrl = new urlConstructor(request.url, baseUrl).href;
                    if (targetUrls.has(requestUrl) && await cache.delete(request)) {
                        cacheEntriesDeleted++;
                    }
                }
            }
        } catch (error) {
            failures.push(`cache-storage:${error?.name || 'error'}`);
        }
    }

    if (refresh && typeof fetchImpl === 'function') {
        for (const targetUrl of targetUrls) {
            try {
                const response = await fetchImpl(targetUrl, {
                    cache: 'reload',
                    credentials: 'same-origin',
                });
                if (!response?.ok) {
                    throw new Error(`HTTP ${response?.status || 0}`);
                }
                await response.arrayBuffer();
                refreshed++;
            } catch (error) {
                failures.push(`http-cache:${error?.message || error?.name || 'error'}`);
            }
        }
    }

    return { cacheEntriesDeleted, blobRevoked, refreshed, failures };
}

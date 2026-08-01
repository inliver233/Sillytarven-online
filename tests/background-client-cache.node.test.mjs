import assert from 'node:assert/strict';
import test from 'node:test';

import { invalidateBackgroundClientCache } from '../public/scripts/util/background-client-cache.js';

test('background cache invalidation clears IndexedDB, blob URLs, Cache Storage, and HTTP cache', async () => {
    const removedItems = [];
    const revokedUrls = [];
    const deletedRequests = [];
    const refreshedUrls = [];
    const thumbnailBlobs = new Map([['photo.jpg', 'blob:old-thumbnail']]);
    const requests = [
        { url: 'https://example.test/backgrounds/photo.jpg' },
        { url: 'https://example.test/thumbnail?type=bg&file=photo.jpg' },
        { url: 'https://example.test/backgrounds/other.jpg' },
    ];
    const cache = {
        async keys() { return requests; },
        async delete(request) {
            deletedRequests.push(request.url);
            return true;
        },
    };

    const result = await invalidateBackgroundClientCache('photo.jpg', {
        thumbnailStorage: { async removeItem(key) { removedItems.push(key); } },
        thumbnailBlobs,
        urlApi: { revokeObjectURL(url) { revokedUrls.push(url); } },
        cacheStorage: {
            async keys() { return ['background-cache']; },
            async open() { return cache; },
        },
        fetchImpl: async (url, options) => {
            refreshedUrls.push({ url, options });
            return { ok: true, async arrayBuffer() { return new ArrayBuffer(0); } };
        },
        baseUrl: 'https://example.test/app',
        resourcePaths: [
            '/backgrounds/photo.jpg',
            '/thumbnail?type=bg&file=photo.jpg',
        ],
    });

    assert.deepEqual(removedItems, ['photo.jpg']);
    assert.deepEqual(revokedUrls, ['blob:old-thumbnail']);
    assert.equal(thumbnailBlobs.has('photo.jpg'), false);
    assert.deepEqual(deletedRequests.sort(), [
        'https://example.test/backgrounds/photo.jpg',
        'https://example.test/thumbnail?type=bg&file=photo.jpg',
    ]);
    assert.deepEqual(refreshedUrls.map(item => item.url).sort(), deletedRequests.sort());
    assert.equal(refreshedUrls.every(item => item.options.cache === 'reload'), true);
    assert.deepEqual(result, { cacheEntriesDeleted: 2, blobRevoked: true, refreshed: 2, failures: [] });
});

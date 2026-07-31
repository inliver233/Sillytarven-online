import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cleanupLegacyWelcomeImageCache,
    loadWelcomeCharacterImage,
} from '../public/scripts/welcome-image-loader.js';

class FakeStorage {
    constructor(entries = {}) {
        this.values = new Map(Object.entries(entries));
    }

    get length() {
        return this.values.size;
    }

    key(index) {
        return [...this.values.keys()][index] ?? null;
    }

    getItem(key) {
        return this.values.get(key) ?? null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }

    removeItem(key) {
        this.values.delete(key);
    }
}

function createFakeImage(onSourceAssigned) {
    const image = new EventTarget();
    const classes = new Set(['characterImage', 'lazy-load']);
    const placeholder = { style: {} };
    image.classList = {
        contains: value => classes.has(value),
        remove: value => classes.delete(value),
    };
    image.parentElement = {
        querySelector: selector => selector === '.imagePlaceholder' ? placeholder : null,
    };
    Object.defineProperty(image, 'src', {
        set(value) {
            onSourceAssigned?.(image, value);
        },
    });
    return { image, placeholder };
}

test('welcome image loader registers handlers before assigning the direct URL', () => {
    let assignedUrl;
    const { image, placeholder } = createFakeImage((target, value) => {
        assignedUrl = value;
        target.dispatchEvent(new Event('load'));
    });
    const delays = [];

    const started = loadWelcomeCharacterImage(image, '/characters/Alice.png', {
        setTimeoutFn(callback, delay) {
            delays.push(delay);
            callback();
        },
    });

    assert.equal(started, true);
    assert.equal(assignedUrl, '/characters/Alice.png');
    assert.equal(image.classList.contains('lazy-load'), false);
    assert.equal(placeholder.style.opacity, '0');
    assert.equal(placeholder.style.display, 'none');
    assert.deepEqual(delays, [300]);
});

test('welcome image loader hides the placeholder on errors and ignores duplicate loads', () => {
    let assignments = 0;
    const { image, placeholder } = createFakeImage((target) => {
        assignments++;
        target.dispatchEvent(new Event('error'));
    });

    assert.equal(loadWelcomeCharacterImage(image, '/characters/missing.png', {
        setTimeoutFn: callback => callback(),
    }), true);
    assert.equal(loadWelcomeCharacterImage(image, '/characters/missing.png'), false);
    assert.equal(assignments, 1);
    assert.equal(placeholder.style.display, 'none');
    assert.equal(loadWelcomeCharacterImage(null, '/characters/Alice.png'), false);
    assert.equal(loadWelcomeCharacterImage(image, ''), false);
});

test('legacy welcome image cleanup deletes the shared cache and only its storage keys', async () => {
    const deletedCaches = [];
    const storage = new FakeStorage({
        'char_img_time_/characters/Alice.png': '1',
        'char_img_cache_/characters/Bob.png': 'unused',
        unrelated: 'keep',
    });

    const result = await cleanupLegacyWelcomeImageCache({
        cacheStorage: {
            async delete(name) {
                deletedCaches.push(name);
                return true;
            },
        },
        storage,
    });

    assert.deepEqual(result, { cacheDeleted: true, removedKeys: 2, skipped: false });
    assert.deepEqual(deletedCaches, ['character-avatars-cache']);
    assert.equal(storage.getItem('char_img_time_/characters/Alice.png'), null);
    assert.equal(storage.getItem('char_img_cache_/characters/Bob.png'), null);
    assert.equal(storage.getItem('unrelated'), 'keep');
    assert.equal(storage.getItem('character_avatar_http_cache_v1'), '1');
});

test('legacy welcome image cleanup is one-time and retries a failed cache deletion', async () => {
    const migratedStorage = new FakeStorage({ character_avatar_http_cache_v1: '1' });
    let deleteCalls = 0;
    const skipped = await cleanupLegacyWelcomeImageCache({
        cacheStorage: { delete: async () => { deleteCalls++; } },
        storage: migratedStorage,
    });
    assert.deepEqual(skipped, { cacheDeleted: false, removedKeys: 0, skipped: true });
    assert.equal(deleteCalls, 0);

    const retryStorage = new FakeStorage({ 'char_img_time_/characters/Alice.png': '1' });
    await assert.rejects(
        cleanupLegacyWelcomeImageCache({
            cacheStorage: { delete: async () => { throw new Error('storage unavailable'); } },
            storage: retryStorage,
        }),
        /storage unavailable/,
    );
    assert.equal(retryStorage.getItem('char_img_time_/characters/Alice.png'), '1');
    assert.equal(retryStorage.getItem('character_avatar_http_cache_v1'), null);
});

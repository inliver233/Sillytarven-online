/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectImageFormat, normalizeImageFileName } from '../src/media-validation.js';

test('detectImageFormat recognizes supported raster image signatures', () => {
    assert.deepEqual(detectImageFormat(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')), { extension: 'png', mimeType: 'image/png' });
    assert.deepEqual(detectImageFormat(Buffer.from('ffd8ffe000104a46494600', 'hex')), { extension: 'jpg', mimeType: 'image/jpeg' });
    assert.deepEqual(detectImageFormat(Buffer.from('47494638396101000100', 'hex')), { extension: 'gif', mimeType: 'image/gif' });
    assert.deepEqual(detectImageFormat(Buffer.from('52494646100000005745425056503820', 'hex')), { extension: 'webp', mimeType: 'image/webp' });
});

test('detectImageFormat rejects empty, video, and arbitrary payloads', () => {
    assert.equal(detectImageFormat(Buffer.alloc(0)), null);
    assert.equal(detectImageFormat(Buffer.from('00000018667479706d703432', 'hex')), null);
    assert.equal(detectImageFormat(Buffer.from('<script>alert(1)</script>')), null);
});

test('normalizeImageFileName uses detected content extension and preserves a safe base name', () => {
    assert.equal(normalizeImageFileName('背景图.JPG', 'png'), '背景图.png');
    assert.equal(normalizeImageFileName('scene', 'webp'), 'scene.webp');
    assert.equal(normalizeImageFileName('../../.png', 'png'), 'background.png');
    assert.throws(() => normalizeImageFileName('background.png', '../mp4'), /Unsupported image extension/);
});

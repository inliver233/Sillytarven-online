/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { detectImageFormat, ImageValidationError, normalizeImageFileName, validateImageBuffer } from '../src/media-validation.js';

const basePng = fs.readFileSync(new URL('../default/content/backgrounds/__transparent.png', import.meta.url));

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

    const longName = normalizeImageFileName(`${'界'.repeat(200)}.jpeg`, 'jpg');
    assert.ok(Buffer.byteLength(longName, 'utf8') <= 255);
    assert.match(longName, /\.jpg$/);
});

test('validateImageBuffer fully decodes a legal image and rejects truncated signature-only data', async () => {
    const valid = await validateImageBuffer(basePng, { maxPixels: 1_000_000 });
    assert.equal(valid.format.extension, 'png');
    assert.ok(valid.width > 0 && valid.height > 0);

    await assert.rejects(
        validateImageBuffer(basePng.subarray(0, 24), { maxPixels: 1_000_000 }),
        error => error instanceof ImageValidationError && error.code === 'invalid_image',
    );
});

test('validateImageBuffer rejects excessive dimensions before full image decode', async () => {
    const oversized = Buffer.from(basePng);
    oversized.writeUInt32BE(50_000, 16);
    oversized.writeUInt32BE(50_000, 20);

    await assert.rejects(
        validateImageBuffer(oversized, { maxPixels: 100_000_000 }),
        error => error instanceof ImageValidationError && error.code === 'image_pixel_limit_exceeded' && error.status === 413,
    );
});

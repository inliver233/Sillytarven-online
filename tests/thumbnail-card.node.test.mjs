import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import sizeOf from 'image-size';
import sharp from 'sharp';

import '../src/fetch-patch.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
const { generateThumbnail, invalidateThumbnail } = await import('../src/endpoints/thumbnails.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-thumbnail-card-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
fs.mkdirSync(directories.characters, { recursive: true });

test('the welcome screen gets a card-sized thumbnail instead of the full character image', async () => {
    const pixels = Buffer.alloc(1200 * 1800 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) >>> 24;
    await sharp(pixels, { raw: { width: 1200, height: 1800, channels: 3 } }).png().toFile(path.join(directories.characters, 'Seraphina.png'));

    const card = await generateThumbnail(directories, 'card', 'Seraphina.png');
    assert.equal(card.path, path.join(directories.thumbnailsCard, 'Seraphina.png'));
    const buffer = fs.readFileSync(card.path);
    assert.deepEqual([sizeOf(buffer).width, sizeOf(buffer).height, sizeOf(buffer).type], [360, 540, 'jpg']);

    // Editing the character's image drops both of its thumbnails.
    const avatar = await generateThumbnail(directories, 'avatar', 'Seraphina.png');
    assert.ok(fs.existsSync(avatar.path));
    invalidateThumbnail(directories, 'avatar', 'Seraphina.png');
    assert.equal(fs.existsSync(avatar.path), false);
    assert.equal(fs.existsSync(card.path), false);
});

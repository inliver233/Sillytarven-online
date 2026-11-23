import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import sharp from 'sharp';

import '../src/fetch-patch.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
const { generateThumbnail } = await import('../src/endpoints/thumbnails.js');
const { Jimp, JimpMime } = await import('../src/jimp.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-jimp-png-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, value]) => [key, path.join(root, value)]));
fs.mkdirSync(directories.characters, { recursive: true });

const pixels = Buffer.alloc(600 * 900 * 3);
for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) >>> 24;
const image = await sharp(pixels, { raw: { width: 600, height: 900, channels: 3 } }).png().toBuffer();
/**
 * Puts a tEXt chunk right after IHDR, before the image data, as many card tools do.
 * @param {Buffer} png PNG file
 * @param {string} keyword Chunk keyword
 * @param {string} text Chunk text (latin1)
 * @returns {Buffer} PNG file with the chunk
 */
function withLeadingText(png, keyword, text) {
    const data = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(text, 'latin1')]);
    const typed = Buffer.concat([Buffer.from('tEXt', 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    const afterIhdr = 8 + 25;
    return Buffer.concat([png.subarray(0, afterIhdr), length, typed, crc, png.subarray(afterIhdr)]);
}

// A card with a big lorebook: its text chunk (base64 JSON) is well over 1 MB
const card = withLeadingText(image, 'chara', Buffer.from(JSON.stringify({ name: 'Big', description: '世界书条目，'.repeat(150_000) })).toString('base64'));

test('a character card with a text chunk over 1 MB decodes, again and again', async () => {
    assert.ok(card.length > 2_000_000, `card is ${card.length} bytes`);
    for (let round = 0; round < 20; round++) {
        const decoded = await Jimp.fromBuffer(card);
        assert.deepEqual([decoded.bitmap.width, decoded.bitmap.height], [600, 900]);
    }
    const plain = await Jimp.fromBuffer(image);
    const reencoded = await Jimp.fromBuffer(await plain.getBuffer(JimpMime.png));
    assert.deepEqual([reencoded.bitmap.width, reencoded.bitmap.height], [600, 900]);
});

test('such a card gets its thumbnail', async () => {
    fs.writeFileSync(path.join(directories.characters, 'Big.png'), card);
    const thumbnail = await generateThumbnail(directories, 'avatar', 'Big.png');
    assert.ok(thumbnail.path && fs.existsSync(thumbnail.path));
});

test('PNG does not go through the WASM codec that breaks on such cards', () => {
    const source = fs.readFileSync(new URL('../src/jimp.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import .*@jimp\/wasm-png/m);
    assert.match(source, /^import png from '@jimp\/js-png';/m);
});

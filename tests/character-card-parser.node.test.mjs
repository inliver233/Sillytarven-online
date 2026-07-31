/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import { read, write } from '../src/character-card-parser.js';
import encode from '../src/png/encode.js';

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));

function replaceCharacterTextChunks(image, chunksToAdd) {
    const chunks = extract(new Uint8Array(image)).filter((chunk) => {
        if (!['tEXt', 'zTXt', 'iTXt'].includes(chunk.name)) return true;
        if (chunk.name !== 'tEXt') return false;
        const decoded = PNGtext.decode(chunk.data);
        return !['chara', 'ccv3'].includes(decoded.keyword.toLowerCase());
    });
    chunks.splice(-1, 0, ...chunksToAdd);
    return Buffer.from(encode(chunks));
}

function makeCompressedTextChunk(keyword, text) {
    return {
        name: 'zTXt',
        data: Buffer.concat([
            Buffer.from(keyword, 'latin1'),
            Buffer.from([0, 0]),
            deflateSync(Buffer.from(text, 'latin1')),
        ]),
    };
}

function makeInternationalTextChunk(keyword, text, compressed = false) {
    return {
        name: 'iTXt',
        data: Buffer.concat([
            Buffer.from(keyword, 'latin1'),
            Buffer.from([0, compressed ? 1 : 0, 0, 0, 0]),
            compressed ? deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8'),
        ]),
    };
}

test('PNG reader falls back to valid chara metadata when ccv3 is malformed', () => {
    const validCard = JSON.stringify({ name: 'Fallback Card', data: { name: 'Fallback Card' } });
    const image = replaceCharacterTextChunks(basePng, [
        PNGtext.encode('chara', Buffer.from(validCard).toString('base64')),
        PNGtext.encode('ccv3', Buffer.from('{not valid json').toString('base64')),
    ]);

    assert.equal(JSON.parse(read(image)).name, 'Fallback Card');
});

test('PNG reader supports compressed zTXt character metadata', () => {
    const validCard = JSON.stringify({ name: 'Compressed Card' });
    const encodedCard = Buffer.from(validCard).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeCompressedTextChunk('chara', encodedCard)]);

    assert.equal(JSON.parse(read(image)).name, 'Compressed Card');
});

test('PNG reader supports UTF-8 iTXt character metadata', () => {
    const validCard = JSON.stringify({ name: '国际化角色卡' });
    const encodedCard = Buffer.from(validCard).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeInternationalTextChunk('chara', encodedCard)]);

    assert.equal(JSON.parse(read(image)).name, '国际化角色卡');
});

test('PNG reader supports compressed UTF-8 iTXt character metadata', () => {
    const validCard = JSON.stringify({ name: 'Compressed International Card' });
    const encodedCard = Buffer.from(validCard).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeInternationalTextChunk('chara', encodedCard, true)]);

    assert.equal(JSON.parse(read(image)).name, 'Compressed International Card');
});

test('PNG reader rejects ordinary images without character metadata', () => {
    assert.throws(() => read(basePng), /character metadata|PNG metadata/i);
});

test('PNG writer replaces character metadata in all supported text chunk formats', () => {
    const oldCard = Buffer.from(JSON.stringify({ name: 'Old Card' })).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeInternationalTextChunk('chara', oldCard)]);
    const rewritten = write(image, JSON.stringify({ name: 'New Card' }));

    assert.equal(JSON.parse(read(rewritten)).name, 'New Card');
});

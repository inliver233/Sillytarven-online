/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import { CharacterCardPngError, read, write } from '../src/character-card-parser.js';
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

function makeV1Card(name) {
    return {
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: 'Hello',
        mes_example: '',
    };
}

function makeV3Card(name) {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: { name },
    };
}

test('PNG reader falls back to valid chara metadata when ccv3 is malformed', () => {
    const validCard = JSON.stringify(makeV1Card('Fallback Card'));
    const image = replaceCharacterTextChunks(basePng, [
        PNGtext.encode('chara', Buffer.from(validCard).toString('base64')),
        PNGtext.encode('ccv3', Buffer.from('{not valid json').toString('base64')),
    ]);

    assert.equal(JSON.parse(read(image)).name, 'Fallback Card');
});

test('PNG reader falls back when ccv3 is JSON but fails the V3 schema', () => {
    const validCard = JSON.stringify(makeV1Card('Schema Fallback Card'));
    const image = replaceCharacterTextChunks(basePng, [
        PNGtext.encode('chara', Buffer.from(validCard).toString('base64')),
        PNGtext.encode('ccv3', Buffer.from('{}').toString('base64')),
    ]);

    assert.equal(JSON.parse(read(image)).name, 'Schema Fallback Card');
});

test('PNG reader supports compressed zTXt character metadata', () => {
    const validCard = JSON.stringify(makeV1Card('Compressed Card'));
    const encodedCard = Buffer.from(validCard).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeCompressedTextChunk('chara', encodedCard)]);

    assert.equal(JSON.parse(read(image)).name, 'Compressed Card');
});

test('PNG reader supports UTF-8 iTXt character metadata', () => {
    const validCard = JSON.stringify(makeV1Card('国际化角色卡'));
    const encodedCard = Buffer.from(validCard).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeInternationalTextChunk('chara', encodedCard)]);

    assert.equal(JSON.parse(read(image)).name, '国际化角色卡');
});

test('PNG reader supports compressed UTF-8 iTXt character metadata', () => {
    const validCard = JSON.stringify(makeV1Card('Compressed International Card'));
    const encodedCard = Buffer.from(validCard).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeInternationalTextChunk('chara', encodedCard, true)]);

    assert.equal(JSON.parse(read(image)).name, 'Compressed International Card');
});

test('PNG reader rejects ordinary images without character metadata', () => {
    assert.throws(() => read(basePng), /character metadata|PNG metadata/i);
});

test('PNG writer replaces character metadata in all supported text chunk formats', () => {
    const oldCard = Buffer.from(JSON.stringify(makeV1Card('Old Card'))).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [makeInternationalTextChunk('chara', oldCard)]);
    const rewritten = write(image, JSON.stringify(makeV1Card('New Card')));

    assert.equal(JSON.parse(read(rewritten)).name, 'New Card');
});

test('PNG reader enforces one compressed metadata chunk output limit', () => {
    const card = JSON.stringify(makeV1Card(`Large ${'x'.repeat(512)}`));
    const image = replaceCharacterTextChunks(basePng, [
        makeCompressedTextChunk('chara', Buffer.from(card).toString('base64')),
    ]);

    assert.throws(
        () => read(image, { maxChunkBytes: 128, maxMetadataBytes: 1024, maxMetadataChunks: 4 }),
        error => error instanceof CharacterCardPngError && error.code === 'metadata_limit_exceeded',
    );
});

test('PNG reader enforces cumulative metadata output and character chunk count', () => {
    const validCard = Buffer.from(JSON.stringify(makeV1Card('Budgeted Card'))).toString('base64');
    const chunks = [
        makeCompressedTextChunk('ccv3', 'x'.repeat(120)),
        makeCompressedTextChunk('ccv3', 'y'.repeat(120)),
        makeCompressedTextChunk('ccv3', 'z'.repeat(120)),
        PNGtext.encode('chara', validCard),
    ];
    const image = replaceCharacterTextChunks(basePng, chunks);

    assert.throws(
        () => read(image, { maxChunkBytes: 200, maxMetadataBytes: 250, maxMetadataChunks: 8 }),
        error => error instanceof CharacterCardPngError && error.code === 'metadata_limit_exceeded',
    );
    assert.throws(
        () => read(image, { maxChunkBytes: 200, maxMetadataBytes: 1000, maxMetadataChunks: 3 }),
        error => error instanceof CharacterCardPngError && error.code === 'metadata_chunk_limit_exceeded',
    );
});

test('PNG reader stops after a valid preferred V3 candidate', () => {
    const validV3 = Buffer.from(JSON.stringify(makeV3Card('Preferred V3'))).toString('base64');
    const image = replaceCharacterTextChunks(basePng, [
        PNGtext.encode('ccv3', validV3),
        makeCompressedTextChunk('ccv3', 'x'.repeat(1_000)),
        PNGtext.encode('chara', Buffer.from(JSON.stringify(makeV1Card('Fallback'))).toString('base64')),
    ]);

    assert.equal(JSON.parse(read(image, {
        maxChunkBytes: 256,
        maxMetadataBytes: 512,
        maxMetadataChunks: 4,
    })).data.name, 'Preferred V3');
});

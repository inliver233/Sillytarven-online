/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import archiver from 'archiver';

import { ArchiveReadError } from '../src/bounded-zip.js';
import { ByafParser } from '../src/byaf.js';
import { CharXParser } from '../src/charx.js';

async function createZip(entries) {
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const completed = new Promise((resolve, reject) => {
        output.once('end', resolve);
        output.once('error', reject);
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.once('error', error => output.destroy(error));
    archive.pipe(output);
    for (const [name, contents] of Object.entries(entries)) archive.append(contents, { name });
    await archive.finalize();
    await completed;
    return Buffer.concat(chunks);
}

const baseLimits = {
    maxEntries: 16,
    maxEntryBytes: 4096,
    maxTotalBytes: 8192,
    maxCompressionRatio: 200,
};

test('CharX parser uses cumulative archive limits before parsing card data', async () => {
    const archive = await createZip({
        'card.json': JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Bounded' } }),
        'assets/one.bin': Buffer.alloc(80, 1),
        'assets/two.bin': Buffer.alloc(80, 2),
    });
    await assert.rejects(
        new CharXParser(archive, { ...baseLimits, maxTotalBytes: 128 }).parse(),
        error => error instanceof ArchiveReadError && error.code === 'archive_size_limit_exceeded',
    );
});

test('BYAF parser rejects a high-ratio archive before manifest extraction', async () => {
    const archive = await createZip({
        'manifest.json': '{}',
        'bomb.bin': Buffer.alloc(10_000, 0),
    });
    await assert.rejects(
        new ByafParser(archive, {
            ...baseLimits,
            maxEntryBytes: 20_000,
            maxTotalBytes: 20_000,
            maxCompressionRatio: 5,
        }).parse(),
        error => error instanceof ArchiveReadError && error.code === 'archive_compression_ratio_exceeded',
    );
});

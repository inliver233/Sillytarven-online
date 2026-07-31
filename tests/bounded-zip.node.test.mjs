/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import archiver from 'archiver';

import { ArchiveReadError, extractZipArchive, normalizeArchiveEntryPath } from '../src/bounded-zip.js';

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
    const archiveEntries = Array.isArray(entries) ? entries : Object.entries(entries);
    for (const [name, contents] of archiveEntries) {
        archive.append(contents, { name });
    }
    await archive.finalize();
    await completed;
    return Buffer.concat(chunks);
}

const limits = {
    maxEntries: 8,
    maxEntryBytes: 1024,
    maxTotalBytes: 2048,
    maxCompressionRatio: 100,
};

test('bounded ZIP reader extracts a legal archive once', async () => {
    const archive = await createZip({
        'card.json': '{"name":"Small"}',
        'assets/icon.txt': 'icon',
    });

    const files = await extractZipArchive(archive, limits);
    assert.equal(files.get('card.json').toString(), '{"name":"Small"}');
    assert.equal(files.get('assets/icon.txt').toString(), 'icon');
});

test('bounded ZIP reader rejects too many central-directory entries', async () => {
    const archive = await createZip({ '1.txt': '1', '2.txt': '2', '3.txt': '3' });
    await assert.rejects(
        extractZipArchive(archive, { ...limits, maxEntries: 2 }),
        error => error instanceof ArchiveReadError && error.code === 'archive_entry_limit_exceeded' && error.status === 413,
    );
});

test('bounded ZIP reader rejects one oversized entry before extraction', async () => {
    const archive = await createZip({ 'large.bin': Buffer.alloc(65, 1) });
    await assert.rejects(
        extractZipArchive(archive, { ...limits, maxEntryBytes: 64 }),
        error => error instanceof ArchiveReadError && error.code === 'archive_entry_too_large' && error.status === 413,
    );
});

test('bounded ZIP reader rejects cumulative uncompressed output', async () => {
    const archive = await createZip({ 'one.bin': Buffer.alloc(40, 1), 'two.bin': Buffer.alloc(40, 2) });
    await assert.rejects(
        extractZipArchive(archive, { ...limits, maxTotalBytes: 64 }),
        error => error instanceof ArchiveReadError && error.code === 'archive_size_limit_exceeded' && error.status === 413,
    );
});

test('bounded ZIP reader enforces actual streamed bytes when the central directory lies', async () => {
    const archive = await createZip({ 'lying.bin': Buffer.alloc(128, 7) });
    const centralDirectory = archive.indexOf(Buffer.from([0x50, 0x4B, 0x01, 0x02]));
    assert.ok(centralDirectory >= 0);
    archive.writeUInt32LE(1, centralDirectory + 24);

    await assert.rejects(
        extractZipArchive(archive, { ...limits, maxEntryBytes: 64, maxTotalBytes: 64 }),
        error => error instanceof ArchiveReadError && error.code === 'archive_entry_too_large' && error.status === 413,
    );
});

test('bounded ZIP reader rejects an excessive compression ratio', async () => {
    const archive = await createZip({ 'bomb.bin': Buffer.alloc(10_000, 0) });
    await assert.rejects(
        extractZipArchive(archive, { ...limits, maxEntryBytes: 20_000, maxTotalBytes: 20_000, maxCompressionRatio: 5 }),
        error => error instanceof ArchiveReadError && error.code === 'archive_compression_ratio_exceeded' && error.status === 413,
    );
});

test('bounded ZIP reader rejects unsafe and duplicate normalized paths', async () => {
    assert.equal(normalizeArchiveEntryPath('../card.json'), null);
    assert.equal(normalizeArchiveEntryPath('/absolute/card.json'), null);
    assert.equal(normalizeArchiveEntryPath('C:/card.json'), null);

    const duplicate = await createZip([
        ['card.json', '{}'],
        ['card.json', '{"other":true}'],
    ]);
    await assert.rejects(
        extractZipArchive(duplicate, limits),
        error => error instanceof ArchiveReadError && error.code === 'invalid_archive' && error.status === 400,
    );
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { promises as fsPromises } from 'node:fs';

import { calculateDirectorySize } from '../src/storage-quota.js';

function fsError(code) {
    return Object.assign(new Error(code), { code });
}

async function withMockedFs({ readdir, stat }, callback) {
    const originalReaddir = fsPromises.readdir;
    const originalStat = fsPromises.stat;

    fsPromises.readdir = readdir ?? originalReaddir;
    fsPromises.stat = stat ?? originalStat;

    try {
        await callback();
    } finally {
        fsPromises.readdir = originalReaddir;
        fsPromises.stat = originalStat;
    }
}

test('calculateDirectorySize returns zero when the directory disappears before readdir', async () => {
    await withMockedFs({
        readdir: async () => { throw fsError('ENOENT'); },
    }, async () => {
        assert.equal(await calculateDirectorySize('missing-root'), 0);
    });
});

test('calculateDirectorySize skips a vanished entry and continues counting siblings', async () => {
    const root = 'quota-root';

    await withMockedFs({
        readdir: async () => ['vanished', 'kept'],
        stat: async (itemPath) => {
            if (itemPath === path.join(root, 'vanished')) {
                throw fsError('ENOENT');
            }

            return { isDirectory: () => false, size: 7 };
        },
    }, async () => {
        assert.equal(await calculateDirectorySize(root), 7);
    });
});

test('calculateDirectorySize skips a directory that disappears during recursion', async () => {
    const root = 'quota-root';
    const vanishedDirectory = path.join(root, 'vanished-directory');

    await withMockedFs({
        readdir: async (dirPath) => {
            if (dirPath === vanishedDirectory) {
                throw fsError('ENOENT');
            }

            return ['vanished-directory', 'kept'];
        },
        stat: async (itemPath) => ({
            isDirectory: () => itemPath === vanishedDirectory,
            size: itemPath === path.join(root, 'kept') ? 9 : 0,
        }),
    }, async () => {
        assert.equal(await calculateDirectorySize(root), 9);
    });
});

test('calculateDirectorySize throws non-ENOENT readdir errors', async () => {
    const expected = fsError('EACCES');

    await withMockedFs({
        readdir: async () => { throw expected; },
    }, async () => {
        await assert.rejects(calculateDirectorySize('quota-root'), error => error === expected);
    });
});

test('calculateDirectorySize throws non-ENOENT entry errors (EACCES) instead of returning a partial size', async () => {
    const root = 'quota-root';
    const expected = fsError('EACCES');

    await withMockedFs({
        readdir: async () => ['counted-first', 'unreadable'],
        stat: async (itemPath) => {
            if (itemPath === path.join(root, 'unreadable')) {
                throw expected;
            }

            return { isDirectory: () => false, size: 13 };
        },
    }, async () => {
        await assert.rejects(calculateDirectorySize(root), error => error === expected);
    });
});

test('calculateDirectorySize throws non-ENOENT entry errors (EPERM) instead of returning a partial size', async () => {
    const root = 'quota-root';
    const expected = fsError('EPERM');

    await withMockedFs({
        readdir: async () => ['counted-first', 'unreadable'],
        stat: async (itemPath) => {
            if (itemPath === path.join(root, 'unreadable')) {
                throw expected;
            }

            return { isDirectory: () => false, size: 13 };
        },
    }, async () => {
        await assert.rejects(calculateDirectorySize(root), error => error === expected);
    });
});

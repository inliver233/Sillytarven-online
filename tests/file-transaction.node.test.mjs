/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileTransaction } from '../src/file-transaction.js';

test('file transaction reports final persisted delta and commits replacements', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-'));
    const root = path.join(parent, 'user');
    const character = path.join(root, 'characters', 'Card.png');
    const oldAsset = path.join(root, 'characters', 'Card', 'happy.jpg');
    const newAsset = path.join(root, 'characters', 'Card', 'happy.png');
    await fs.promises.mkdir(path.dirname(oldAsset), { recursive: true });
    await fs.promises.writeFile(character, Buffer.alloc(10, 1));
    await fs.promises.writeFile(oldAsset, Buffer.alloc(6, 2));

    const transaction = new FileTransaction(root);
    try {
        await transaction.stageFile(character, Buffer.alloc(15, 3));
        await transaction.stageFile(newAsset, Buffer.alloc(4, 4));
        transaction.removeFile(oldAsset);

        assert.equal(await transaction.getAdditionalBytes(), 3);
        await transaction.commit();
        assert.deepEqual(await fs.promises.readFile(character), Buffer.alloc(15, 3));
        assert.deepEqual(await fs.promises.readFile(newAsset), Buffer.alloc(4, 4));
        assert.equal(fs.existsSync(oldAsset), false);
    } finally {
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

test('file transaction restores every old file after a mid-commit failure', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-rollback-'));
    const root = path.join(parent, 'user');
    const character = path.join(root, 'characters', 'Card.png');
    const asset = path.join(root, 'backgrounds', 'Card_bg.png');
    const newChat = path.join(root, 'chats', 'Card', 'new.jsonl');
    await Promise.all([
        fs.promises.mkdir(path.dirname(character), { recursive: true }),
        fs.promises.mkdir(path.dirname(asset), { recursive: true }),
    ]);
    const oldCharacter = Buffer.from('old character');
    const oldAsset = Buffer.from('old background');
    await fs.promises.writeFile(character, oldCharacter);
    await fs.promises.writeFile(asset, oldAsset);

    const transaction = new FileTransaction(root, {
        beforeApply: ({ index }) => {
            if (index === 1) throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' });
        },
    });
    try {
        await transaction.stageFile(character, Buffer.from('new character'));
        await transaction.stageFile(asset, Buffer.from('new background'));
        await transaction.stageFile(newChat, Buffer.from('{"message":"new"}'));

        await assert.rejects(transaction.commit(), error => error.code === 'ENOSPC');
        assert.deepEqual(await fs.promises.readFile(character), oldCharacter);
        assert.deepEqual(await fs.promises.readFile(asset), oldAsset);
        assert.equal(fs.existsSync(newChat), false);
    } finally {
        await transaction.dispose();
        const stagingParent = path.join(parent, '.import-staging');
        if (fs.existsSync(stagingParent)) {
            assert.deepEqual(await fs.promises.readdir(stagingParent), []);
        }
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

test('file transaction rejects targets outside the user root', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-path-'));
    const root = path.join(parent, 'user');
    const transaction = new FileTransaction(root);
    try {
        await assert.rejects(transaction.stageFile(path.join(parent, 'outside.txt'), 'nope'), /outside transaction root/i);
        assert.throws(() => transaction.removeFile(path.join(parent, 'outside.txt')), /outside transaction root/i);
    } finally {
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

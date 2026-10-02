import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';

import { RestoreUploadError, RestoreUploadManager } from '../src/chat-restore-uploads.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-restore-uploads-'));
const managers = [];
after(() => {
    managers.forEach(manager => manager.destroy());
    fs.rmSync(root, { recursive: true, force: true });
});

function createManager(limits = {}) {
    const manager = new RestoreUploadManager({
        directory: path.join(root, crypto.randomUUID()),
        maxFileBytes: 1024 * 1024,
        limits: { chunkBytes: 100, minFreeBytes: 0, ...limits },
    });
    managers.push(manager);
    return manager;
}

const send = (manager, handle, id, data, offset) => manager.writeChunk(handle, id, offset, data.length, Readable.from([data]));
const files = manager => fs.readdirSync(manager.directory);
const waitFor = async (check) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check());
};

test('chunks are assembled in order, retried chunks are accepted, and the file is removed after the restore', async () => {
    const manager = createManager();
    const data = crypto.randomBytes(250);
    const { id, chunkBytes } = await manager.start('alice', data.length);
    assert.equal(chunkBytes, 100);

    assert.deepEqual(await send(manager, 'alice', id, data.subarray(0, 100), 0), { received: 100 });
    assert.deepEqual(await send(manager, 'alice', id, data.subarray(0, 100), 0), { received: 100 }, 'a retried chunk is fine');
    await assert.rejects(send(manager, 'alice', id, data.subarray(200), 200), { code: 'chunk_out_of_order', details: { received: 100 } });
    await assert.rejects(send(manager, 'alice', id, crypto.randomBytes(101), 100), { code: 'invalid_chunk' });
    await assert.rejects(manager.writeChunk('alice', id, 100, 100, Readable.from([data.subarray(100, 150)])), { code: 'invalid_chunk' }, 'a cut-off chunk does not count');
    assert.equal(manager.status('alice', id).received, 100);
    assert.throws(() => manager.get('bob', id), { code: 'restore_upload_not_found' }, 'other users cannot see it');
    assert.throws(() => manager.finish('alice', id, async () => ({})), { code: 'upload_incomplete' });

    await send(manager, 'alice', id, data.subarray(100, 200), 100);
    await send(manager, 'alice', id, data.subarray(200), 200);
    let restored = null;
    let settled = 0;
    const status = manager.finish('alice', id, async filePath => {
        restored = fs.readFileSync(filePath);
        return { chats: 1 };
    }, () => settled++);
    assert.ok(['queued', 'restoring'].includes(status.state));
    await waitFor(() => manager.status('alice', id).state === 'done');
    assert.deepEqual(restored, data);
    assert.deepEqual(manager.status('alice', id).summary, { chats: 1 });
    await waitFor(() => files(manager).length === 0);
    assert.equal(settled, 1);
});

test('restores beyond the limit wait their turn, and cancelling a waiting one cleans it up', async () => {
    const manager = createManager({ maxConcurrentRestores: 1 });
    const release = [];
    const uploaded = async handle => {
        const { id } = await manager.start(handle, 30);
        await send(manager, handle, id, crypto.randomBytes(30), 0);
        return id;
    };
    const run = () => new Promise(resolve => release.push(() => resolve({})));
    const first = await uploaded('a');
    const second = await uploaded('b');
    const third = await uploaded('c');
    let settledThird = 0;
    manager.finish('a', first, run);
    assert.equal(manager.finish('b', second, run).queuePosition, 1);
    assert.equal(manager.finish('c', third, run, () => settledThird++).queuePosition, 2);
    await assert.rejects(manager.start('a', 30), { code: 'restore_in_progress' });

    await manager.cancel('c', third);
    assert.equal(settledThird, 1, 'the cancelled restore releases what it held');
    assert.throws(() => manager.status('c', third), { code: 'restore_upload_not_found' });
    await assert.rejects(manager.cancel('a', first), { code: 'restore_in_progress' });

    await waitFor(() => release.length === 1);
    release[0]();
    await waitFor(() => manager.status('b', second).state === 'restoring');
    release[1]();
    await waitFor(() => manager.status('b', second).state === 'done');
    await waitFor(() => files(manager).length === 0);
});

test('a failed restore reports its reason and still removes the file', async () => {
    const manager = createManager();
    const { id } = await manager.start('alice', 30);
    await send(manager, 'alice', id, crypto.randomBytes(30), 0);
    manager.finish('alice', id, async () => {
        throw new RestoreUploadError(400, 'no_chat_data', '压缩包中没有找到可恢复的对话数据');
    });
    await waitFor(() => manager.status('alice', id).state === 'failed');
    assert.deepEqual(manager.status('alice', id).error, { status: 400, code: 'no_chat_data', message: '压缩包中没有找到可恢复的对话数据' });
    await waitFor(() => files(manager).length === 0);
});

test('abandoned, replaced and leftover uploads do not keep using disk space', async () => {
    const manager = createManager({ idleMs: 1000, maxActiveUploads: 2 });
    const first = await manager.start('alice', 30);
    await send(manager, 'alice', first.id, crypto.randomBytes(10), 0);
    const second = await manager.start('alice', 30);
    assert.throws(() => manager.status('alice', first.id), { code: 'restore_upload_not_found' }, 'a new upload replaces the unfinished one');
    assert.deepEqual(files(manager), [`${second.id}.zip`]);

    await manager.start('bob', 30);
    await assert.rejects(manager.start('carol', 30), { status: 429, code: 'restore_busy' });
    await assert.rejects(manager.start('carol', 2 * 1024 * 1024), { code: 'upload_file_too_large' });

    await manager.cleanup(Date.now() + 2000);
    assert.deepEqual(files(manager), [], 'stalled uploads are dropped');
    await manager.start('carol', 30);

    fs.writeFileSync(path.join(manager.directory, 'leftover.zip'), 'x');
    const restarted = new RestoreUploadManager({ directory: manager.directory, maxFileBytes: 1024 });
    managers.push(restarted);
    assert.deepEqual(files(restarted), [], 'files from before a restart are removed');
});

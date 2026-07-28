import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { getIpFromRequest, getRealIpFromHeader } from '../src/express-common.js';
import { UserBackupManager } from '../src/user-backup-manager.js';

async function waitForBackup(manager, id, requester) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const job = manager.getStatus(id, requester, false);
        if (job && !['queued', 'running'].includes(job.status)) {
            return job;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for backup test job');
}

test('trusted client IP uses Express trust-proxy result and normalizes mapped IPv4', () => {
    assert.equal(getIpFromRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), '127.0.0.1');
    assert.equal(getRealIpFromHeader({ ip: '203.0.113.9', socket: { remoteAddress: '127.0.0.1' } }), '203.0.113.9');
    assert.equal(getRealIpFromHeader({ ip: 'not-an-ip', socket: { remoteAddress: '127.0.0.1' } }), 'unknown');
});

test('disk-backed backup job produces an authorized downloadable ZIP', async () => {
    const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-backup-test-'));
    const source = path.join(testRoot, 'source');
    const exportsDirectory = path.join(testRoot, 'exports');
    await fs.promises.mkdir(path.join(source, 'nested'), { recursive: true });
    await fs.promises.writeFile(path.join(source, 'settings.json'), '{"ok":true}');
    await fs.promises.writeFile(path.join(source, 'nested', 'chat.jsonl'), '{"mes":"hello"}\n');

    const manager = new UserBackupManager({
        directory: exportsDirectory,
        retentionMs: 60_000,
        maxConcurrent: 1,
    });

    try {
        const started = await manager.startJob({
            handle: 'backup-test-user',
            requestedBy: 'backup-test-user',
            rootPath: source,
        });
        const completed = await waitForBackup(manager, started.id, 'backup-test-user');
        assert.equal(completed.status, 'ready');

        const download = manager.getDownload(started.id, 'backup-test-user', false);
        assert.ok(download);
        assert.ok(download.size > 0);
        assert.equal(manager.getDownload(started.id, 'another-user', false), null);

        const signature = await fs.promises.readFile(download.filePath);
        assert.equal(signature.subarray(0, 2).toString('ascii'), 'PK');

        const app = express();
        app.get('/download/:id', (request, response) => {
            const authorized = manager.getDownload(request.params.id, 'backup-test-user', false);
            if (!authorized) {
                return response.sendStatus(404);
            }
            return response.download(authorized.filePath, authorized.filename, {
                acceptRanges: true,
                cacheControl: false,
            });
        });
        const server = await new Promise((resolve, reject) => {
            const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
            listener.once('error', reject);
        });
        try {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            const rangeResponse = await fetch(`http://127.0.0.1:${address.port}/download/${started.id}`, {
                headers: { Range: 'bytes=0-1' },
            });
            assert.equal(rangeResponse.status, 206);
            assert.match(rangeResponse.headers.get('content-range') || '', /^bytes 0-1\/\d+$/);
            assert.equal(Buffer.from(await rangeResponse.arrayBuffer()).toString('ascii'), 'PK');
        } finally {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    } finally {
        await manager.destroy();
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
});

test('backup cleanup removes expired orphaned exports without touching managed jobs', async () => {
    const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-backup-cleanup-'));
    const source = path.join(testRoot, 'source');
    const exportsDirectory = path.join(testRoot, 'exports');
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.writeFile(path.join(source, 'settings.json'), '{"ok":true}');

    const manager = new UserBackupManager({
        directory: exportsDirectory,
        retentionMs: 1_000,
        maxConcurrent: 1,
    });

    try {
        const orphan = path.join(exportsDirectory, 'expired.zip');
        await fs.promises.writeFile(orphan, 'expired');
        const expiredAt = new Date(Date.now() - 5_000);
        await fs.promises.utimes(orphan, expiredAt, expiredAt);

        const started = await manager.startJob({
            handle: 'cleanup-test-user',
            requestedBy: 'cleanup-test-user',
            rootPath: source,
        });
        const completed = await waitForBackup(manager, started.id, 'cleanup-test-user');
        assert.equal(completed.status, 'ready');
        const managedDownload = manager.getDownload(started.id, 'cleanup-test-user', false);
        assert.ok(managedDownload);

        await manager.cleanupOrphanedFiles();
        assert.equal(fs.existsSync(orphan), false);
        assert.equal(fs.existsSync(managedDownload.filePath), true);
    } finally {
        await manager.destroy();
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
});

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

test('backups no job knows about (left by a restart) are deleted after an hour, known ones after the retention time', async () => {
    const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-backup-orphans-'));
    const source = path.join(testRoot, 'source');
    const exportsDirectory = path.join(testRoot, 'exports');
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.writeFile(path.join(source, 'settings.json'), '{"ok":true}');
    await fs.promises.mkdir(exportsDirectory, { recursive: true });
    const setAge = async (file, ms) => {
        const at = new Date(Date.now() - ms);
        await fs.promises.utimes(file, at, at);
    };

    // Left by a previous run: unreachable, so an hour is enough; a newer one may still
    // belong to a server being replaced by a hot reload.
    const oldOrphan = path.join(exportsDirectory, 'old.zip');
    const newOrphan = path.join(exportsDirectory, 'new.zip');
    await fs.promises.writeFile(oldOrphan, 'x');
    await fs.promises.writeFile(newOrphan, 'x');
    await setAge(oldOrphan, 61 * 60 * 1000);
    await setAge(newOrphan, 30 * 60 * 1000);

    const manager = new UserBackupManager({ directory: exportsDirectory, maxConcurrent: 1 });
    try {
        await manager.cleanupOrphanedFiles();
        assert.equal(fs.existsSync(oldOrphan), false);
        assert.equal(fs.existsSync(newOrphan), true);

        const started = await manager.startJob({ handle: 'orphan-test', requestedBy: 'orphan-test', rootPath: source });
        const completed = await waitForBackup(manager, started.id, 'orphan-test');
        const { filePath } = manager.getDownload(started.id, 'orphan-test', false);
        await setAge(filePath, 2 * 60 * 60 * 1000);
        await manager.cleanupOrphanedFiles();
        assert.equal(fs.existsSync(filePath), true, 'a known backup stays for the retention time');
        assert.equal(completed.expiresAt - completed.updatedAt, 12 * 60 * 60 * 1000);
    } finally {
        await manager.destroy();
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
});

test('a finished backup can still be downloaded after a restart, and goes away with its record', async () => {
    const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-backup-persist-'));
    const source = path.join(testRoot, 'source');
    const exportsDirectory = path.join(testRoot, 'exports');
    await fs.promises.mkdir(source, { recursive: true });
    await fs.promises.writeFile(path.join(source, 'settings.json'), '{"ok":true}');
    const managers = [];
    const create = () => {
        const manager = new UserBackupManager({ directory: exportsDirectory, maxConcurrent: 1 });
        managers.push(manager);
        return manager;
    };
    const backup = async (manager, handle) => {
        const started = await manager.startJob({ handle, requestedBy: handle, rootPath: source });
        await waitForBackup(manager, started.id, handle);
        return started.id;
    };

    try {
        const first = create();
        const sameTime = create(); // e.g. the server starting next to it in a hot reload
        const id = await backup(first, 'persist-user');
        const record = path.join(exportsDirectory, `${id}.json`);
        assert.ok(fs.existsSync(record));
        assert.ok(fs.statSync(record).size < 1024, 'the record is tiny');

        // Another process finds it on demand; a restarted one loads it at startup.
        assert.ok(sameTime.getDownload(id, 'persist-user', false));
        const restarted = create();
        assert.equal(restarted.getStatus(id, 'persist-user', false).status, 'ready');
        assert.equal(restarted.getDownload(id, 'other-user', false), null, 'only its owner may download it');
        assert.equal(restarted.describeJobs().stored.files, 1);

        // A new backup for the same user replaces the old one on disk.
        const newer = await backup(restarted, 'persist-user');
        assert.equal(fs.existsSync(path.join(exportsDirectory, `${id}.zip`)), false);
        assert.equal(fs.existsSync(record), false);

        // Expired: archive and record are removed together.
        const newerRecord = path.join(exportsDirectory, `${newer}.json`);
        const data = JSON.parse(fs.readFileSync(newerRecord, 'utf8'));
        fs.writeFileSync(newerRecord, JSON.stringify({ ...data, readyAt: Date.now() - 13 * 60 * 60 * 1000 }));
        const later = create();
        assert.equal(later.getDownload(newer, 'persist-user', false), null);
        assert.equal(fs.existsSync(path.join(exportsDirectory, `${newer}.zip`)), false);
        assert.equal(fs.existsSync(newerRecord), false);
    } finally {
        for (const manager of managers) await manager.destroy();
        await fs.promises.rm(testRoot, { recursive: true, force: true });
    }
});

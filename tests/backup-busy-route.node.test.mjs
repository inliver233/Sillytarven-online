import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import storage from 'node-persist';

test('a busy server is not counted as a failed backup', async t => {
    const previousDataRoot = globalThis.DATA_ROOT;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-backup-busy-'));
    globalThis.DATA_ROOT = dataRoot;
    await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0 });
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.resolve('config.yaml'));
    const [{ router }, users, limits, { BackupJobError, UserBackupManager }, monitorModule] = await Promise.all([
        import('../src/endpoints/users-private.js'),
        import('../src/users.js'),
        import('../src/backup-limits.js'),
        import('../src/user-backup-manager.js'),
        import('../src/system-monitor.js'),
    ]);
    const handle = 'busy-user';
    await storage.setItem(users.toKey(handle), { handle, name: handle, admin: false, enabled: true, created: 1 });
    const directories = users.getUserDirectories(handle);
    fs.mkdirSync(directories.root, { recursive: true });

    // Both server-wide backup slots are taken.
    const startJob = UserBackupManager.prototype.startJob;
    UserBackupManager.prototype.startJob = async () => {
        throw new BackupJobError('BACKUP_BUSY', '服务器正在处理其他备份，请稍后重试');
    };

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = { profile: { handle, admin: false }, directories };
        next();
    });
    app.use('/api/users', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    t.after(async () => {
        UserBackupManager.prototype.startJob = startJob;
        limits.resetBackupFailuresForTests();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        monitorModule.default.destroy();
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    for (let i = 0; i < limits.BACKUP_FAILURE_LIMIT + 2; i++) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/users/backup/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ handle }),
        });
        assert.equal(response.status, 429);
        assert.equal((await response.json()).code, 'BACKUP_BUSY', `attempt ${i + 1}`);
    }
});

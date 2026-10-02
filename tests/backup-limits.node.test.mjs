import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-backup-limits-'));
globalThis.DATA_ROOT = root;

const limits = await import('../src/backup-limits.js');
const user = { handle: 'limits-user', admin: false };

after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
    limits.resetBackupFailuresForTests();
    await limits.saveBackupLimitPolicy({ full: { mode: 'limited', perDay: 2 }, partial: { mode: 'unlimited', perDay: 10 } });
});

function usedToday(kind) {
    return limits.getBackupQuotaStatus(user)[kind].used;
}

test('failed exports give their quota back, but repeated failures are throttled', async () => {
    const before = usedToday('full');
    for (let i = 0; i < limits.BACKUP_FAILURE_LIMIT; i++) {
        const quota = await limits.consumeBackupQuota(user, 'full');
        await quota.release();
    }
    assert.equal(usedToday('full'), before, 'failures do not use up the daily quota');

    await assert.rejects(limits.consumeBackupQuota(user, 'full'), error => {
        assert.equal(error.code, 'backup_retry_throttled');
        assert.match(error.message, /全量备份最近失败次数过多，请约 \d+ 分钟后再试/);
        return true;
    });
    // Each kind is throttled separately.
    const partial = await limits.consumeBackupQuota(user, 'partial');
    await partial.release({ failed: false });
});

test('joining a running backup and successful exports are not failures', async () => {
    for (let i = 0; i < limits.BACKUP_FAILURE_LIMIT + 2; i++) {
        const quota = await limits.consumeBackupQuota(user, 'partial');
        await quota.release({ failed: false });
    }
    const quota = await limits.consumeBackupQuota(user, 'partial');
    await quota.release({ failed: false });
    await quota.release(); // releasing twice has no effect
    await limits.consumeBackupQuota(user, 'partial');
});

test('the throttle lifts once old failures leave the window, and admins are never throttled', async () => {
    for (let i = 0; i < limits.BACKUP_FAILURE_LIMIT; i++) {
        await (await limits.consumeBackupQuota(user, 'full')).release();
    }
    await assert.rejects(limits.consumeBackupQuota(user, 'full'), { code: 'backup_retry_throttled' });
    await limits.consumeBackupQuota({ handle: 'admin-user', admin: true }, 'full');

    const realNow = Date.now;
    Date.now = () => realNow() + limits.BACKUP_FAILURE_WINDOW_MS + 1000;
    try {
        const quota = await limits.consumeBackupQuota(user, 'full');
        await quota.release();
    } finally {
        Date.now = realNow;
    }
});

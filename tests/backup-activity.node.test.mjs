import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-backup-activity-'));
globalThis.DATA_ROOT = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { getBackupActivitySummary, recordBackupActivity, registerBackupLiveSource } = await import('../src/backup-activity.js');
const { getLocalDateKey } = await import('../src/storage-quota.js');
const directory = path.join(root, '_global', 'backup-activity');
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('the admin summary shows outcomes, sizes and downloads per kind and per user', async () => {
    recordBackupActivity({ id: 'job-1', u: 'alice', k: 'full', s: 'ok', b: 1000, ms: 1200 });
    recordBackupActivity({ id: 'job-2', u: 'alice', k: 'full', s: 'failed', r: '备份生成失败' });
    recordBackupActivity({ u: 'bob', k: 'partial', s: 'ok', b: 300 });
    recordBackupActivity({ u: 'bob', k: 'partial', s: 'rejected', r: '今日批量导出次数已用完' });
    recordBackupActivity({ u: 'carol', a: true, k: 'restore', s: 'ok', b: 5000 });
    recordBackupActivity({ id: 'job-1', u: 'alice', k: 'full', s: 'downloaded' });
    recordBackupActivity({ id: 'job-1', u: 'alice', k: 'full', s: 'downloaded' });
    await settle();
    registerBackupLiveSource(() => [{ kind: 'full', handle: 'dave', state: 'running', processedBytes: 1, archiveBytes: 1 }]);
    registerBackupLiveSource(() => { throw new Error('broken source'); });

    const summary = getBackupActivitySummary();
    assert.equal(summary.date, getLocalDateKey());
    assert.deepEqual(summary.totals.full, { ok: 1, failed: 1, cancelled: 0, rejected: 0, bytes: 1000, downloaded: 1 });
    assert.deepEqual(summary.totals.partial, { ok: 1, failed: 0, cancelled: 0, rejected: 1, bytes: 300, downloaded: 0 });
    assert.equal(summary.totals.restore.bytes, 5000);
    assert.equal(summary.totals.users, 3);
    assert.deepEqual(summary.users.map(user => [user.handle, user.bytes, user.admin]), [['carol', 5000, true], ['alice', 1000, false], ['bob', 300, false]]);
    assert.equal(summary.recent.length, 5, 'downloads mark their backup instead of being listed');
    assert.equal(summary.recent.find(event => event.status === 'ok' && event.kind === 'full').downloaded, true);
    assert.equal(summary.recent.find(event => event.status === 'failed').reason, '备份生成失败');
    assert.deepEqual(summary.live.map(item => item.handle), ['dave'], 'a failing live source does not break the summary');
});

test('days are kept separately, and days older than two weeks are deleted', async () => {
    fs.writeFileSync(path.join(directory, '2000-01-01.jsonl'), '{"t":1,"u":"old","k":"full","s":"ok","b":1}\n');
    fs.writeFileSync(path.join(directory, '2099-01-01.jsonl'), '{"t":1,"u":"z","k":"full","s":"ok","b":7}\nnot json\n');
    assert.equal(getBackupActivitySummary('2099-01-01').totals.full.bytes, 7, 'a broken line is skipped');
    assert.equal(getBackupActivitySummary('../../etc/passwd').date, getLocalDateKey(), 'only real dates are read');

    // Pruning runs once per day, on the first record of that day.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    recordBackupActivity({ t: tomorrow.getTime(), u: 'alice', k: 'full', s: 'ok' });
    await settle();
    assert.ok(!fs.existsSync(path.join(directory, '2000-01-01.jsonl')));
    assert.ok(fs.existsSync(path.join(directory, `${getLocalDateKey()}.jsonl`)));
});

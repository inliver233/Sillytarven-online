/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hashCanonicalJson } from '../src/canonical-hash.js';
import {
    ensureFileTransactionRecovery,
    getFileTransactionNamespace,
} from '../src/file-transaction.js';

const childPath = fileURLToPath(new URL('./fixtures/file-transaction-crash-child.mjs', import.meta.url));
let sequence = 0;

async function createFixture(label) {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sillytavern-file-tx-crash-${label}-`));
    const root = path.join(parent, 'user');
    const handle = `${label}-${sequence++}`;
    const first = path.join(root, 'characters', 'First.png');
    const second = path.join(root, 'backgrounds', 'Second.png');
    const created = path.join(root, 'chats', 'Created.jsonl');
    await Promise.all([
        fs.promises.mkdir(path.dirname(first), { recursive: true }),
        fs.promises.mkdir(path.dirname(second), { recursive: true }),
    ]);
    await fs.promises.writeFile(first, 'old-first');
    await fs.promises.writeFile(second, 'old-second');
    return { parent, root, handle, first, second, created };
}

function crash(fixture, point) {
    const result = spawnSync(process.execPath, [childPath, fixture.root, fixture.handle, point], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert.equal(result.status, 86, result.stderr || result.stdout || `signal=${result.signal}`);
}

async function retainedTransaction(fixture) {
    const namespace = getFileTransactionNamespace(fixture.root, fixture.handle);
    const entries = await fs.promises.readdir(namespace);
    assert.equal(entries.length, 1);
    return { namespace, directory: path.join(namespace, entries[0]) };
}

async function assertCommittedState(fixture) {
    assert.equal(await fs.promises.readFile(fixture.first, 'utf8'), 'new-first');
    assert.equal(await fs.promises.readFile(fixture.second, 'utf8'), 'new-second');
    assert.equal(await fs.promises.readFile(fixture.created, 'utf8'), 'new-created');
}

async function assertOldState(fixture) {
    assert.equal(await fs.promises.readFile(fixture.first, 'utf8'), 'old-first');
    assert.equal(await fs.promises.readFile(fixture.second, 'utf8'), 'old-second');
    assert.equal(fs.existsSync(fixture.created), false);
}

for (const point of ['after-first-backup', 'after-first-apply']) {
    test(`recovery restores the exact old files after a child crash ${point}`, async () => {
        const fixture = await createFixture(point);
        try {
            crash(fixture, point);
            const retained = await retainedTransaction(fixture);
            const manifest = JSON.parse(await fs.promises.readFile(path.join(retained.directory, 'manifest.json'), 'utf8'));
            assert.equal(manifest.state, point === 'after-first-backup' ? 'backing-up' : 'applying');

            assert.deepEqual(await ensureFileTransactionRecovery(fixture.root, fixture.handle), { restored: 1, cleaned: 0 });
            await assertOldState(fixture);
            assert.deepEqual(await fs.promises.readdir(retained.namespace), []);
        } finally {
            await fs.promises.rm(fixture.parent, { recursive: true, force: true });
        }
    });
}

for (const point of ['after-first-backup', 'after-first-apply']) {
    test(`recovery rejects and retains a manifestless ${point === 'after-first-backup' ? 'backing-up' : 'applying'} transaction`, async () => {
        const fixture = await createFixture(`manifestless-${point}`);
        try {
            crash(fixture, point);
            const retained = await retainedTransaction(fixture);
            await fs.promises.rm(path.join(retained.directory, 'manifest.json'));

            await assert.rejects(
                ensureFileTransactionRecovery(fixture.root, fixture.handle),
                /manifest is missing/i,
            );
            assert.equal(fs.existsSync(retained.directory), true);
        } finally {
            await fs.promises.rm(fixture.parent, { recursive: true, force: true });
        }
    });
}

test('recovery preserves committed files and removes only the durable journal', async () => {
    const fixture = await createFixture('committed');
    try {
        crash(fixture, 'after-commit');
        const retained = await retainedTransaction(fixture);
        const manifest = JSON.parse(await fs.promises.readFile(path.join(retained.directory, 'manifest.json'), 'utf8'));
        assert.equal(manifest.state, 'committed');

        assert.deepEqual(await ensureFileTransactionRecovery(fixture.root, fixture.handle), { restored: 0, cleaned: 1 });
        await assertCommittedState(fixture);
        assert.deepEqual(await fs.promises.readdir(retained.namespace), []);
    } finally {
        await fs.promises.rm(fixture.parent, { recursive: true, force: true });
    }
});

for (const [point, missingDirectory] of [
    ['after-commit-missing-backup', 'backup'],
    ['after-commit-missing-new', 'new'],
]) {
    test(`recovery cleans a committed journal with a missing ${missingDirectory} directory`, async () => {
        const fixture = await createFixture(point);
        try {
            crash(fixture, point);
            const retained = await retainedTransaction(fixture);
            assert.equal(fs.existsSync(path.join(retained.directory, missingDirectory)), false);

            assert.deepEqual(await ensureFileTransactionRecovery(fixture.root, fixture.handle), { restored: 0, cleaned: 1 });
            await assertCommittedState(fixture);
            assert.deepEqual(await fs.promises.readdir(retained.namespace), []);
        } finally {
            await fs.promises.rm(fixture.parent, { recursive: true, force: true });
        }
    });
}

test('recovery rejects a tampered committed manifest before inspecting missing artifact directories', async () => {
    const fixture = await createFixture('tampered-terminal');
    try {
        crash(fixture, 'after-commit-missing-backup');
        const retained = await retainedTransaction(fixture);
        const manifestPath = path.join(retained.directory, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        manifest.operations[0].target = 'characters/Tampered.png';
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));

        await assert.rejects(
            ensureFileTransactionRecovery(fixture.root, fixture.handle),
            /tampered|invalid/i,
        );
        assert.equal((await fs.promises.readdir(retained.namespace)).length, 1);
        await assertCommittedState(fixture);
    } finally {
        await fs.promises.rm(fixture.parent, { recursive: true, force: true });
    }
});

test('recovery namespaces isolate handles sharing the same user root', async () => {
    const fixture = await createFixture('isolation');
    try {
        crash(fixture, 'after-first-backup');
        const retained = await retainedTransaction(fixture);
        const otherNamespace = getFileTransactionNamespace(fixture.root, 'different-authenticated-user');
        assert.notEqual(retained.namespace, otherNamespace);
        assert.deepEqual(await ensureFileTransactionRecovery(fixture.root, 'different-authenticated-user'), { restored: 0, cleaned: 0 });
        assert.equal(fs.existsSync(fixture.first), false);
        assert.equal((await fs.promises.readdir(retained.namespace)).length, 1);

        assert.deepEqual(await ensureFileTransactionRecovery(fixture.root, fixture.handle), { restored: 1, cleaned: 0 });
        await assertOldState(fixture);
    } finally {
        await fs.promises.rm(fixture.parent, { recursive: true, force: true });
    }
});

test('recovery rejects a manifest whose signed contents were tampered with', async () => {
    const fixture = await createFixture('tamper');
    try {
        crash(fixture, 'after-first-backup');
        const retained = await retainedTransaction(fixture);
        const manifestPath = path.join(retained.directory, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        manifest.operations[0].target = 'characters/Tampered.png';
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));

        await assert.rejects(
            ensureFileTransactionRecovery(fixture.root, fixture.handle),
            /tampered|invalid/i,
        );
        assert.equal((await fs.promises.readdir(retained.namespace)).length, 1);
    } finally {
        await fs.promises.rm(fixture.parent, { recursive: true, force: true });
    }
});

test('recovery rejects a re-signed root-relative path traversal before mutation', async () => {
    const fixture = await createFixture('path');
    try {
        crash(fixture, 'after-first-backup');
        const retained = await retainedTransaction(fixture);
        const manifestPath = path.join(retained.directory, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        delete manifest.digest;
        manifest.operations[0].target = '../outside.txt';
        await fs.promises.writeFile(manifestPath, JSON.stringify({
            ...manifest,
            digest: hashCanonicalJson(manifest),
        }));

        await assert.rejects(
            ensureFileTransactionRecovery(fixture.root, fixture.handle),
            /invalid target path|escapes/i,
        );
        assert.equal(fs.existsSync(path.join(fixture.parent, 'outside.txt')), false);
        assert.equal((await fs.promises.readdir(retained.namespace)).length, 1);
    } finally {
        await fs.promises.rm(fixture.parent, { recursive: true, force: true });
    }
});

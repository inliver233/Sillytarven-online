/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node test runner uses assert and platform-dependent symlink support. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashCanonicalJson } from '../src/canonical-hash.js';
import {
    FileTransaction,
    ensureFileTransactionRecovery,
    getFileTransactionNamespace,
} from '../src/file-transaction.js';

async function retainedCleanup(namespace) {
    const entries = await fs.promises.readdir(namespace);
    const cleanupName = entries.find(entry => entry.startsWith('cleanup-') && !entry.endsWith('.terminal'));
    assert.ok(cleanupName);
    assert.ok(entries.includes(`${cleanupName}.terminal`));
    return {
        cleanupName,
        cleanupPath: path.join(namespace, cleanupName),
        markerPath: path.join(namespace, `${cleanupName}.terminal`),
    };
}

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

test('file transaction retains a retryable journal when immediate rollback fails', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-rollback-retry-'));
    const root = path.join(parent, 'user');
    const target = path.join(root, 'characters', 'Card.png');
    const handle = 'rollback-retry-user';
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'old-card');
    const transaction = new FileTransaction(root, {
        handle,
        beforeApply: async () => {
            await fs.promises.mkdir(target);
            throw Object.assign(new Error('simulated apply failure'), { code: 'EIO' });
        },
    });
    try {
        await transaction.stageFile(target, 'new-card');
        await assert.rejects(transaction.commit(), error => error.code === 'TRANSACTION_ROLLBACK_FAILED');
        const namespace = getFileTransactionNamespace(root, handle);
        assert.equal((await fs.promises.readdir(namespace)).length, 1);

        await fs.promises.rmdir(target);
        assert.deepEqual(await ensureFileTransactionRecovery(root, handle), { restored: 1, cleaned: 0 });
        assert.equal(await fs.promises.readFile(target, 'utf8'), 'old-card');
        assert.deepEqual(await fs.promises.readdir(namespace), []);
    } finally {
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

test('committed cleanup failure resolves and retains a recoverable cleanup tombstone', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-commit-cleanup-'));
    const root = path.join(parent, 'user');
    const target = path.join(root, 'characters', 'Card.png');
    const handle = 'commit-cleanup-user';
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'old-card');
    const transaction = new FileTransaction(root, { handle });
    const originalRm = fs.promises.rm;
    const originalWarn = console.warn;
    const warnings = [];
    try {
        await transaction.stageFile(target, 'new-card');
        fs.promises.rm = async (filePath, options) => {
            if (path.basename(filePath).startsWith('cleanup-')) {
                throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' });
            }
            return await originalRm(filePath, options);
        };
        console.warn = (...args) => warnings.push(args);
        await transaction.commit();
        fs.promises.rm = originalRm;
        console.warn = originalWarn;

        assert.equal(await fs.promises.readFile(target, 'utf8'), 'new-card');
        assert.equal(warnings.length, 1);
        const namespace = getFileTransactionNamespace(root, handle);
        const { cleanupName, cleanupPath } = await retainedCleanup(namespace);
        assert.match(cleanupName, /^cleanup-tx-[A-Za-z0-9]{6}-committed-[a-f0-9]{64}-/);
        const manifest = JSON.parse(await fs.promises.readFile(path.join(cleanupPath, 'manifest.json'), 'utf8'));
        assert.equal(manifest.state, 'committed');

        assert.deepEqual(await ensureFileTransactionRecovery(root, handle), { restored: 0, cleaned: 1 });
        assert.deepEqual(await fs.promises.readdir(namespace), []);
    } finally {
        fs.promises.rm = originalRm;
        console.warn = originalWarn;
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

test('rolled-back cleanup recovery does not require staged or backup directories', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-rolledback-cleanup-'));
    const root = path.join(parent, 'user');
    const target = path.join(root, 'characters', 'Card.png');
    const handle = 'rolledback-cleanup-user';
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'old-card');
    const transaction = new FileTransaction(root, {
        handle,
        beforeApply: () => {
            throw Object.assign(new Error('simulated apply failure'), { code: 'EIO' });
        },
    });
    const originalRm = fs.promises.rm;
    try {
        await transaction.stageFile(target, 'new-card');
        fs.promises.rm = async (filePath, options) => {
            if (path.basename(filePath).startsWith('cleanup-')) {
                throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' });
            }
            return await originalRm(filePath, options);
        };
        await assert.rejects(transaction.commit(), error => error.code === 'TRANSACTION_CLEANUP_FAILED');
        fs.promises.rm = originalRm;

        const namespace = getFileTransactionNamespace(root, handle);
        const { cleanupPath } = await retainedCleanup(namespace);
        const manifest = JSON.parse(await fs.promises.readFile(path.join(cleanupPath, 'manifest.json'), 'utf8'));
        assert.equal(manifest.state, 'rolledback');
        await Promise.all([
            fs.promises.rm(path.join(cleanupPath, 'new'), { recursive: true }),
            fs.promises.rm(path.join(cleanupPath, 'backup'), { recursive: true }),
        ]);

        assert.deepEqual(await ensureFileTransactionRecovery(root, handle), { restored: 0, cleaned: 1 });
        assert.equal(await fs.promises.readFile(target, 'utf8'), 'old-card');
        assert.deepEqual(await fs.promises.readdir(namespace), []);
    } finally {
        fs.promises.rm = originalRm;
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

for (const missingArtifact of ['new', 'backup', 'manifest.json']) {
    test(`discarded cleanup recovery survives partial deletion of ${missingArtifact}`, async () => {
        const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sillytavern-file-tx-discarded-${missingArtifact.replace('.', '-')}-`));
        const root = path.join(parent, 'user');
        const target = path.join(root, 'characters', 'Card.png');
        const handle = `discarded-${missingArtifact}`;
        await fs.promises.mkdir(root);
        const transaction = new FileTransaction(root, { handle });
        const originalRm = fs.promises.rm;
        try {
            await transaction.stageFile(target, 'new-card');
            fs.promises.rm = async (filePath, options) => {
                if (path.basename(filePath).startsWith('cleanup-')) {
                    await originalRm(path.join(filePath, missingArtifact), { recursive: true, force: true });
                    throw Object.assign(new Error('simulated partial cleanup failure'), { code: 'EIO' });
                }
                return await originalRm(filePath, options);
            };
            await assert.rejects(transaction.dispose(), error => error.code === 'EIO');
            fs.promises.rm = originalRm;

            const namespace = getFileTransactionNamespace(root, handle);
            const { cleanupName, cleanupPath } = await retainedCleanup(namespace);
            assert.match(cleanupName, /^cleanup-tx-[A-Za-z0-9]{6}-discarded-[a-f0-9]{64}-/);
            assert.equal(fs.existsSync(path.join(cleanupPath, missingArtifact)), false);

            assert.deepEqual(await ensureFileTransactionRecovery(root, handle), { restored: 0, cleaned: 1 });
            assert.equal(fs.existsSync(target), false);
            assert.deepEqual(await fs.promises.readdir(namespace), []);
        } finally {
            fs.promises.rm = originalRm;
            await fs.promises.rm(parent, { recursive: true, force: true });
        }
    });
}

test('discarded cleanup recovery rejects a tampered durable terminal marker', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-discarded-tamper-'));
    const root = path.join(parent, 'user');
    const target = path.join(root, 'characters', 'Card.png');
    const handle = 'discarded-tamper';
    await fs.promises.mkdir(root);
    const transaction = new FileTransaction(root, { handle });
    const originalRm = fs.promises.rm;
    try {
        await transaction.stageFile(target, 'new-card');
        fs.promises.rm = async (filePath, options) => {
            if (path.basename(filePath).startsWith('cleanup-')) {
                await originalRm(path.join(filePath, 'manifest.json'), { force: true });
                throw Object.assign(new Error('simulated partial cleanup failure'), { code: 'EIO' });
            }
            return await originalRm(filePath, options);
        };
        await assert.rejects(transaction.dispose(), error => error.code === 'EIO');
        fs.promises.rm = originalRm;

        const namespace = getFileTransactionNamespace(root, handle);
        const { markerPath } = await retainedCleanup(namespace);
        const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
        marker.state = 'committed';
        await fs.promises.writeFile(markerPath, JSON.stringify(marker));

        await assert.rejects(ensureFileTransactionRecovery(root, handle), /invalid|tampered/i);
        assert.equal((await fs.promises.readdir(namespace)).length, 2);
        assert.equal(fs.existsSync(target), false);
    } finally {
        fs.promises.rm = originalRm;
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

for (const manifestVariant of ['nonterminal', 'malformed']) {
    test(`cleanup recovery rejects a present ${manifestVariant} manifest`, async () => {
        const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sillytavern-file-tx-cleanup-${manifestVariant}-`));
        const root = path.join(parent, 'user');
        const target = path.join(root, 'Card.png');
        const handle = `cleanup-${manifestVariant}`;
        await fs.promises.mkdir(root);
        const transaction = new FileTransaction(root, { handle });
        const originalRm = fs.promises.rm;
        try {
            await transaction.stageFile(target, 'new-card');
            fs.promises.rm = async (filePath, options) => {
                if (path.basename(filePath).startsWith('cleanup-')) {
                    throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' });
                }
                return await originalRm(filePath, options);
            };
            await assert.rejects(transaction.dispose(), error => error.code === 'EIO');
            fs.promises.rm = originalRm;

            const namespace = getFileTransactionNamespace(root, handle);
            const { cleanupPath, markerPath } = await retainedCleanup(namespace);
            const manifestPath = path.join(cleanupPath, 'manifest.json');
            await fs.promises.rm(manifestPath);
            if (manifestVariant === 'nonterminal') {
                const signed = JSON.parse(await fs.promises.readFile(markerPath, 'utf8'));
                const { digest: ignoredDigest, ...manifest } = signed;
                void ignoredDigest;
                manifest.state = 'prepared';
                await fs.promises.writeFile(manifestPath, JSON.stringify({
                    ...manifest,
                    digest: hashCanonicalJson(manifest),
                }));
            } else {
                await fs.promises.writeFile(manifestPath, '{malformed');
            }

            await assert.rejects(ensureFileTransactionRecovery(root, handle), /invalid|tampered|json/i);
            assert.equal(fs.existsSync(cleanupPath), true);
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.promises.rm = originalRm;
            await fs.promises.rm(parent, { recursive: true, force: true });
        }
    });
}

test('cleanup recovery rejects unknown artifacts before recursive deletion', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-cleanup-unknown-'));
    const root = path.join(parent, 'user');
    const target = path.join(root, 'Card.png');
    const handle = 'cleanup-unknown';
    await fs.promises.mkdir(root);
    const transaction = new FileTransaction(root, { handle });
    const originalRm = fs.promises.rm;
    try {
        await transaction.stageFile(target, 'new-card');
        fs.promises.rm = async (filePath, options) => {
            if (path.basename(filePath).startsWith('cleanup-')) {
                throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' });
            }
            return await originalRm(filePath, options);
        };
        await assert.rejects(transaction.dispose(), error => error.code === 'EIO');
        fs.promises.rm = originalRm;

        const namespace = getFileTransactionNamespace(root, handle);
        const { cleanupPath, markerPath } = await retainedCleanup(namespace);
        const unknownPath = path.join(cleanupPath, 'attacker-owned');
        await fs.promises.writeFile(unknownPath, 'do-not-delete');

        await assert.rejects(ensureFileTransactionRecovery(root, handle), /unknown file transaction artifact/i);
        assert.equal(await fs.promises.readFile(unknownPath, 'utf8'), 'do-not-delete');
        assert.equal(fs.existsSync(markerPath), true);
    } finally {
        fs.promises.rm = originalRm;
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

test('recovery rejects a forged cleanup directory without a durable terminal marker', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-forged-cleanup-'));
    const root = path.join(parent, 'user');
    const handle = 'forged-cleanup';
    await fs.promises.mkdir(root);
    try {
        const namespace = getFileTransactionNamespace(root, handle);
        const staging = new FileTransaction(root, { handle });
        await staging.stageFile(path.join(root, 'Card.png'), 'card');
        const [transactionName] = await fs.promises.readdir(namespace);
        await staging.dispose();
        const forgedName = `cleanup-${transactionName}-discarded-${'0'.repeat(64)}-00000000-0000-4000-8000-000000000000`;
        const forgedPath = path.join(namespace, forgedName);
        await fs.promises.mkdir(forgedPath);

        await assert.rejects(ensureFileTransactionRecovery(root, handle), /unauthenticated|unknown/i);
        assert.equal(fs.existsSync(forgedPath), true);
    } finally {
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

test('file transaction verifies staged hashes before changing targets', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-staged-hash-'));
    const root = path.join(parent, 'user');
    const target = path.join(root, 'characters', 'Card.png');
    const handle = 'staged-hash-user';
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, 'old-card');
    const transaction = new FileTransaction(root, { handle });
    try {
        await transaction.stageFile(target, 'new-card');
        const namespace = getFileTransactionNamespace(root, handle);
        const [transactionName] = await fs.promises.readdir(namespace);
        const stagedPath = path.join(namespace, transactionName, 'new', '00000000');
        await fs.promises.writeFile(stagedPath, 'tampered-staged-card');

        await assert.rejects(transaction.commit(), /staged file checksum mismatch/i);
        assert.equal(await fs.promises.readFile(target, 'utf8'), 'old-card');
        assert.deepEqual(await fs.promises.readdir(namespace), []);
    } finally {
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

test('file transaction rejects symbolic-link targets', async t => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-file-tx-symlink-'));
    const root = path.join(parent, 'user');
    const realTarget = path.join(root, 'characters', 'Real.png');
    const linkedTarget = path.join(root, 'characters', 'Linked.png');
    await fs.promises.mkdir(path.dirname(realTarget), { recursive: true });
    await fs.promises.writeFile(realTarget, 'real-card');
    try {
        await fs.promises.symlink(realTarget, linkedTarget, 'file');
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
            t.skip(`Symbolic links are unavailable: ${error.code}`);
            await fs.promises.rm(parent, { recursive: true, force: true });
            return;
        }
        throw error;
    }

    const transaction = new FileTransaction(root, { handle: 'symlink-user' });
    try {
        await transaction.stageFile(linkedTarget, 'replacement');
        await assert.rejects(transaction.commit(), /not a regular file/i);
        assert.equal(await fs.promises.readFile(realTarget, 'utf8'), 'real-card');
    } finally {
        await transaction.dispose();
        await fs.promises.rm(parent, { recursive: true, force: true });
    }
});

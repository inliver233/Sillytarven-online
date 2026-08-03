/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* eslint-disable playwright/no-conditional-in-test -- Symlink assertions depend on host support. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { write } from '../src/character-card-parser.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { FileTransaction, getFileTransactionNamespace } from '../src/file-transaction.js';
import { calculateDirectorySize } from '../src/storage-quota.js';
import { setConfigFilePath } from '../src/util.js';

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));

function createUser(dataRoot, handle) {
    const root = path.join(dataRoot, handle);
    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key of Object.keys(directories)) {
        directories[key] = path.join(root, directories[key]);
    }
    for (const directory of new Set(Object.values(directories))) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return { profile: { handle, name: handle, admin: false }, directories };
}

function writePublicCharacter(publicRoot, id, card) {
    const publicFiles = path.join(publicRoot, 'files');
    const png = write(basePng, JSON.stringify(card));
    fs.writeFileSync(path.join(publicFiles, `${id}.png`), png);
    writePublicMetadata(publicRoot, id, `${id}.png`, card);
    return png;
}

function writePublicMetadata(publicRoot, id, avatar, card) {
    fs.writeFileSync(path.join(publicRoot, `${id}.json`), JSON.stringify({
        id,
        name: card.name,
        description: card.description,
        uploader: { handle: 'publisher', name: 'Publisher' },
        uploaded_at: '2026-01-01T00:00:00.000Z',
        character_data: card,
        avatar,
        downloads: 0,
    }));
}

async function observeSourceReads(sourcePath, operation) {
    const originalReadFileSync = fs.readFileSync;
    const resolvedSourcePath = path.resolve(sourcePath);
    let reads = 0;
    fs.readFileSync = (...args) => {
        if (typeof args[0] === 'string' && path.resolve(args[0]) === resolvedSourcePath) {
            reads += 1;
        }
        return originalReadFileSync(...args);
    };

    try {
        return { result: await operation(), reads };
    } finally {
        fs.readFileSync = originalReadFileSync;
    }
}

function tryCreateFileSymlink(testContext, targetPath, linkPath) {
    try {
        fs.symlinkSync(targetPath, linkPath, 'file');
        return true;
    } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
            testContext.diagnostic(`Symlink assertion skipped: ${error.code}`);
            return false;
        }
        throw error;
    }
}

function readPublicCharacter(publicRoot, id) {
    return JSON.parse(fs.readFileSync(path.join(publicRoot, `${id}.json`), 'utf8'));
}

function snapshotTree(root) {
    const entries = [];
    const visit = (directory, relativeDirectory = '') => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relativePath = path.join(relativeDirectory, entry.name);
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                entries.push(`d:${relativePath}`);
                visit(absolutePath, relativePath);
            } else {
                entries.push(`f:${relativePath}:${fs.readFileSync(absolutePath).toString('base64')}`);
            }
        }
    };
    visit(root);
    return entries.sort();
}

function holdRootLock(runWithChatStorageLocks, getChatBranchUserLockPath, user) {
    let release;
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const held = runWithChatStorageLocks(
        { user },
        [getChatBranchUserLockPath(user.directories.root)],
        async () => {
            signalEntered();
            await gate;
        },
    );
    return { entered, held, release };
}

async function assertStillPending(promise, message) {
    const state = await Promise.race([
        promise.then(() => 'settled', () => 'settled'),
        new Promise(resolve => setTimeout(() => resolve('pending'), 50)),
    ]);
    assert.equal(state, 'pending', message);
}

async function createPendingUsageRecoveryFixture(user, targetPath, originalData) {
    fs.writeFileSync(targetPath, originalData);
    const recoveredTree = snapshotTree(user.directories.root);
    const transaction = new FileTransaction(user.directories.root, {
        handle: user.profile.handle,
        beforeApply: async () => {
            await fs.promises.mkdir(targetPath);
            throw Object.assign(new Error('simulated interrupted file transaction'), { code: 'EIO' });
        },
    });

    try {
        await transaction.stageFile(targetPath, Buffer.from('uncommitted replacement'));
        await assert.rejects(transaction.commit(), error => error.code === 'TRANSACTION_ROLLBACK_FAILED');
        await fs.promises.rmdir(targetPath);

        const namespace = getFileTransactionNamespace(user.directories.root, user.profile.handle);
        assert.equal((await fs.promises.readdir(namespace)).length, 1);
        assert.equal(fs.existsSync(targetPath), false);
        return { namespace, recoveredTree };
    } finally {
        await transaction.dispose();
    }
}

test('public character import is locked, quota-aware, failure-atomic, and source-confined', async (t) => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-public-character-lock-'));
    const configPath = path.join(testRoot, 'config.yaml');
    const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
    const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
    config.userStorage.enabled = false;
    config.performance.useDiskCache = false;
    fs.writeFileSync(configPath, stringifyYaml(config));
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = path.join(testRoot, 'data');
    fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

    const users = {
        a: createUser(globalThis.DATA_ROOT, 'public-import-a'),
        b: createUser(globalThis.DATA_ROOT, 'public-import-b'),
        failure: createUser(globalThis.DATA_ROOT, 'public-import-failure'),
        recovery: createUser(globalThis.DATA_ROOT, 'public-import-recovery'),
        private: createUser(globalThis.DATA_ROOT, 'public-import-private'),
    };
    const {
        getChatBranchUserLockPath,
        resetChatBranchRecoveryForTests,
    } = await import('../src/chat-branch.js');
    const { resetDurableChatRecoveryForTests } = await import('../src/chat-journal.js');
    const { resetCharacterChatRecoveryForTests } = await import('../src/character-chat-transaction.js');
    const { registerCharacterListCache } = await import('../src/character-list-cache.js');
    const { runWithChatStorageLocks } = await import('../src/endpoints/chats.js');
    const { router } = await import('../src/endpoints/public-characters.js');
    const { default: systemMonitor } = await import('../src/system-monitor.js');

    const publicRoot = path.join(globalThis.DATA_ROOT, 'public_characters');
    const cards = {
        collision: {
            name: 'Collision Card',
            description: 'Concurrent public import fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
        success: {
            name: 'Success Card',
            description: 'Success response fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
        quota: {
            name: 'Quota Card',
            description: 'Quota rejection fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
        recovery: {
            name: 'Recovery Quota Card',
            description: 'File transaction recovery before quota fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
        writeFailure: {
            name: 'Write Failure Card',
            description: 'Atomic write failure fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
        mkdirFailure: {
            name: 'Mkdir Failure Card',
            description: 'Chat mkdir failure fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
        private: {
            name: 'PRIVATE SOURCE BYTES',
            description: 'must never cross a public import boundary',
            personality: 'private-secret-marker',
            first_mes: 'private-secret-message',
            mes_example: '',
            scenario: '',
        },
        attacker: {
            name: 'Attacker Metadata',
            description: 'malicious public metadata fixture',
            personality: '',
            first_mes: 'Hello',
            mes_example: '',
            scenario: '',
        },
    };
    writePublicCharacter(publicRoot, 'collision', cards.collision);
    writePublicCharacter(publicRoot, 'success', cards.success);
    const quotaSourcePng = writePublicCharacter(publicRoot, 'quota', cards.quota);
    writePublicCharacter(publicRoot, 'recovery-quota', cards.recovery);
    writePublicCharacter(publicRoot, 'write-failure', cards.writeFailure);
    writePublicCharacter(publicRoot, 'mkdir-failure', cards.mkdirFailure);

    const recoveryUsage = Buffer.alloc(4096, 0x5a);
    const recoveryUsagePath = path.join(users.recovery.directories.characters, 'existing-usage.bin');
    const recoveryFixture = await createPendingUsageRecoveryFixture(
        users.recovery,
        recoveryUsagePath,
        recoveryUsage,
    );

    const privateSourcePath = path.join(users.private.directories.characters, 'private-source.png');
    const privateSourcePng = write(basePng, JSON.stringify(cards.private));
    fs.writeFileSync(privateSourcePath, privateSourcePng);
    const privateMetadataPath = path.join(users.private.directories.root, 'private-metadata.json');
    const traversalAvatar = '../../public-import-private/characters/private-source.png';
    fs.writeFileSync(privateMetadataPath, JSON.stringify({
        id: 'private-metadata',
        name: cards.attacker.name,
        description: cards.attacker.description,
        uploader: { handle: 'attacker', name: 'Attacker' },
        uploaded_at: '2026-01-01T00:00:00.000Z',
        character_data: cards.attacker,
        avatar: traversalAvatar,
        downloads: 0,
    }));
    writePublicMetadata(publicRoot, 'avatar-traversal', traversalAvatar, cards.attacker);

    const publicFilesRoot = path.join(publicRoot, 'files');
    const metadataSymlinkCreated = tryCreateFileSymlink(
        t,
        privateMetadataPath,
        path.join(publicRoot, 'metadata-symlink.json'),
    );
    const avatarSymlinkName = 'avatar-symlink.png';
    const avatarSymlinkCreated = tryCreateFileSymlink(
        t,
        privateSourcePath,
        path.join(publicFilesRoot, avatarSymlinkName),
    );
    if (avatarSymlinkCreated) {
        writePublicMetadata(publicRoot, 'avatar-symlink', avatarSymlinkName, cards.attacker);
    }

    const invalidatedHandles = [];
    registerCharacterListCache({ invalidate: handle => invalidatedHandles.push(handle) });
    const faultObservations = {
        quotaBytes: null,
        recoveryQuotaBytes: null,
        recoveryQuotaSawRestoredUsage: false,
        mkdirAfterWrite: false,
        mkdirCalledAfterWriteFailure: false,
    };

    const app = express();
    app.use((request, response, next) => {
        const user = users[request.get('x-test-user')];
        if (user) request.user = user;

        const fault = request.get('x-test-fault');
        if (fault === 'quota') {
            request.characterImportStorageCheck = async (profile, directories, additionalBytes) => {
                assert.equal(profile, user.profile);
                assert.equal(directories, user.directories);
                faultObservations.quotaBytes = additionalBytes;
                return { allowed: false, usedBytes: 100, limitBytes: 100, remainingBytes: 0 };
            };
        } else if (fault === 'recovery-quota') {
            request.characterImportStorageCheck = async (profile, directories, additionalBytes) => {
                assert.equal(profile, user.profile);
                assert.equal(directories, user.directories);
                assert.deepEqual(fs.readFileSync(recoveryUsagePath), recoveryUsage);
                const usedBytes = await calculateDirectorySize(directories.root);
                assert.equal(usedBytes, recoveryUsage.length);
                faultObservations.recoveryQuotaBytes = additionalBytes;
                faultObservations.recoveryQuotaSawRestoredUsage = true;
                return { allowed: false, usedBytes, limitBytes: usedBytes, remainingBytes: 0 };
            };
        } else if (fault === 'write') {
            request.characterImportWriteFileAtomicSync = (filePath, data) => {
                fs.writeFileSync(filePath, data);
                throw new Error('simulated atomic write failure');
            };
            request.characterImportMkdirSync = () => {
                faultObservations.mkdirCalledAfterWriteFailure = true;
                throw new Error('chat mkdir must not run after write failure');
            };
        } else if (fault === 'mkdir') {
            request.characterImportMkdirSync = chatPath => {
                const identity = path.basename(chatPath);
                const cardPath = path.join(user.directories.characters, `${identity}.png`);
                faultObservations.mkdirAfterWrite = fs.existsSync(cardPath);
                throw new Error('simulated chat mkdir failure');
            };
        }
        next();
    });
    app.use('/api/public-characters', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });

    const originalDateNow = Date.now;
    const timestamp = 1_760_000_000_000;
    const baseIdentity = `${cards.collision.name}_${timestamp}`;
    Date.now = () => timestamp;

    const importCharacter = async (characterId, userKey = '', fault = '') => {
        const headers = {
            'x-test-user': userKey,
            'x-test-fault': fault,
        };
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/public-characters/${characterId}/import`,
            { method: 'POST', headers },
        );
        return { response, data: await response.json() };
    };

    try {
        const unauthenticated = await importCharacter('collision');
        assert.equal(unauthenticated.response.status, 401);
        assert.deepEqual(unauthenticated.data, { error: 'Authentication required' });

        const sourceAttackTreeBefore = snapshotTree(users.failure.directories.root);
        const encodedTraversal = '%2E%2E%2Fpublic-import-private%2Fprivate-metadata';
        const encodedAttempt = await observeSourceReads(
            privateMetadataPath,
            () => importCharacter(encodedTraversal, 'failure'),
        );
        assert.ok([400, 404].includes(encodedAttempt.result.response.status));
        assert.equal(encodedAttempt.reads, 0, 'invalid encoded character IDs must be rejected before metadata reads');
        assert.deepEqual(snapshotTree(users.failure.directories.root), sourceAttackTreeBefore);

        const avatarTraversalAttempt = await observeSourceReads(
            privateSourcePath,
            () => importCharacter('avatar-traversal', 'failure'),
        );
        assert.equal(avatarTraversalAttempt.result.response.status, 500);
        assert.deepEqual(avatarTraversalAttempt.result.data, { error: '角色卡文件不存在' });
        assert.equal(avatarTraversalAttempt.reads, 0, 'traversing avatar metadata must not read private user bytes');
        assert.deepEqual(snapshotTree(users.failure.directories.root), sourceAttackTreeBefore);
        assert.deepEqual(fs.readFileSync(privateSourcePath), privateSourcePng);
        assert.equal(readPublicCharacter(publicRoot, 'avatar-traversal').downloads, 0);

        if (metadataSymlinkCreated) {
            const metadataSymlinkAttempt = await observeSourceReads(
                privateMetadataPath,
                () => importCharacter('metadata-symlink', 'failure'),
            );
            assert.equal(metadataSymlinkAttempt.result.response.status, 404);
            assert.equal(metadataSymlinkAttempt.reads, 0, 'symlink metadata must be rejected without reading its target');
            assert.deepEqual(snapshotTree(users.failure.directories.root), sourceAttackTreeBefore);
        }

        if (avatarSymlinkCreated) {
            const avatarSymlinkAttempt = await observeSourceReads(
                privateSourcePath,
                () => importCharacter('avatar-symlink', 'failure'),
            );
            assert.equal(avatarSymlinkAttempt.result.response.status, 500);
            assert.deepEqual(avatarSymlinkAttempt.result.data, { error: '角色卡文件不存在' });
            assert.equal(avatarSymlinkAttempt.reads, 0, 'symlink avatars must be rejected without reading private targets');
            assert.deepEqual(snapshotTree(users.failure.directories.root), sourceAttackTreeBefore);
            assert.equal(readPublicCharacter(publicRoot, 'avatar-symlink').downloads, 0);
        }
        assert.deepEqual(invalidatedHandles, []);

        const aCollisionPath = path.join(users.a.directories.characters, `${baseIdentity}.png`);
        const bCollisionPath = path.join(users.b.directories.chats, baseIdentity);
        fs.writeFileSync(aCollisionPath, 'existing A character');
        fs.mkdirSync(bCollisionPath, { recursive: true });
        fs.writeFileSync(path.join(bCollisionPath, 'existing.jsonl'), 'existing B chat');

        const heldALock = holdRootLock(runWithChatStorageLocks, getChatBranchUserLockPath, users.a);
        await heldALock.entered;
        const aImports = Promise.all([
            importCharacter('collision', 'a'),
            importCharacter('collision', 'a'),
        ]);
        try {
            await assertStillPending(aImports, 'user A imports must wait for user A root lock');

            const bImports = await Promise.all([
                importCharacter('collision', 'b'),
                importCharacter('collision', 'b'),
            ]);
            assert.deepEqual(bImports.map(result => result.response.status), [200, 200]);
            assert.deepEqual(
                new Set(bImports.map(result => result.data.file_name)),
                new Set([`${baseIdentity} (1)`, `${baseIdentity} (2)`]),
            );
        } finally {
            heldALock.release();
            await heldALock.held;
        }

        const aResults = await aImports;
        assert.deepEqual(aResults.map(result => result.response.status), [200, 200]);
        assert.deepEqual(
            new Set(aResults.map(result => result.data.file_name)),
            new Set([`${baseIdentity} (1)`, `${baseIdentity} (2)`]),
        );

        for (const user of [users.a, users.b]) {
            for (const suffix of [' (1)', ' (2)']) {
                assert.equal(fs.existsSync(path.join(user.directories.characters, `${baseIdentity}${suffix}.png`)), true);
                assert.equal(fs.existsSync(path.join(user.directories.chats, `${baseIdentity}${suffix}`)), false);
            }
        }
        assert.equal(fs.readFileSync(aCollisionPath, 'utf8'), 'existing A character');
        assert.equal(fs.readFileSync(path.join(bCollisionPath, 'existing.jsonl'), 'utf8'), 'existing B chat');
        assert.deepEqual(
            invalidatedHandles.toSorted(),
            [users.a.profile.handle, users.a.profile.handle, users.b.profile.handle, users.b.profile.handle].toSorted(),
        );

        const successIdentity = `${cards.success.name}_${timestamp}`;
        const successResult = await importCharacter('success', 'failure');
        assert.equal(successResult.response.status, 200);
        assert.deepEqual(successResult.data, {
            success: true,
            message: '角色卡导入成功',
            file_name: successIdentity,
        });
        assert.equal(readPublicCharacter(publicRoot, 'success').downloads, 1);
        assert.equal(fs.existsSync(path.join(users.failure.directories.characters, `${successIdentity}.png`)), true);
        assert.equal(fs.existsSync(path.join(users.failure.directories.chats, successIdentity)), false);
        assert.equal(invalidatedHandles.at(-1), users.failure.profile.handle);

        const successfulInvalidationCount = invalidatedHandles.length;
        const failureTreeBefore = snapshotTree(users.failure.directories.root);
        const quotaDownloadsBefore = readPublicCharacter(publicRoot, 'quota').downloads;
        const quotaResult = await importCharacter('quota', 'failure', 'quota');
        assert.equal(quotaResult.response.status, 507);
        assert.deepEqual(quotaResult.data, {
            error: 'storage_limit',
            message: '存储空间不足，无法保存角色卡，请删除角色或使用激活码扩容。',
            usedBytes: 100,
            limitBytes: 100,
            remainingBytes: 0,
        });
        const expectedQuotaBytes = write(quotaSourcePng, JSON.stringify(cards.quota)).length;
        assert.equal(faultObservations.quotaBytes, expectedQuotaBytes);
        assert.ok(faultObservations.quotaBytes > 0);
        assert.deepEqual(snapshotTree(users.failure.directories.root), failureTreeBefore);
        assert.equal(readPublicCharacter(publicRoot, 'quota').downloads, quotaDownloadsBefore);
        assert.equal(invalidatedHandles.length, successfulInvalidationCount);

        const recoveryDownloadsBefore = readPublicCharacter(publicRoot, 'recovery-quota').downloads;
        const recoveryResult = await importCharacter('recovery-quota', 'recovery', 'recovery-quota');
        assert.equal(recoveryResult.response.status, 507);
        assert.deepEqual(recoveryResult.data, {
            error: 'storage_limit',
            message: '存储空间不足，无法保存角色卡，请删除角色或使用激活码扩容。',
            usedBytes: recoveryUsage.length,
            limitBytes: recoveryUsage.length,
            remainingBytes: 0,
        });
        assert.equal(faultObservations.recoveryQuotaSawRestoredUsage, true);
        assert.ok(faultObservations.recoveryQuotaBytes > 0);
        assert.deepEqual(snapshotTree(users.recovery.directories.root), recoveryFixture.recoveredTree);
        assert.deepEqual(await fs.promises.readdir(recoveryFixture.namespace), []);
        assert.equal(readPublicCharacter(publicRoot, 'recovery-quota').downloads, recoveryDownloadsBefore);
        assert.equal(invalidatedHandles.length, successfulInvalidationCount);

        const writeFailureTreeBefore = snapshotTree(users.failure.directories.root);
        const writeFailureResult = await importCharacter('write-failure', 'failure', 'write');
        assert.equal(writeFailureResult.response.status, 500);
        assert.deepEqual(writeFailureResult.data, { error: 'simulated atomic write failure' });
        assert.equal(faultObservations.mkdirCalledAfterWriteFailure, false);
        assert.deepEqual(snapshotTree(users.failure.directories.root), writeFailureTreeBefore);
        assert.equal(readPublicCharacter(publicRoot, 'write-failure').downloads, 0);
        assert.equal(invalidatedHandles.length, successfulInvalidationCount);

        const lazyIdentity = `${cards.mkdirFailure.name}_${timestamp}`;
        const lazyResult = await importCharacter('mkdir-failure', 'failure', 'mkdir');
        assert.equal(lazyResult.response.status, 200);
        assert.equal(lazyResult.data.file_name, lazyIdentity);
        assert.equal(faultObservations.mkdirAfterWrite, false);
        assert.equal(fs.existsSync(path.join(users.failure.directories.characters, `${lazyIdentity}.png`)), true);
        assert.equal(fs.existsSync(path.join(users.failure.directories.chats, lazyIdentity)), false);
        assert.equal(readPublicCharacter(publicRoot, 'mkdir-failure').downloads, 1);
        assert.equal(invalidatedHandles.length, successfulInvalidationCount + 1);
    } finally {
        Date.now = originalDateNow;
        registerCharacterListCache(null);
        resetDurableChatRecoveryForTests();
        resetChatBranchRecoveryForTests();
        resetCharacterChatRecoveryForTests();
        systemMonitor.destroy();
        systemMonitor.saveDataToDisk = () => {};
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

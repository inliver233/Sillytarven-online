/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* eslint-disable playwright/no-conditional-in-test -- Symlink coverage depends on host support. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

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

function tryCreateSymlink(t, targetPath, linkPath, type) {
    try {
        fs.symlinkSync(targetPath, linkPath, type);
        return true;
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOSYS'].includes(error?.code)) {
            t.diagnostic(`Symlink assertion skipped: ${error.code}`);
            return false;
        }
        throw error;
    }
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

async function waitForMissing(filePath) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (!fs.existsSync(filePath)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(filePath), false, `Temporary upload was not removed: ${filePath}`);
}

async function createPendingRecoveryFixture(FileTransaction, getFileTransactionNamespace, user, targetPath, originalData) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, originalData);
    const transaction = new FileTransaction(user.directories.root, {
        handle: user.profile.handle,
        beforeApply: async () => {
            await fs.promises.mkdir(targetPath);
            throw Object.assign(new Error('simulated interrupted sprite transaction'), { code: 'EIO' });
        },
    });

    try {
        await transaction.stageFile(targetPath, Buffer.from('uncommitted sprite'));
        await assert.rejects(transaction.commit(), error => error.code === 'TRANSACTION_ROLLBACK_FAILED');
        await fs.promises.rmdir(targetPath);
        const namespace = getFileTransactionNamespace(user.directories.root, user.profile.handle);
        assert.equal((await fs.promises.readdir(namespace)).length, 1);
        assert.equal(fs.existsSync(targetPath), false);
        return namespace;
    } finally {
        await transaction.dispose();
    }
}

test('sprite routes are path-safe, quota-exact, transactional, recovered, and root-serialized', async (t) => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-sprite-route-'));
    const configPath = path.join(testRoot, 'config.yaml');
    const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
    const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
    config.userStorage.enabled = false;
    config.performance.useDiskCache = false;
    fs.writeFileSync(configPath, stringifyYaml(config));
    setConfigFilePath(configPath);
    globalThis.DATA_ROOT = path.join(testRoot, 'data');
    fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

    const user = createUser(globalThis.DATA_ROOT, 'sprite-route-user');
    const uploads = path.join(testRoot, 'uploads');
    const outside = path.join(testRoot, 'outside');
    fs.mkdirSync(uploads);
    fs.mkdirSync(outside);

    const { FileTransaction, getFileTransactionNamespace } = await import('../src/file-transaction.js');
    const {
        getChatBranchUserLockPath,
        resetChatBranchRecoveryForTests,
    } = await import('../src/chat-branch.js');
    const { resetDurableChatRecoveryForTests } = await import('../src/chat-journal.js');
    const { resetCharacterChatRecoveryForTests } = await import('../src/character-chat-transaction.js');
    const { runWithChatStorageLocks } = await import('../src/endpoints/chats.js');
    const { router } = await import('../src/endpoints/sprites.js');
    const { default: systemMonitor } = await import('../src/system-monitor.js');

    let observedQuotaDelta = null;
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = user;
        const uploadName = request.get('x-test-upload');
        if (uploadName) {
            request.file = {
                destination: uploads,
                filename: uploadName,
                originalname: request.get('x-test-original-name') || uploadName,
            };
        }
        if (request.get('x-test-fault') === 'after-backup') {
            request.spriteTransactionOptions = {
                afterBackup: async () => {
                    throw new Error('simulated sprite publication failure');
                },
            };
        }
        if (request.get('x-test-quota') === 'reject') {
            request.spriteStorageCheck = async (_profile, _directories, additionalBytes) => {
                observedQuotaDelta = additionalBytes;
                return { allowed: false, usedBytes: 100, limitBytes: 100, remainingBytes: 0 };
            };
        }
        const archive = request.get('x-test-archive');
        if (archive === 'replacement') {
            request.spriteArchiveReader = async () => [
                ['zip.jpg', Buffer.from('new zip sprite')],
                ['fresh.png', Buffer.from('fresh sprite')],
            ];
        }
        next();
    });
    app.use('/api/sprites', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/sprites`;

    const writeUpload = (name, data) => {
        const filePath = path.join(uploads, name);
        fs.writeFileSync(filePath, data);
        return filePath;
    };
    const requestJson = async (route, body, headers = {}) => {
        const response = await fetch(`${baseUrl}${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        let data = text;
        try {
            data = JSON.parse(text);
        } catch {
            // sendStatus responses are plain text.
        }
        if (headers['x-test-upload']) {
            await waitForMissing(path.join(uploads, headers['x-test-upload']));
        }
        return { response, data };
    };
    const getSprites = async name => {
        const response = await fetch(`${baseUrl}/get?name=${encodeURIComponent(name)}`);
        const data = await response.json();
        return { response, data };
    };

    try {
        const traversal = await getSprites('../outside');
        assert.equal(traversal.response.status, 400);
        assert.deepEqual(traversal.data, { error: 'unsafe_sprite_path' });

        const traversalUpload = writeUpload('traversal-upload', 'must be removed');
        const traversalWrite = await requestJson('/upload', {
            name: '../outside',
            label: 'escaped',
        }, {
            'x-test-upload': 'traversal-upload',
            'x-test-original-name': 'escaped.png',
        });
        assert.equal(traversalWrite.response.status, 400);
        assert.equal(fs.existsSync(traversalUpload), false);
        assert.deepEqual(fs.readdirSync(outside), []);

        const linkedDirectory = path.join(user.directories.characters, 'Linked');
        if (tryCreateSymlink(t, outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')) {
            const linkedRead = await getSprites('Linked');
            assert.equal(linkedRead.response.status, 400);
            assert.deepEqual(linkedRead.data, { error: 'unsafe_sprite_path' });

            const linkedUpload = writeUpload('linked-upload', 'must not escape');
            const linkedWrite = await requestJson('/upload', { name: 'Linked', label: 'escaped' }, {
                'x-test-upload': 'linked-upload',
                'x-test-original-name': 'escaped.png',
            });
            assert.equal(linkedWrite.response.status, 400);
            assert.equal(fs.existsSync(linkedUpload), false);
            assert.deepEqual(fs.readdirSync(outside), []);
        }

        const unsafeFileDirectory = path.join(user.directories.characters, 'UnsafeFile');
        const outsideFile = path.join(outside, 'private.png');
        fs.mkdirSync(unsafeFileDirectory);
        fs.writeFileSync(outsideFile, 'private');
        const linkedFile = path.join(unsafeFileDirectory, 'linked.png');
        if (tryCreateSymlink(t, outsideFile, linkedFile, 'file')) {
            const linkedFileRead = await getSprites('UnsafeFile');
            assert.equal(linkedFileRead.response.status, 400);
            assert.deepEqual(linkedFileRead.data, { error: 'unsafe_sprite_file' });
            assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'private');
        }

        const nestedDirectory = path.join(user.directories.characters, 'Nested', 'Costume');
        fs.mkdirSync(nestedDirectory, { recursive: true });
        fs.writeFileSync(path.join(nestedDirectory, 'joy.png'), 'nested sprite');
        const nestedRead = await getSprites('Nested/Costume');
        assert.equal(nestedRead.response.status, 200);
        assert.equal(nestedRead.data.length, 1);
        const parentRead = await getSprites('Nested');
        assert.equal(parentRead.response.status, 200);
        assert.deepEqual(parentRead.data, []);

        const quotaDirectory = path.join(user.directories.characters, 'Quota');
        fs.mkdirSync(quotaDirectory);
        const quotaOld = path.join(quotaDirectory, 'quota.png');
        fs.writeFileSync(quotaOld, 'old');
        const quotaUpload = writeUpload('quota-upload', '0123456789');
        const quotaResult = await requestJson('/upload', { name: 'Quota', label: 'quota' }, {
            'x-test-upload': 'quota-upload',
            'x-test-original-name': 'quota.jpg',
            'x-test-quota': 'reject',
        });
        assert.equal(quotaResult.response.status, 507);
        assert.deepEqual(quotaResult.data, {
            error: 'storage_limit',
            usedBytes: 100,
            limitBytes: 100,
            remainingBytes: 0,
        });
        assert.equal(observedQuotaDelta, 7);
        assert.equal(fs.readFileSync(quotaOld, 'utf8'), 'old');
        assert.equal(fs.existsSync(path.join(quotaDirectory, 'quota.jpg')), false);
        assert.equal(fs.existsSync(quotaUpload), false);

        const faultDirectory = path.join(user.directories.characters, 'Fault');
        fs.mkdirSync(faultDirectory);
        const faultOld = path.join(faultDirectory, 'fault.png');
        fs.writeFileSync(faultOld, 'original fault sprite');
        const faultUpload = writeUpload('fault-upload', 'replacement sprite');
        const faultResult = await requestJson('/upload', { name: 'Fault', label: 'fault' }, {
            'x-test-upload': 'fault-upload',
            'x-test-original-name': 'fault.jpg',
            'x-test-fault': 'after-backup',
        });
        assert.equal(faultResult.response.status, 500);
        assert.deepEqual(faultResult.data, { error: 'sprite_operation_failed' });
        assert.equal(fs.readFileSync(faultOld, 'utf8'), 'original fault sprite');
        assert.equal(fs.existsSync(path.join(faultDirectory, 'fault.jpg')), false);
        assert.equal(fs.existsSync(faultUpload), false);

        const successfulUpload = writeUpload('successful-upload', 'replacement sprite');
        const successfulResult = await requestJson('/upload', { name: 'Fault', label: 'fault' }, {
            'x-test-upload': 'successful-upload',
            'x-test-original-name': 'fault.jpg',
        });
        assert.equal(successfulResult.response.status, 200);
        assert.equal(fs.existsSync(faultOld), false);
        assert.equal(fs.readFileSync(path.join(faultDirectory, 'fault.jpg'), 'utf8'), 'replacement sprite');
        assert.equal(fs.existsSync(successfulUpload), false);

        const deleteTarget = path.join(faultDirectory, 'delete.png');
        fs.writeFileSync(deleteTarget, 'delete me');
        const failedDelete = await requestJson('/delete', { name: 'Fault', label: 'delete' }, {
            'x-test-fault': 'after-backup',
        });
        assert.equal(failedDelete.response.status, 500);
        assert.equal(fs.readFileSync(deleteTarget, 'utf8'), 'delete me');
        const successfulDelete = await requestJson('/delete', { name: 'Fault', label: 'delete' });
        assert.equal(successfulDelete.response.status, 200);
        assert.equal(fs.existsSync(deleteTarget), false);

        const zipDirectory = path.join(user.directories.characters, 'Zip');
        fs.mkdirSync(zipDirectory);
        const zipOld = path.join(zipDirectory, 'zip.png');
        fs.writeFileSync(zipOld, 'old zip sprite');
        const failedZipUpload = writeUpload('failed-pack.zip', 'archive placeholder');
        const failedZip = await requestJson('/upload-zip', { name: 'Zip' }, {
            'x-test-upload': 'failed-pack.zip',
            'x-test-original-name': 'pack.zip',
            'x-test-archive': 'replacement',
            'x-test-fault': 'after-backup',
        });
        assert.equal(failedZip.response.status, 500);
        assert.equal(fs.readFileSync(zipOld, 'utf8'), 'old zip sprite');
        assert.equal(fs.existsSync(path.join(zipDirectory, 'zip.jpg')), false);
        assert.equal(fs.existsSync(path.join(zipDirectory, 'fresh.png')), false);
        assert.equal(fs.existsSync(failedZipUpload), false);

        const successfulZipUpload = writeUpload('successful-pack.zip', 'archive placeholder');
        const successfulZip = await requestJson('/upload-zip', { name: 'Zip' }, {
            'x-test-upload': 'successful-pack.zip',
            'x-test-original-name': 'pack.zip',
            'x-test-archive': 'replacement',
        });
        assert.equal(successfulZip.response.status, 200);
        assert.deepEqual(successfulZip.data, { ok: true, count: 2 });
        assert.equal(fs.existsSync(zipOld), false);
        assert.equal(fs.readFileSync(path.join(zipDirectory, 'zip.jpg'), 'utf8'), 'new zip sprite');
        assert.equal(fs.readFileSync(path.join(zipDirectory, 'fresh.png'), 'utf8'), 'fresh sprite');
        assert.equal(fs.existsSync(successfulZipUpload), false);

        const recoveryTarget = path.join(user.directories.characters, 'Recovery', 'recovery.png');
        const recoveryNamespace = await createPendingRecoveryFixture(
            FileTransaction,
            getFileTransactionNamespace,
            user,
            recoveryTarget,
            Buffer.from('recovered sprite'),
        );
        const recoveredRead = await getSprites('Recovery');
        assert.equal(recoveredRead.response.status, 200);
        assert.equal(fs.readFileSync(recoveryTarget, 'utf8'), 'recovered sprite');
        assert.deepEqual(fs.readdirSync(recoveryNamespace), []);

        const heldLock = holdRootLock(runWithChatStorageLocks, getChatBranchUserLockPath, user);
        await heldLock.entered;
        const serializedUpload = writeUpload('serialized-upload', 'serialized sprite');
        const lockedRead = getSprites('Recovery');
        const lockedWrite = requestJson('/upload', { name: 'Serialized', label: 'serialized' }, {
            'x-test-upload': 'serialized-upload',
            'x-test-original-name': 'serialized.png',
        });
        try {
            await Promise.all([
                assertStillPending(lockedRead, 'sprite GET must wait for the user root lock'),
                assertStillPending(lockedWrite, 'sprite upload must wait for the user root lock'),
            ]);
        } finally {
            heldLock.release();
            await heldLock.held;
        }
        assert.equal((await lockedRead).response.status, 200);
        assert.equal((await lockedWrite).response.status, 200);
        assert.equal(
            fs.readFileSync(path.join(user.directories.characters, 'Serialized', 'serialized.png'), 'utf8'),
            'serialized sprite',
        );
        assert.equal(fs.existsSync(serializedUpload), false);
    } finally {
        resetDurableChatRecoveryForTests();
        resetChatBranchRecoveryForTests();
        resetCharacterChatRecoveryForTests();
        systemMonitor.destroy();
        systemMonitor.saveDataToDisk = () => {};
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});

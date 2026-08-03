/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* global globalThis */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';
import express from 'express';
import multer from 'multer';
import sanitize from 'sanitize-filename';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { write } from '../src/character-card-parser.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { sanitizeSafeCharacterReplacements, setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-character-identity-lock-'));
const uploads = path.join(testRoot, 'uploads');
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = true;
config.userStorage.defaultLimitMiB = 100;
config.performance.useDiskCache = false;
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const {
    getChatBranchUserLockPath,
    resetChatBranchRecoveryForTests,
} = await import('../src/chat-branch.js');
const { resetDurableChatRecoveryForTests } = await import('../src/chat-journal.js');
const { resetCharacterChatRecoveryForTests } = await import('../src/character-chat-transaction.js');
const { getFileTransactionNamespace } = await import('../src/file-transaction.js');
const { runWithChatStorageLocks } = await import('../src/endpoints/chats.js');
const { diskCache, router } = await import('../src/endpoints/characters.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));

function createUser(handle) {
    const root = path.join(testRoot, 'users', handle);
    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key of Object.keys(directories)) {
        directories[key] = path.join(root, directories[key]);
    }
    for (const directory of new Set(Object.values(directories))) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return {
        profile: { handle, name: handle, admin: false, storageLimitMiB: 100 },
        directories,
    };
}

const users = {
    identity: createUser('identity'),
    blocked: createUser('blocked'),
    quota: createUser('quota'),
    stale: createUser('stale'),
    broken: createUser('broken'),
    applyingRead: createUser('applying-read'),
    committedRead: createUser('committed-read'),
};

const app = express();
app.use(express.json());
app.use(multer({ dest: uploads }).single('avatar'));
app.use((request, response, next) => {
    const user = users[request.get('x-test-user')];
    if (!user) return response.sendStatus(401);
    request.user = user;
    next();
});
app.use('/api/characters', router);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/api/characters`;

after(async () => {
    resetDurableChatRecoveryForTests();
    resetChatBranchRecoveryForTests();
    resetCharacterChatRecoveryForTests();
    diskCache.dispose();
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(testRoot, { recursive: true, force: true });
});

function characterData(name) {
    return {
        name,
        description: `${name} fixture`,
        personality: '',
        first_mes: 'Hello',
        mes_example: '',
        scenario: '',
    };
}

function writeCharacterFixture(user, name) {
    const filePath = path.join(user.directories.characters, `${name}.png`);
    fs.writeFileSync(filePath, write(basePng, JSON.stringify(characterData(name))));
    return filePath;
}

async function postCreate(userKey, name, fileName) {
    return await fetch(`${baseUrl}/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': userKey },
        body: JSON.stringify({ ch_name: name, first_mes: 'Hello', ...(fileName ? { file_name: fileName } : {}) }),
    });
}

async function postImport(userKey, bytes, fileName, format = 'png') {
    const form = new FormData();
    form.append('file_type', format);
    form.append('user_name', 'User');
    form.append('avatar', new Blob([bytes], { type: 'application/octet-stream' }), fileName);
    return await fetch(`${baseUrl}/import`, {
        method: 'POST',
        headers: { 'x-test-user': userKey },
        body: form,
    });
}

async function postDuplicate(userKey, avatarUrl) {
    return await fetch(`${baseUrl}/duplicate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': userKey },
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
}

async function postAll(userKey) {
    return await fetch(`${baseUrl}/all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': userKey },
        body: '{}',
    });
}

async function postGet(userKey, avatarUrl) {
    return await fetch(`${baseUrl}/get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': userKey },
        body: JSON.stringify({ avatar_url: avatarUrl }),
    });
}

function crashDuplicatePublish(user, sourceName, destinationName, crashPoint) {
    const moduleUrl = new URL('../src/file-transaction.js', import.meta.url).href;
    const options = JSON.stringify({
        root: user.directories.root,
        handle: user.profile.handle,
        source: path.join(user.directories.characters, sourceName),
        destination: path.join(user.directories.characters, destinationName),
        crashPoint,
    });
    const script = `
        import fs from 'node:fs';
        import { FileTransaction } from ${JSON.stringify(moduleUrl)};
        const { root, handle, source, destination, crashPoint } = JSON.parse(process.env.CHARACTER_DUPLICATE_CRASH);
        const crash = point => { if (crashPoint === point) process.exit(86); };
        const transaction = new FileTransaction(root, {
            handle,
            afterApply: () => crash('after-apply'),
            afterCommit: () => crash('after-commit'),
        });
        await transaction.stageFile(destination, await fs.promises.readFile(source));
        await transaction.commit();
        process.exit(2);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
        encoding: 'utf8',
        env: { ...process.env, CHARACTER_DUPLICATE_CRASH: options },
        timeout: 30_000,
    });
    assert.equal(result.status, 86, result.stderr || result.stdout || `signal=${result.signal}`);
}

function fileTransactionJournalEntries(user) {
    const namespace = getFileTransactionNamespace(user.directories.root, user.profile.handle);
    return fs.existsSync(namespace) ? fs.readdirSync(namespace) : [];
}

function holdRootLock(user) {
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

function directorySize(directory) {
    let size = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        size += entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size;
    }
    return size;
}

async function createZip(entries) {
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const completed = new Promise((resolve, reject) => {
        output.once('end', resolve);
        output.once('error', reject);
    });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.once('error', error => output.destroy(error));
    archive.pipe(output);
    for (const [name, contents] of Object.entries(entries)) archive.append(contents, { name });
    await archive.finalize();
    await completed;
    return Buffer.concat(chunks);
}

test('concurrent create and import allocate distinct character identities', async () => {
    const name = 'Same Identity';
    const cardPng = write(basePng, JSON.stringify(characterData(name)));
    const [created, imported] = await Promise.all([
        postCreate('identity', name),
        postImport('identity', cardPng, 'same.png'),
    ]);

    assert.equal(created.status, 200);
    assert.equal(imported.status, 200);
    const createdName = path.parse(await created.text()).name;
    const importedName = (await imported.json()).file_name;
    assert.deepEqual(new Set([createdName, importedName]), new Set([name, `${name}1`]));
    assert.equal(fs.existsSync(path.join(users.identity.directories.characters, `${createdName}.png`)), true);
    assert.equal(fs.existsSync(path.join(users.identity.directories.characters, `${importedName}.png`)), true);
    assert.equal(fs.existsSync(path.join(users.identity.directories.chats, createdName)), false);
});

test('create, import, duplicate, and reads wait for the user root lock', async () => {
    writeCharacterFixture(users.blocked, 'Duplicate Source');
    const importPng = write(basePng, JSON.stringify(characterData('Blocked Import')));
    const lock = holdRootLock(users.blocked);
    await lock.entered;

    const createPromise = postCreate('blocked', 'Blocked Create');
    const importPromise = postImport('blocked', importPng, 'blocked.png');
    const duplicatePromise = postDuplicate('blocked', 'Duplicate Source.png');
    const allPromise = postAll('blocked');
    const getPromise = postGet('blocked', 'Duplicate Source.png');
    try {
        await Promise.all([
            assertStillPending(createPromise, 'create must wait for the user root lock'),
            assertStillPending(importPromise, 'import must wait for the user root lock'),
            assertStillPending(duplicatePromise, 'duplicate must wait for the user root lock'),
            assertStillPending(allPromise, 'all must wait for the user root lock'),
            assertStillPending(getPromise, 'get must wait for the user root lock'),
        ]);
    } finally {
        lock.release();
        await lock.held;
    }

    const responses = await Promise.all([createPromise, importPromise, duplicatePromise, allPromise, getPromise]);
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200, 200]);
});

test('all recovers an applying duplicate journal before cache access and retry reuses the identity', async () => {
    const user = users.applyingRead;
    writeCharacterFixture(user, 'Crash Source');
    const warmResponse = await postAll('applyingRead');
    assert.equal(warmResponse.status, 200);
    assert.deepEqual((await warmResponse.json()).map(character => character.avatar), ['Crash Source.png']);

    crashDuplicatePublish(user, 'Crash Source.png', 'Crash Source_1.png', 'after-apply');
    assert.equal(fs.existsSync(path.join(user.directories.characters, 'Crash Source_1.png')), true);
    assert.equal(fileTransactionJournalEntries(user).length, 1);

    const recoveredResponse = await postAll('applyingRead');
    assert.equal(recoveredResponse.status, 200);
    assert.deepEqual((await recoveredResponse.json()).map(character => character.avatar), ['Crash Source.png']);
    assert.equal(fs.existsSync(path.join(user.directories.characters, 'Crash Source_1.png')), false);
    assert.deepEqual(fileTransactionJournalEntries(user), []);

    const retried = await postDuplicate('applyingRead', 'Crash Source.png');
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { path: 'Crash Source_1.png' });
    assert.deepEqual(
        fs.readFileSync(path.join(user.directories.characters, 'Crash Source_1.png')),
        fs.readFileSync(path.join(user.directories.characters, 'Crash Source.png')),
    );
});

test('get cleans a committed duplicate journal before reading and retry advances the identity', async () => {
    const user = users.committedRead;
    const sourcePath = writeCharacterFixture(user, 'Committed Source');
    crashDuplicatePublish(user, 'Committed Source.png', 'Committed Source_1.png', 'after-commit');
    assert.equal(fileTransactionJournalEntries(user).length, 1);

    const getResponse = await postGet('committedRead', 'Committed Source_1.png');
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).avatar, 'Committed Source_1.png');
    assert.deepEqual(fs.readFileSync(path.join(user.directories.characters, 'Committed Source_1.png')), fs.readFileSync(sourcePath));
    assert.deepEqual(fileTransactionJournalEntries(user), []);

    const retried = await postDuplicate('committedRead', 'Committed Source.png');
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { path: 'Committed Source_2.png' });
    assert.deepEqual(
        fs.readFileSync(path.join(user.directories.characters, 'Committed Source_2.png')),
        fs.readFileSync(sourcePath),
    );
});

test('concurrent duplicates admit exactly one copy at an exact one-card quota', async () => {
    const sourcePath = writeCharacterFixture(users.quota, 'Quota Source');
    const sourceBytes = fs.statSync(sourcePath).size;
    const usedBytes = directorySize(users.quota.directories.root);
    users.quota.profile.storageLimitMiB = (usedBytes + sourceBytes) / (1024 * 1024);

    const responses = await Promise.all([
        postDuplicate('quota', 'Quota Source.png'),
        postDuplicate('quota', 'Quota Source.png'),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [200, 507]);
    assert.equal(fs.existsSync(path.join(users.quota.directories.characters, 'Quota Source_1.png')), true);
    assert.equal(fs.existsSync(path.join(users.quota.directories.characters, 'Quota Source_2.png')), false);
});

test('create write failure does not publish a chat directory', async () => {
    fs.mkdirSync(path.join(users.broken.directories.characters, 'Failed Create.png'));
    const response = await postCreate('broken', 'Failed Create', 'Failed Create');
    assert.equal(response.status, 500);
    assert.equal(fs.existsSync(path.join(users.broken.directories.chats, 'Failed Create')), false);
});

test('BYAF import does not reuse an identity occupied only by stale chat sidecars', async () => {
    const timestamp = 1_760_000_000_000;
    const originalDateNow = Date.now;
    const displayName = 'Stale BYAF';
    const scenarioTitle = 'Opening';
    const staleChatDirectory = path.join(users.stale.directories.chats, displayName);
    const staleChatBase = sanitize(
        `${scenarioTitle} - ${new Date(timestamp).toISOString()} imported`,
        { replacement: sanitizeSafeCharacterReplacements },
    );
    const staleChatPath = path.join(staleChatDirectory, `${staleChatBase}.jsonl`);
    fs.mkdirSync(`${staleChatPath}.chunks`, { recursive: true });
    fs.writeFileSync(`${staleChatPath}.metadata.json`, '{"stale":true}');

    const byaf = await createZip({
        'manifest.json': JSON.stringify({
            characters: ['characters/card.json'],
            scenarios: ['scenarios/opening.json'],
            author: { name: 'Identity Test' },
        }),
        'characters/card.json': JSON.stringify({
            name: displayName,
            displayName,
            persona: 'BYAF fixture',
            images: [],
            loreItems: [],
        }),
        'scenarios/opening.json': JSON.stringify({
            title: scenarioTitle,
            narrative: '',
            firstMessages: [{ text: 'Hello' }],
            exampleMessages: [],
            messages: [],
        }),
    });

    Date.now = () => timestamp;
    try {
        const response = await postImport('stale', byaf, 'stale.byaf', 'byaf');
        assert.equal(response.status, 200);
        assert.equal((await response.json()).file_name, `${displayName}1`);
    } finally {
        Date.now = originalDateNow;
    }

    assert.equal(fs.existsSync(`${staleChatPath}.metadata.json`), true);
    assert.equal(fs.existsSync(`${staleChatPath}.chunks`), true);
    assert.equal(fs.existsSync(path.join(users.stale.directories.characters, `${displayName}1.png`)), true);
});

/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { parse, write } from '../src/character-card-parser.js';
import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-character-edit-atomic-'));
const uploads = path.join(testRoot, 'uploads');
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.userStorage.enabled = false;
config.performance.useDiskCache = false;
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { getChatBranchUserLockPath, resetChatBranchRecoveryForTests } = await import('../src/chat-branch.js');
const { resetDurableChatRecoveryForTests } = await import('../src/chat-journal.js');
const { resetCharacterChatRecoveryForTests } = await import('../src/character-chat-transaction.js');
const { runWithChatStorageLocks } = await import('../src/endpoints/chats.js');
const { diskCache, router } = await import('../src/endpoints/characters.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const basePng = fs.readFileSync(new URL('../default/content/user-default.png', import.meta.url));
const users = new Map();
const observations = { quotaDelta: null };

function createUser(handle) {
    const root = path.join(testRoot, 'users', handle);
    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key of Object.keys(directories)) directories[key] = path.join(root, directories[key]);
    for (const directory of new Set(Object.values(directories))) fs.mkdirSync(directory, { recursive: true });
    const user = { profile: { handle, name: handle, admin: false }, directories };
    users.set(handle, user);
    return user;
}

const lockUser = createUser('edit-lock');
const writeUser = createUser('edit-write');
const quotaUser = createUser('edit-quota');
const createUserFixture = createUser('create-occupied');
const spriteUser = createUser('sprite-rollback');

function characterData(name, description = `${name} fixture`) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description,
        personality: '',
        scenario: '',
        first_mes: 'Hello',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        data: {
            name,
            description,
            personality: '',
            scenario: '',
            first_mes: 'Hello',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: [],
            creator: '',
            character_version: '',
            extensions: {},
        },
    };
}

function writeCharacterFixture(user, name) {
    const filePath = path.join(user.directories.characters, `${name}.png`);
    fs.writeFileSync(filePath, write(basePng, JSON.stringify(characterData(name))));
    return filePath;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(multer({ dest: uploads }).single('avatar'));
app.use((request, response, next) => {
    const user = users.get(request.get('x-test-user'));
    if (!user) return response.sendStatus(401);
    request.user = user;
    switch (request.get('x-test-fault')) {
        case 'write':
            request.characterImportWriteFileAtomicSync = () => {
                throw new Error('simulated character write failure');
            };
            break;
        case 'quota':
            request.characterImportStorageCheck = async (_profile, _directories, additionalBytes) => {
                observations.quotaDelta = additionalBytes;
                return { allowed: false, usedBytes: 100, limitBytes: 100, remainingBytes: 0 };
            };
            break;
        case 'sprite-transaction':
            request.characterImportTransactionOptions = {
                beforeApply: ({ index }) => {
                    if (index === 1) throw Object.assign(new Error('simulated sprite transaction failure'), { code: 'ENOSPC' });
                },
            };
            break;
    }
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

function jsonPost(user, endpoint, body, headers = {}) {
    return fetch(`${baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': user.profile.handle, ...headers },
        body: JSON.stringify(body),
    });
}

function editBody(name, description = 'edited description') {
    return {
        avatar_url: `${name}.png`,
        ch_name: name,
        description,
        personality: '',
        scenario: '',
        first_mes: 'Hello',
        mes_example: '',
        chat: '',
        create_date: '',
    };
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

async function postAvatarEdit(user, name) {
    const form = new FormData();
    form.append('avatar_url', `${name}.png`);
    form.append('avatar', new Blob([basePng], { type: 'image/png' }), 'avatar.png');
    return fetch(`${baseUrl}/edit-avatar`, {
        method: 'POST',
        headers: { 'x-test-user': user.profile.handle },
        body: form,
    });
}

async function postImport(user, card, format) {
    const bytes = format === 'png'
        ? write(basePng, JSON.stringify(card))
        : Buffer.from(JSON.stringify(card));
    const form = new FormData();
    form.append('file_type', format);
    form.append('user_name', 'User');
    form.append('avatar', new Blob([bytes], { type: 'application/octet-stream' }), `risu.${format}`);
    return fetch(`${baseUrl}/import`, {
        method: 'POST',
        headers: { 'x-test-user': user.profile.handle, 'x-test-fault': 'sprite-transaction' },
        body: form,
    });
}

test('edit routes wait behind the character root lock used by rename and delete', async () => {
    const name = 'Locked Card';
    writeCharacterFixture(lockUser, name);
    const lock = holdRootLock(lockUser);
    await lock.entered;

    const requests = [
        jsonPost(lockUser, 'edit', editBody(name)),
        postAvatarEdit(lockUser, name),
        jsonPost(lockUser, 'edit-attribute', { avatar_url: `${name}.png`, ch_name: name, field: 'description', value: 'attribute edit' }),
        jsonPost(lockUser, 'merge-attributes', { avatar: `${name}.png`, description: 'merged edit' }),
    ];
    try {
        await Promise.all(requests.map((request, index) => assertStillPending(request, `edit request ${index} must wait for the root lock`)));
    } finally {
        lock.release();
        await lock.held;
    }

    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
});

test('a failed character writer cannot return 200 or alter the card', async () => {
    const name = 'Write Failure';
    const cardPath = writeCharacterFixture(writeUser, name);
    const before = fs.readFileSync(cardPath);
    const response = await jsonPost(writeUser, 'edit', editBody(name), { 'x-test-fault': 'write' });

    assert.equal(response.status, 500);
    assert.deepEqual(fs.readFileSync(cardPath), before);
});

test('quota rejection uses the exact positive final PNG delta and performs no mutation', async () => {
    const name = 'Quota Edit';
    const cardPath = writeCharacterFixture(quotaUser, name);
    const before = fs.readFileSync(cardPath);
    const value = 'expanded description '.repeat(2_000);
    const parsed = JSON.parse(await parse(cardPath));
    parsed.description = value;
    parsed.data.description = value;
    const finalPng = write(before, JSON.stringify(parsed));
    const expectedDelta = Math.max(0, finalPng.length - before.length);

    observations.quotaDelta = null;
    const response = await jsonPost(quotaUser, 'edit-attribute', {
        avatar_url: `${name}.png`,
        ch_name: name,
        field: 'description',
        value,
    }, { 'x-test-fault': 'quota' });

    assert.equal(response.status, 507);
    assert.equal(observations.quotaDelta, expectedDelta);
    assert.ok(expectedDelta > 0);
    assert.deepEqual(fs.readFileSync(cardPath), before);
});

test('caller-supplied create file names cannot overwrite occupied card or chat identities', async () => {
    const occupiedCard = writeCharacterFixture(createUserFixture, 'Occupied Card');
    const before = fs.readFileSync(occupiedCard);
    const occupiedChat = path.join(createUserFixture.directories.chats, 'Occupied Chat');
    fs.mkdirSync(occupiedChat);
    fs.writeFileSync(path.join(occupiedChat, 'existing.jsonl'), '{"existing":true}');

    const cardResponse = await jsonPost(createUserFixture, 'create', { ch_name: 'Replacement', file_name: 'Occupied Card' });
    const chatResponse = await jsonPost(createUserFixture, 'create', { ch_name: 'Replacement', file_name: 'Occupied Chat' });

    assert.equal(cardResponse.status, 409);
    assert.equal(chatResponse.status, 409);
    assert.deepEqual(fs.readFileSync(occupiedCard), before);
    assert.equal(fs.existsSync(path.join(createUserFixture.directories.characters, 'Occupied Chat.png')), false);
    assert.equal(fs.readFileSync(path.join(occupiedChat, 'existing.jsonl'), 'utf8'), '{"existing":true}');
});

test('JSON and PNG Risu imports roll sprites and card back together', async () => {
    for (const format of ['json', 'png']) {
        const name = `Risu ${format.toUpperCase()}`;
        const card = characterData(name);
        card.data.extensions.risuai = {
            additionalAssets: [['happy', Buffer.from(`${format}-sprite`).toString('base64')]],
        };

        const response = await postImport(spriteUser, card, format);
        assert.equal(response.status, 507);
        assert.equal(fs.existsSync(path.join(spriteUser.directories.characters, `${name}.png`)), false);
        const spriteDirectory = path.join(spriteUser.directories.characters, name);
        assert.equal(fs.existsSync(spriteDirectory), false);
    }
});

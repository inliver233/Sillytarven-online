import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-chat-wipe-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.backups.chat.enabled = false;
config.performance.chatChunkingEnabled = true;
config.performance.chatPaging = { enabled: true };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const directories = {
    root: path.join(testRoot, 'user'),
    groupChats: path.join(testRoot, 'group-chats'),
    backups: path.join(testRoot, 'backups'),
    characters: path.join(testRoot, 'characters'),
    chats: path.join(testRoot, 'chats'),
    groups: path.join(testRoot, 'groups'),
};
for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((request, _response, next) => {
    request.user = {
        profile: { handle: 'wipe-test', name: 'Wipe Test', admin: true },
        directories,
    };
    next();
});
app.use('/api/chats', chatsRouter);
const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}/api/chats`;

after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function post(route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    return { response, data: text ? JSON.parse(text) : null };
}

function makeMessages(count, prefix = 'message') {
    return Array.from({ length: count }, (_, index) => ({
        name: index % 2 ? 'User' : 'Character',
        is_user: index % 2 === 1,
        send_date: 1_700_000_000_000 + index,
        mes: `${prefix}-${index}`,
    }));
}

const greeting = { name: 'Character', is_user: false, send_date: 1_800_000_000_000, mes: 'greeting', swipes: ['greeting', 'alt'] };

function characterChat(fileName, integrity) {
    const header = { user_name: 'User', character_name: 'Character', create_date: '2026-08-12@22h37m59s', chat_metadata: { integrity } };
    return { header, target: { ch_name: 'Character', avatar_url: 'Character.png', file_name: fileName } };
}

async function storedMessages(target) {
    const { data } = await post('/get', target);
    return data.slice(1).map(message => message.mes);
}

test('a full save cannot shrink a stored chat to its greeting unless the client loaded it', async () => {
    const { header, target } = characterChat('wiped-by-failed-load', 'integrity-a');
    const history = makeMessages(5);
    assert.equal((await post('/save', { ...target, chat: [header, ...history] })).response.status, 200);

    // What a client sends after a failed load: the same header and just the greeting.
    const refused = await post('/save', { ...target, chat: [header, greeting] });
    assert.equal(refused.response.status, 409);
    assert.equal(refused.data.error, 'chat_wipe_rejected');
    assert.equal(refused.data.storedMessageCount, 5);
    assert.deepEqual(await storedMessages(target), history.map(message => message.mes));

    const emptied = await post('/save', { ...target, chat: [header] });
    assert.equal(emptied.response.status, 409);
    assert.deepEqual(await storedMessages(target), history.map(message => message.mes));

    // Growing, or shrinking to more than one message, is ordinary editing.
    assert.equal((await post('/save', { ...target, chat: [header, ...history.slice(0, 2)] })).response.status, 200);
    assert.equal((await post('/save', { ...target, chat: [header, ...history] })).response.status, 200);

    // A client that loaded the chat may delete everything but the greeting.
    assert.equal((await post('/save', { ...target, chat: [header, greeting], allow_shrink: true })).response.status, 200);
    assert.deepEqual(await storedMessages(target), ['greeting']);
});

test('force overrides the guard and a new chat is never refused', async () => {
    const { header, target } = characterChat('forced-overwrite', 'integrity-b');
    assert.equal((await post('/save', { ...target, chat: [header, greeting] })).response.status, 200);
    assert.equal((await post('/save', { ...target, chat: [header, ...makeMessages(3)] })).response.status, 200);
    assert.equal((await post('/save', { ...target, chat: [header, greeting], force: true })).response.status, 200);
    assert.deepEqual(await storedMessages(target), ['greeting']);
});

test('a tail save that replaces the whole chat is guarded, an append is not', async () => {
    const { header, target } = characterChat('tail-wipe', 'integrity-c');
    const history = makeMessages(4);
    assert.equal((await post('/save', { ...target, chat: [header, ...history] })).response.status, 200);
    const page = await post('/get-range', { ...target, limit: 10 });
    assert.equal(page.data.cursor, 0);

    const refused = await post('/save-tail', { ...target, header, messages: [greeting], before: 0, expectedRevision: page.data.revision });
    assert.equal(refused.response.status, 409);
    assert.equal(refused.data.error, 'chat_wipe_rejected');
    assert.deepEqual(await storedMessages(target), history.map(message => message.mes));

    const appended = await post('/save-tail', { ...target, header, messages: [...history, greeting], before: 0, expectedRevision: page.data.revision });
    assert.equal(appended.response.status, 200);

    const allowed = await post('/save-tail', { ...target, header, messages: [greeting], before: 0, expectedRevision: appended.data.revision, allow_shrink: true });
    assert.equal(allowed.response.status, 200);
    assert.deepEqual(await storedMessages(target), ['greeting']);
});

test('group chats get the same guard', async () => {
    const id = 'group-wipe';
    const header = { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'group-integrity' } };
    const history = makeMessages(3);
    assert.equal((await post('/group/save', { id, chat: [header, ...history] })).response.status, 200);

    const refused = await post('/group/save', { id, chat: [header, greeting] });
    assert.equal(refused.response.status, 409);
    assert.equal(refused.data.error, 'chat_wipe_rejected');
    const stored = await post('/group/get', { id });
    assert.deepEqual(stored.data.slice(1).map(message => message.mes), history.map(message => message.mes));

    assert.equal((await post('/group/save', { id, chat: [header, greeting], allow_shrink: true })).response.status, 200);
});

test('a chat that cannot be read is an error, not an empty chat', async () => {
    const { header, target } = characterChat('unreadable', 'integrity-d');
    assert.equal((await post('/save', { ...target, chat: [header, ...makeMessages(3)] })).response.status, 200);
    // The index still lists a chunk that is gone.
    const chunkDir = path.join(directories.chats, 'Character', 'unreadable.jsonl.chunks');
    for (const chunk of fs.readdirSync(chunkDir)) {
        fs.rmSync(path.join(chunkDir, chunk));
    }

    const loaded = await post('/get', target);
    assert.equal(loaded.response.status, 500);
    assert.equal(loaded.data.error, 'chat_load_failed');

    const missing = await post('/get', { ...target, file_name: 'never-created' });
    assert.equal(missing.response.status, 200);
    assert.deepEqual(missing.data, {});
});

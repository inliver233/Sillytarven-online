import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

// Chats loaded whole (chat paging off): the revision comes with the load and goes back with the save,
// so a save from a tab holding an older copy is refused instead of overwriting what another tab wrote.
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-full-save-revision-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.backups.chat.enabled = false;
config.performance.chatChunkingEnabled = false;
config.performance.chatPaging = { enabled: false };
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
        profile: { handle: 'full-save-revision-test', name: 'Revision Test', admin: true },
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

const header = { user_name: 'User', character_name: 'Alice', create_date: '2026-11-08', chat_metadata: { integrity: 'slug-1' } };
const message = (mes, isUser = true) => ({ name: isUser ? 'User' : 'Alice', is_user: isUser, mes, send_date: '2026-11-08' });
const target = { ch_name: 'Alice', avatar_url: 'alice.png', file_name: 'Alice - one' };

test('a whole-chat save with a stale revision is refused; the current one and no revision go through', async () => {
    // first save: no revision yet (a new chat)
    const first = await post('/save', { ...target, chat: [header, message('hello')] });
    assert.equal(first.response.status, 200);
    assert.equal(typeof first.data.revision, 'string');

    // a load hands out the revision in a header
    const loaded = await post('/get', target);
    assert.equal(loaded.response.status, 200);
    const loadedRevision = loaded.response.headers.get('x-chat-revision');
    assert.equal(loadedRevision, first.data.revision);
    assert.equal(loaded.data.length, 2);

    // tab A saves on top of what it loaded
    const fromA = await post('/save', { ...target, chat: [header, message('hello'), message('from A')], expectedRevision: loadedRevision });
    assert.equal(fromA.response.status, 200);
    assert.notEqual(fromA.data.revision, loadedRevision);

    // tab B still holds the copy it loaded before: refused, A's message stays
    const fromB = await post('/save', { ...target, chat: [header, message('hello'), message('from B')], expectedRevision: loadedRevision });
    assert.equal(fromB.response.status, 409);
    assert.equal(fromB.data.error, 'revision_conflict');
    assert.equal(fromB.data.currentRevision, fromA.data.revision);
    const afterB = await post('/get', target);
    assert.deepEqual(afterB.data.slice(1).map(item => item.mes), ['hello', 'from A']);

    // callers that send no revision (older pages, extensions) are not checked
    const unchecked = await post('/save', { ...target, chat: [header, message('hello'), message('from A'), message('from an extension')] });
    assert.equal(unchecked.response.status, 200);
});

test('group chats: the whole-chat load hands out the revision and a stale save is refused', async () => {
    const id = 'group-revision';
    const groupHeader = { user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: 'group-slug' } };
    const first = await post('/group/save', { id, chat: [groupHeader, message('hi')] });
    assert.equal(first.response.status, 200);
    const loaded = await post('/group/get', { id });
    const revision = loaded.response.headers.get('x-chat-revision');
    assert.equal(revision, first.data.revision);

    const fromA = await post('/group/save', { id, chat: [groupHeader, message('hi'), message('A')], expectedRevision: revision });
    assert.equal(fromA.response.status, 200);
    const fromB = await post('/group/save', { id, chat: [groupHeader, message('hi'), message('B')], expectedRevision: revision });
    assert.equal(fromB.response.status, 409);
    const stored = await post('/group/get', { id });
    assert.deepEqual(stored.data.slice(1).map(item => item.mes), ['hi', 'A']);
});

test('a save writes the revision the page proposed, so a retry after a lost answer is recognised', async () => {
    const chat = { ...target, file_name: 'Alice - retry' };
    const first = await post('/save', { ...chat, chat: [header, message('hello')] });
    const proposed = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const saved = await post('/save', { ...chat, chat: [header, message('hello'), message('again')], expectedRevision: first.data.revision, nextRevision: proposed });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.revision, proposed);
    // the same save sent again (its answer never arrived): refused, and the stored revision is the proposed one
    const retried = await post('/save', { ...chat, chat: [header, message('hello'), message('again')], expectedRevision: first.data.revision, nextRevision: proposed });
    assert.equal(retried.response.status, 409);
    assert.equal(retried.data.currentRevision, proposed);
    // not a UUID: a fresh one instead
    const odd = await post('/save', { ...chat, chat: [header, message('hello'), message('again'), message('more')], expectedRevision: proposed, nextRevision: '../x' });
    assert.equal(odd.response.status, 200);
    assert.match(odd.data.revision, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.notEqual(odd.data.revision, '../x');
});

test('a whole-chat save that holds only the end of a longer chat is refused (plain chat file)', async () => {
    const chat = { ...target, file_name: 'Alice - partial' };
    // Every message has the same date here, so the text tells the first one apart.
    const history = ['greeting', 'one', 'two', 'three', 'four'].map((text, index) => message(text, index % 2 === 1));
    assert.equal((await post('/save', { ...chat, chat: [header, ...history] })).response.status, 200);

    const refused = await post('/save', { ...chat, chat: [header, ...history.slice(3), message('reply', false)], force: false });
    assert.equal(refused.response.status, 409);
    assert.equal(refused.data.error, 'chat_partial_overwrite_rejected');
    assert.equal(refused.data.storedMessageCount, 5);
    const stored = await post('/get', chat);
    assert.deepEqual(stored.data.slice(1).map(item => item.mes), history.map(item => item.mes));

    assert.equal((await post('/save', { ...chat, chat: [header, ...history, message('reply', false)] })).response.status, 200);
});

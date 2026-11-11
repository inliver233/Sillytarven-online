import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-recent-pages-'));
const configPath = path.join(testRoot, 'config.yaml');
const config = parseYaml(fs.readFileSync(fileURLToPath(new URL('../default/config.yaml', import.meta.url)), 'utf8'));
config.backups.chat.enabled = false;
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
// The scan only needs the card file to exist.
fs.writeFileSync(path.join(directories.characters, 'Alice.png'), '');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((request, _response, next) => {
    request.user = { profile: { handle: 'recent-pages', name: 'Recent Pages', admin: true }, directories };
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
    const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { response, data: await response.json() };
}

// Chats 00..11, each saved a little later than the one before: 11 is the latest.
const header = { user_name: 'User', character_name: 'Alice', chat_metadata: { integrity: 'slug' } };
for (let i = 0; i < 12; i++) {
    const name = `chat-${String(i).padStart(2, '0')}`;
    await post('/save', { ch_name: 'Alice', avatar_url: 'Alice.png', file_name: name, chat: [header, { name: 'Alice', is_user: false, send_date: `d${i}`, mes: `m${i}` }] });
    const file = path.join(directories.chats, 'Alice', `${name}.jsonl`);
    const at = new Date(Date.UTC(2026, 10, 11, 0, i));
    fs.utimesSync(file, at, at);
}
// A chat outside any character folder is not listed on the welcome screen.
fs.writeFileSync(path.join(directories.chats, 'loose.jsonl'), JSON.stringify(header));

const names = data => data.map(chat => chat.file_name.replace('.jsonl', ''));

test('pages of recent chats, newest first, with the size of the whole list', async () => {
    const first = await post('/recent', { max: 5, offset: 0 });
    assert.equal(first.response.headers.get('x-recent-chats-total'), '12');
    assert.deepEqual(names(first.data), ['chat-11', 'chat-10', 'chat-09', 'chat-08', 'chat-07']);

    const last = await post('/recent', { max: 5, offset: 10 });
    assert.deepEqual(names(last.data), ['chat-01', 'chat-00']);
    assert.deepEqual((await post('/recent', { max: 5, offset: 20 })).data, []);
});

test('a pinned chat leads page one and counts as one of its entries', async () => {
    const pinned = [{ file_name: 'chat-02.jsonl', avatar: 'Alice.png' }];
    const first = await post('/recent', { max: 3, offset: 0, pinned });
    assert.deepEqual(names(first.data), ['chat-02', 'chat-11', 'chat-10']);
    assert.equal(first.response.headers.get('x-recent-chats-total'), '12');
    const second = await post('/recent', { max: 3, offset: 3, pinned });
    assert.deepEqual(names(second.data), ['chat-09', 'chat-08', 'chat-07']);
});

test('without an offset the list is as before: pinned chats on top of max, loose chats included', async () => {
    const pinned = [{ file_name: 'chat-02.jsonl', avatar: 'Alice.png' }];
    const { data } = await post('/recent', { max: 2, pinned });
    assert.deepEqual(names(data), ['chat-02', 'loose', 'chat-11']);
});

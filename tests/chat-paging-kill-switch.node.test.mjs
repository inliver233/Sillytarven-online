/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-chat-kill-switch-'));
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
setConfigFilePath(defaultConfigPath);
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');
const userRoot = path.join(testRoot, 'user');
const directories = {
    root: userRoot,
    groupChats: path.join(userRoot, 'group-chats'),
    backups: path.join(userRoot, 'backups'),
    characters: path.join(userRoot, 'characters'),
    chats: path.join(userRoot, 'chats'),
    groups: path.join(userRoot, 'groups'),
};
for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
}

const app = express();
app.use(express.json());
app.use((request, _response, next) => {
    request.user = {
        profile: { handle: 'kill-switch-test', name: 'Kill Switch Test', admin: true },
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
    return await fetch(`${baseUrl}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('chat paging protocol is disabled by default while full saves remain compatible', async () => {
    const header = {
        user_name: 'unused',
        character_name: 'unused',
        chat_metadata: { integrity: 'kill-switch' },
    };
    const message = { name: 'User', is_user: true, send_date: 1, mes: 'message' };

    const range = await post('/group/get-range', { id: 'disabled' });
    assert.equal(range.status, 404);
    assert.equal((await range.json()).error, 'chat_paging_disabled');

    const tail = await post('/group/save-tail', {
        id: 'disabled',
        header,
        messages: [message],
        before: 0,
        expectedRevision: null,
    });
    assert.equal(tail.status, 404);
    assert.equal(fs.existsSync(path.join(directories.groupChats, 'disabled.jsonl')), false);

    const full = await post('/group/save', { id: 'disabled', chat: [header, message] });
    assert.equal(full.status, 200);
    assert.equal(fs.existsSync(path.join(directories.groupChats, 'disabled.jsonl')), true);
});

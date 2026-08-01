/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
/* global globalThis */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-nonchunked-tail-'));
const configPath = path.join(testRoot, 'config.yaml');
const defaultConfigPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
const config = parseYaml(fs.readFileSync(defaultConfigPath, 'utf8'));
config.backups.chat.enabled = true;
config.backups.chat.throttleInterval = 0;
config.performance.chatChunkingEnabled = false;
config.performance.chatPaging = { enabled: true };
fs.writeFileSync(configPath, stringifyYaml(config));
setConfigFilePath(configPath);
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
app.use(express.json({ limit: '5mb' }));
app.use((request, _response, next) => {
    request.user = {
        profile: { handle: 'nonchunked-test', name: 'Nonchunked Test', admin: true },
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
    const data = JSON.parse(await response.text());
    return { response, data };
}

test('non-chunked tail save updates the main header and creates a current backup', async () => {
    const id = 'nonchunked-header';
    const header = {
        user_name: 'unused',
        character_name: 'unused',
        chat_metadata: { integrity: 'nonchunked-integrity', marker: 'initial' },
    };
    const messages = [0, 1, 2].map(index => ({
        name: index % 2 ? 'Character' : 'User',
        is_user: index % 2 === 0,
        send_date: 1_700_000_000_000 + index,
        mes: `message-${index}`,
    }));
    assert.equal((await post('/group/save', { id, chat: [header, ...messages] })).response.status, 200);
    for (const backup of fs.readdirSync(directories.backups)) {
        fs.unlinkSync(path.join(directories.backups, backup));
    }

    const page = await post('/group/get-range', { id, limit: 2 });
    const updatedHeader = {
        ...header,
        chat_metadata: { ...header.chat_metadata, marker: 'tail' },
    };
    const appended = {
        name: 'Character',
        is_user: false,
        send_date: 1_800_000_000_000,
        mes: 'appended',
    };
    const saved = await post('/group/save-tail', {
        id,
        header: updatedHeader,
        messages: [...page.data.messages, appended],
        before: page.data.cursor,
        expectedRevision: page.data.revision,
    });
    assert.equal(saved.response.status, 200);

    const filePath = path.join(directories.groupChats, `${id}.jsonl`);
    const mainHeader = JSON.parse(fs.readFileSync(filePath, 'utf8').split('\n')[0]);
    const sidecarHeader = JSON.parse(fs.readFileSync(`${filePath}.metadata.json`, 'utf8'));
    assert.equal(mainHeader.chat_metadata.marker, 'tail');
    assert.equal(mainHeader.chat_metadata.message_count, 4);
    assert.deepEqual(sidecarHeader, mainHeader);

    const backups = fs.readdirSync(directories.backups).filter(name => name.endsWith('.jsonl'));
    assert.equal(backups.length, 1);
    const backup = fs.readFileSync(path.join(directories.backups, backups[0]), 'utf8');
    assert.equal(backup.includes('"mes":"appended"'), true);
    assert.equal(backup.split('\n').filter(Boolean).length, 5);
});

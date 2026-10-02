import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';
import express from 'express';

import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-restore-upload-route-'));
setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
globalThis.DATA_ROOT = path.join(testRoot, 'data');
fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });

const { router: chatsRouter } = await import('../src/endpoints/chats.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');

const directories = Object.fromEntries(['root', 'groupChats', 'backups', 'characters', 'chats', 'groups']
    .map(name => [name, path.join(testRoot, 'user', name === 'root' ? '' : name)]));
Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));

const app = express();
app.use(express.json());
app.use((request, _response, next) => {
    request.user = { profile: { handle: 'restore-user', name: 'Restore User', admin: false }, directories };
    next();
});
app.use('/api/chats', chatsRouter);
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}/api/chats/restore-upload`;

after(async () => {
    await new Promise(resolve => server.close(resolve));
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(testRoot, { recursive: true, force: true });
});

async function zipOf(entries) {
    const archive = archiver('zip', { zlib: { level: 1 } });
    const parts = [];
    archive.on('data', part => parts.push(part));
    const done = new Promise((resolve, reject) => { archive.on('end', resolve); archive.on('error', reject); });
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    await archive.finalize();
    await done;
    return Buffer.concat(parts);
}

const json = async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, body: await response.json() };
};
const post = (url, body) => json(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (id, offset, data) => json(`${base}/${id}?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data });

test('a backup uploaded in chunks is restored in the background and its upload is deleted', async () => {
    const chat = '{"user_name":"U","character_name":"Bot"}\n{"name":"U","is_user":true,"mes":"hello"}\n{"name":"Bot","is_user":false,"mes":"hi"}';
    const zip = await zipOf({ 'chats/Bot/first.jsonl': chat, 'settings.json': '{}' });

    const started = await post(`${base}/start`, { size: zip.length });
    assert.equal(started.status, 200);
    const { id } = started.body;
    const middle = Math.floor(zip.length / 2);
    assert.equal((await put(id, 0, zip.subarray(0, middle))).body.received, middle);
    assert.equal((await post(`${base}/${id}/finish`, {})).status, 409, 'an incomplete upload is not restored');
    assert.equal((await put(id, middle, zip.subarray(middle))).body.received, zip.length);

    let status = (await post(`${base}/${id}/finish`, {})).body;
    for (let i = 0; i < 200 && ['queued', 'restoring'].includes(status.state); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        status = (await json(`${base}/${id}`)).body;
    }
    assert.equal(status.state, 'done', JSON.stringify(status));
    assert.equal(status.summary.chats.imported, 1);
    assert.match(fs.readFileSync(path.join(directories.chats, 'Bot', 'first.jsonl'), 'utf8'), /hello/);
    assert.deepEqual(fs.readdirSync(path.join(globalThis.DATA_ROOT, '_restore-uploads')), []);
});

test('a ZIP without chats fails with a readable reason, and a cancelled upload is removed', async () => {
    const zip = await zipOf({ 'settings.json': '{}' });
    const { body: { id } } = await post(`${base}/start`, { size: zip.length });
    await put(id, 0, zip);
    let status = (await post(`${base}/${id}/finish`, {})).body;
    for (let i = 0; i < 200 && ['queued', 'restoring'].includes(status.state); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        status = (await json(`${base}/${id}`)).body;
    }
    assert.equal(status.state, 'failed');
    assert.equal(status.error.code, 'no_chat_data');
    assert.match(status.error.message, /没有找到可恢复的对话数据/);

    const other = (await post(`${base}/start`, { size: 100 })).body.id;
    assert.equal((await json(`${base}/${other}`, { method: 'DELETE' })).status, 200);
    assert.equal((await json(`${base}/${other}`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(globalThis.DATA_ROOT, '_restore-uploads')), []);
});

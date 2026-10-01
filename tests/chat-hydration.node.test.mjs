import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-chat-hydration-'));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The server runs in its own process: the synchronous field loads below block this one.
const serverScript = fileURLToPath(new URL('./fixtures/chat-hydration-server.mjs', import.meta.url));
const serverProcess = spawn(process.execPath, [serverScript, repoRoot, testRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((resolve, reject) => {
    let output = '';
    serverProcess.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/PORT (\d+)/);
        if (match) resolve(Number(match[1]));
    });
    serverProcess.once('exit', code => reject(new Error(`test server exited (${code})`)));
});
const origin = `http://127.0.0.1:${port}`;
const { ChatHydrationSession, copyMessageForPrompt } = await import('../public/scripts/chat-hydration.js');

// The module talks to relative URLs and loads omitted fields with synchronous XHR.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => realFetch(`${origin}${url}`, options);
globalThis.XMLHttpRequest = class {
    open(method, url) { this.url = `${origin}${url}`; }
    setRequestHeader() { }
    send(body) {
        const script = 'const [u, b] = process.argv.slice(1); fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: b }).then(async r => process.stdout.write(JSON.stringify({ s: r.status, t: await r.text() })));';
        const result = JSON.parse(execFileSync(process.execPath, ['-e', script, this.url, body], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
        this.status = result.s;
        this.responseText = result.t;
    }
};

after(() => {
    globalThis.fetch = realFetch;
    serverProcess.kill();
    fs.rmSync(testRoot, { recursive: true, force: true });
});

const target = { ch_name: 'Hero', avatar_url: 'Hero.png', file_name: 'long' };
const header = { user_name: 'User', character_name: 'Hero', create_date: '2024-01-01@00h00m00s', chat_metadata: { integrity: 'hydration' } };

function makeMessage(i) {
    const message = { name: i % 2 ? 'User' : 'Hero', is_user: i % 2 === 1, send_date: i, mes: `m${i}`, extra: { n: i } };
    if (i % 10 === 0) {
        message.variables = [{ stat: i, log: 'v'.repeat(3000) }];
        message.extra.reasoning = `r${i}-${'x'.repeat(3000)}`;
        message.swipes = [message.mes, 's'.repeat(2500)];
        message.swipe_id = 0;
    }
    if (i === 20) {
        message.extra.image = '/user/images/old.png';
    }
    return message;
}

async function post(route, body) {
    const response = await fetch(`/api/chats${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
}

async function storedChat(fileName = 'long') {
    return (await post('/get', { ...target, file_name: fileName })).body.slice(1);
}

function normalizeMedia(message) {
    const extra = message?.extra;
    if (extra && Object.hasOwn(extra, 'image')) {
        extra.media = [...(extra.media ?? []), { type: 'image', url: extra.image }];
        delete extra.image;
    }
}

async function openSession() {
    const page = (await post('/get-range', { ...target, limit: 20 })).body;
    const session = new ChatHydrationSession({ isGroup: false, target, revision: page.revision, getHeaders: () => ({ 'content-type': 'application/json' }), normalizeMessage: normalizeMedia });
    const history = await session.loadHistory({ beforeLine: page.cursor });
    const chat = [...history, ...page.messages];
    session.history = history;
    session.serverOrder = chat.slice();
    session.hydrated = true;
    return { session, chat };
}

async function save(session, chat) {
    const prepared = session.prepareSave(chat, { header });
    const response = await fetch('/api/chats/save-patch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: prepared.body });
    const body = await response.json();
    if (response.ok) prepared.commit(body.revision); else prepared.rollback();
    return { status: response.status, body, prepared };
}

test('a hydrated chat is complete, omits bulky fields, and saves only what changed', async () => {
    const original = Array.from({ length: 450 }, (_, i) => makeMessage(i));
    assert.equal((await post('/save', { ...target, chat: [header, ...original] })).status, 200);

    const { session, chat } = await openSession();
    assert.equal(chat.length, 450);
    assert.deepEqual(chat.map(m => m.mes), original.map(m => m.mes));
    assert.deepEqual(chat[20].extra.media, [{ type: 'image', url: '/user/images/old.png' }], 'legacy media migrated on load');

    // Omitted fields read back exactly, and keys keep their order.
    assert.deepEqual(chat[40].variables, original[40].variables);
    assert.equal(chat[40].extra.reasoning, original[40].extra.reasoning);
    assert.deepEqual(Object.keys(chat[50]), Object.keys(original[50]));

    // Prompt copies never download omitted fields, but still read them on demand.
    const copy = copyMessageForPrompt(chat[60], { mes: 'prompt' });
    assert.equal(copy.mes, 'prompt');
    assert.deepEqual(copyMessageForPrompt(copy, { index: 1 }).swipes, original[60].swipes);

    // Plugin-style edits anywhere in the history.
    chat[3].mes = 'edited old';
    chat[40].variables[0].stat = 'changed in place';
    chat[70].extra.reasoning = 'replaced without reading';
    delete chat[80].swipes;
    const sendDate = chat[90].send_date;
    delete chat[90].send_date;
    chat[90].send_date = sendDate + 1; // delete + re-add
    chat[100].mes = String(chat[100].mes); // same value: no change
    chat[110].added = { nested: [1, 2] };
    chat.splice(5, 1);
    chat.splice(200, 0, { name: 'User', is_user: true, send_date: 1, mes: 'inserted' });
    chat.push({ name: 'Hero', is_user: false, send_date: 2, mes: 'pushed', extra: {} });

    const first = await save(session, chat);
    assert.equal(first.status, 200);
    assert.equal(first.prepared.from, 3, 'messages before the first change are not sent');
    const expected = JSON.parse(JSON.stringify(chat));
    assert.deepEqual(await storedChat(), expected);

    // Nothing changed: the save keeps every message by reference.
    const second = await save(session, chat);
    assert.equal(second.status, 200);
    assert.equal(second.prepared.items, 0);
    assert.deepEqual(await storedChat(), expected);

    // A fresh session sees exactly what was stored, including fields loaded on demand.
    const reopened = await openSession();
    assert.deepEqual(JSON.parse(JSON.stringify(reopened.chat)), expected);
});

test('stale saves and changed history are refused instead of overwriting', async () => {
    const { session, chat } = await openSession();
    // Another tab saves first.
    const other = await openSession();
    other.chat[0].mes = 'other tab';
    assert.equal((await save(other.session, other.chat)).status, 200);

    chat[1].mes = 'this tab';
    const stale = await save(session, chat);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, 'revision_conflict');
    assert.equal((await storedChat())[1].mes, other.chat[1].mes);

    // Omitted fields are matched by content hash; changed content is never returned.
    const fresh = await openSession();
    const index = fresh.chat.findIndex(m => Object.hasOwn(m, 'variables'));
    const stored = await storedChat();
    stored[index].variables = [{ stat: 'rewritten elsewhere' }];
    assert.equal((await post('/save', { ...target, chat: [header, ...stored] })).status, 200);
    let missing = 0;
    fresh.session.onMissingData = () => { missing++; };
    assert.throws(() => fresh.chat[index].variables, /no longer on the server/);
    assert.equal(missing, 1);

    // Malformed patches are rejected.
    const bad = await post('/save-patch', { ...target, header, expectedRevision: (await post('/get-range', { ...target })).body.revision, from: 0, items: [{ r: [0, 999999] }] });
    assert.equal(bad.status, 422);
});

test('branches copy a prefix on the server', async () => {
    const { chat } = await openSession();
    const result = await post('/copy-prefix', { ...target, target: 'branch', count: 31, header });
    assert.equal(result.status, 200);
    assert.deepEqual(await storedChat('branch'), JSON.parse(JSON.stringify(chat.slice(0, 31))));
    assert.equal((await post('/copy-prefix', { ...target, target: 'branch', count: 5, header })).status, 409);
});

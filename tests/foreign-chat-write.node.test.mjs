import assert from 'node:assert/strict';
import test from 'node:test';

import {
    chatWriteResponse,
    readForeignChatWrite,
    withOwnChatWriteHeader,
    writesOpenChatAsHeld,
} from '../public/scripts/foreign-chat-write.js';

const page = 'https://tavern.example/';
const header = { user_name: 'User', character_name: 'Alice', chat_metadata: { integrity: 'slug', table: { rows: 2 } } };
const messages = [
    { name: 'Alice', is_user: false, mes: 'hi', extra: { table: [1, 2] } },
    { name: 'User', is_user: true, mes: 'hello' },
];
// What Amily2's table system sends after a reply
const body = { ch_name: 'Alice', file_name: 'Alice - 1', avatar_url: 'alice.png', chat: [header, ...messages], force: false };
const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };

test('an extension writing a whole chat is recognised', async () => {
    const write = await readForeignChatWrite('/api/chats/save', init, page);
    assert.equal(write?.kind, 'character');
    assert.deepEqual(write.body, body);

    assert.equal((await readForeignChatWrite('api/chats/save', init, page))?.kind, 'character');
    assert.equal((await readForeignChatWrite(new URL('/api/chats/save', page), init, page))?.kind, 'character');
    assert.equal((await readForeignChatWrite(new Request(new URL('/api/chats/save', page), init), undefined, page))?.kind, 'character');
    const group = { ...init, body: JSON.stringify({ id: 'group-1', chat: messages }) };
    assert.equal((await readForeignChatWrite('/api/chats/group/save', group, page))?.kind, 'group');
});

test('the page’s own writes and other requests are left alone', async () => {
    const own = withOwnChatWriteHeader(init.headers);
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, headers: own }, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, headers: new Headers(own) }, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, headers: Object.entries(own) }, page), null);
    assert.equal(await readForeignChatWrite(new Request(new URL('/api/chats/save', page), { ...init, headers: own }), undefined, page), null);

    assert.equal(await readForeignChatWrite('/api/chats/save-patch', init, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/save-tail', init, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/get', init, page), null);
    assert.equal(await readForeignChatWrite('https://elsewhere.example/api/chats/save', init, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, method: 'GET', body: undefined }, page), null);
    // A compressed body (the page's own big saves) or one that is not a chat
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, body: new Uint8Array([31, 139]) }, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, body: '{not json' }, page), null);
    assert.equal(await readForeignChatWrite('/api/chats/save', { ...init, body: JSON.stringify({ file_name: 'x' }) }, page), null);
});

test('a write is the open chat as held when every message and the chat metadata match', () => {
    const write = { kind: 'character', body };
    const open = { messages: structuredClone(messages), metadata: structuredClone(header.chat_metadata) };
    assert.equal(writesOpenChatAsHeld(write, open), true);
    // The names in the file header do not matter: the page writes its own.
    const renamed = { kind: 'character', body: { ...body, chat: [{ ...header, user_name: 'Someone' }, ...messages] } };
    assert.equal(writesOpenChatAsHeld(renamed, open), true);

    assert.equal(writesOpenChatAsHeld(write, { ...open, messages: messages.slice(1) }), false);
    assert.equal(writesOpenChatAsHeld(write, { ...open, messages: [messages[0], { ...messages[1], mes: 'edited' }] }), false);
    assert.equal(writesOpenChatAsHeld(write, { ...open, messages: [{ ...messages[0], extra: { table: [1] } }, messages[1]] }), false);
    assert.equal(writesOpenChatAsHeld(write, { ...open, metadata: { integrity: 'slug' } }), false);
    assert.equal(writesOpenChatAsHeld({ kind: 'character', body: { ...body, chat: [] } }, { messages: [], metadata: {} }), false);
});

test('group chats may be written without a file header: then the messages decide', () => {
    const open = { messages, metadata: header.chat_metadata };
    assert.equal(writesOpenChatAsHeld({ kind: 'group', body: { id: 'group-1', chat: messages } }, open), true);
    assert.equal(writesOpenChatAsHeld({ kind: 'group', body: { id: 'group-1', chat: [header, ...messages] } }, open), true);
    assert.equal(writesOpenChatAsHeld({ kind: 'group', body: { id: 'group-1', chat: [header, messages[0]] } }, open), false);
});

test('the answer to the extension looks like the server’s', async () => {
    const saved = chatWriteResponse(200, { result: 'ok', revision: 'r1' });
    assert.equal(saved.ok, true);
    assert.equal(saved.headers.get('content-type'), 'application/json');
    assert.deepEqual(await saved.json(), { result: 'ok', revision: 'r1' });
    assert.equal(chatWriteResponse(409, { error: 'chat_not_ready' }).ok, false);
});

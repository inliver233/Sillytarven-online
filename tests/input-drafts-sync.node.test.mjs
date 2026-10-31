/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { router } from '../src/endpoints/input-drafts.js';
import { createInputDraftSync, inputDraftKey } from '../public/scripts/input-drafts.js';

const CHAT_X = inputDraftKey({ characterAvatar: 'Alice.png', chatId: 'Alice - 1' });
const CHAT_Y = inputDraftKey({ characterAvatar: 'Alice.png', chatId: 'Alice - 2' });

/** One server, and any number of devices (pages) talking to it through the real router. */
async function setup(t) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-input-drafts-sync-'));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = /** @type {any} */ ({ directories: { root } });
        next();
    });
    app.use('/api/input-drafts', router);
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
        listener.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/input-drafts`;
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    function device(clientId, { legacy } = {}) {
        const items = new Map(legacy === undefined ? [] : [['me_userInput', legacy]]);
        const page = { box: '', online: true, conflicts: /** @type {{ text: string, use: () => void }[]} */ ([]) };
        page.drafts = createInputDraftSync({
            request: async (method, body) => {
                if (!page.online) return null;
                const response = method === 'GET'
                    ? await fetch(`${baseUrl}?${new URLSearchParams({ key: body.key })}`)
                    : await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                return { status: response.status, data: await response.json() };
            },
            storage: { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) },
            storageKey: 'me_inputDrafts',
            legacyKey: 'me_userInput',
            getText: () => page.box,
            setText: text => { page.box = text; },
            onConflict: conflict => page.conflicts.push(conflict),
            clientId,
            pushDelay: 5,
        });
        page.type = async text => {
            page.box = text;
            page.drafts.input();
            await page.drafts.flush();
        };
        page.open = key => page.drafts.switchTo(key);
        page.storedText = key => JSON.parse(items.get('me_inputDrafts') ?? '{"entries":{}}').entries[key]?.text;
        page.legacyLeft = () => items.has('me_userInput');
        return page;
    }

    const serverText = async key => (await (await fetch(`${baseUrl}?${new URLSearchParams({ key })}`)).json()).text;
    return { device, serverText };
}

test('a draft started on one device continues on another, and sending it clears it everywhere', async t => {
    const { device, serverText } = await setup(t);
    const phone = device('phone');
    const pc = device('pc');
    await phone.open(CHAT_X);
    await phone.type('写到一半要出门');
    assert.equal(await serverText(CHAT_X), '写到一半要出门');

    await pc.open(CHAT_X);
    assert.equal(pc.box, '写到一半要出门', 'the other device picks the draft up when the chat opens');

    await pc.type('写到一半要出门，到家接着写');
    await phone.open(CHAT_X); // back to the page on the phone
    assert.equal(phone.box, '写到一半要出门，到家接着写', 'an untouched box follows the newer version');

    await pc.type(''); // sent
    await phone.open(CHAT_X);
    assert.equal(phone.box, '', 'a sent message is not offered again');
    assert.deepEqual([...phone.conflicts, ...pc.conflicts], []);
});

test('each chat keeps its own draft', async t => {
    const { device } = await setup(t);
    const pc = device('pc');
    await pc.open(CHAT_X);
    await pc.type('for X');
    await pc.open(CHAT_Y);
    assert.equal(pc.box, '');
    await pc.type('for Y');
    await pc.open(CHAT_X);
    assert.equal(pc.box, 'for X');
    await pc.open('none');
    assert.equal(pc.box, '');

    const phone = device('phone');
    await phone.open(CHAT_Y);
    assert.equal(phone.box, 'for Y');
});

test('two different versions are never overwritten silently', async t => {
    const { device, serverText } = await setup(t);
    const phone = device('phone');
    const pc = device('pc');
    await phone.open(CHAT_X);
    await phone.type('draft');
    await pc.open(CHAT_X);

    // The phone loses signal and keeps typing; meanwhile the PC writes its own version.
    phone.online = false;
    await phone.type('draft, phone version');
    await pc.type('draft, PC version');
    phone.online = true;
    await phone.open(CHAT_X);

    assert.equal(phone.box, 'draft, phone version', 'what is on screen stays');
    assert.equal(await serverText(CHAT_X), 'draft, PC version', 'and the other version is not overwritten');
    assert.equal(phone.conflicts.length, 1);
    assert.equal(phone.conflicts[0].text, 'draft, PC version');

    // Taking the offered version.
    phone.conflicts[0].use();
    await phone.drafts.flush();
    assert.equal(phone.box, 'draft, PC version');
    await phone.open(CHAT_X);
    assert.equal(phone.conflicts.length, 1, 'asked only once');

    // Typing on after the question keeps the version on screen.
    phone.online = false;
    await phone.type('phone again');
    await pc.type('PC again');
    phone.online = true;
    await phone.open(CHAT_X);
    assert.equal(phone.conflicts.length, 2);
    await phone.type('phone again, kept');
    assert.equal(await serverText(CHAT_X), 'phone again, kept');
    await pc.open(CHAT_X);
    assert.equal(pc.box, 'phone again, kept');
    assert.equal(pc.conflicts.length, 0);
});

test('sending on a device that missed a newer draft neither asks nor pulls that draft in', async t => {
    const { device, serverText } = await setup(t);
    const phone = device('phone');
    const pc = device('pc');
    await phone.open(CHAT_X);
    await phone.type('abc');
    await pc.open(CHAT_X);
    await pc.type('abcd');

    phone.online = false;
    await phone.type(''); // sends "abc" with the PC's version unseen
    phone.online = true;
    await phone.open(CHAT_X);
    assert.equal(phone.box, '');
    assert.equal(phone.conflicts.length, 0);
    assert.equal(await serverText(CHAT_X), 'abcd', 'the PC keeps its newer draft');

    // A later change on the PC does reach the phone's empty box.
    await pc.type('abcde');
    await phone.open(CHAT_X);
    assert.equal(phone.box, 'abcde');
});

test('a conflict found after leaving a chat is asked about when the chat is open again', async t => {
    const { device, serverText } = await setup(t);
    const phone = device('phone');
    const pc = device('pc');
    await phone.open(CHAT_X);
    await phone.type('one');
    await pc.open(CHAT_X);
    await pc.type('two');

    phone.online = false;
    await phone.type('one, edited');
    phone.online = true;
    await phone.open(CHAT_Y); // the save of X on the way out is refused
    assert.equal(phone.conflicts.length, 0);
    assert.equal(await serverText(CHAT_X), 'two');

    await phone.open(CHAT_X);
    assert.equal(phone.box, 'one, edited');
    assert.equal(phone.conflicts.length, 1);
    assert.equal(phone.conflicts[0].text, 'two');
});

test('the single draft older versions kept moves into the first chat opened', async t => {
    const { device, serverText } = await setup(t);
    const pc = device('pc', { legacy: 'from before the update' });
    await pc.open('none');
    assert.equal(pc.box, '', 'not on the screen without a chat');
    assert.ok(pc.legacyLeft());
    await pc.open(CHAT_X);
    assert.equal(pc.box, 'from before the update');
    assert.ok(!pc.legacyLeft());
    assert.equal(pc.storedText(CHAT_X), 'from before the update');
    assert.equal(await serverText(CHAT_X), 'from before the update');
});

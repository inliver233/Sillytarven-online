import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { WebSocket } from 'ws';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-live-'));
globalThis.DATA_ROOT = dataRoot;
const configPath = path.join(dataRoot, 'config.yaml');
fs.writeFileSync(configPath, 'live:\n  enabled: true\n');
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configPath);
const { LiveHub, live, normalizeNotice, normalizeReload, normalizeTarget, router } = await import('../src/live.js');
process.once('exit', () => fs.rmSync(dataRoot, { recursive: true, force: true }));

/** A started hub on a local server, without its timers (the tests drive them). */
async function setup(t) {
    fs.rmSync(path.join(dataRoot, '_global'), { recursive: true, force: true });
    const hub = new LiveHub();
    hub.key = crypto.randomBytes(32);
    hub.start();
    hub.timers.forEach(timer => clearInterval(timer));
    hub.timers = [];
    const server = http.createServer((request, response) => response.writeHead(request.url === '/plain' ? 200 : 404).end('ordinary'));
    hub.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const sockets = [];
    t.after(async () => {
        sockets.forEach(ws => ws.terminate());
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

    /**
     * Opens a page's connection.
     * @param {{handle: string, admin?: boolean}|string} who User, or a raw ticket
     * @param {{age?: number, pathname?: string}} [options]
     */
    const connect = (who, { age = 0, pathname = '/api/live' } = {}) => new Promise((resolve, reject) => {
        const ticket = typeof who === 'string' ? who : hub.issueTicket(who);
        const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}?ticket=${encodeURIComponent(ticket)}&age=${age}`);
        sockets.push(ws);
        const messages = [];
        ws.on('message', raw => messages.push(JSON.parse(String(raw))));
        const closed = new Promise(done => ws.once('close', code => done(code)));
        /** Waits for the next message of a type, skipping pings; fails if another type comes first. */
        const next = async (type, ms = 2000) => {
            const until = Date.now() + ms;
            while (Date.now() < until) {
                const index = messages.findIndex(message => message.t !== 'ping');
                if (index >= 0) {
                    const [message] = messages.splice(index, 1);
                    assert.equal(message.t, type, `expected ${type}, got ${JSON.stringify(message)}`);
                    return message;
                }
                await new Promise(done => setTimeout(done, 5));
            }
            throw new Error(`no ${type} message`);
        };
        ws.once('open', () => resolve({ ws, messages, next, closed }));
        ws.once('unexpected-response', (_request, response) => reject(Object.assign(new Error('refused'), { status: response.statusCode })));
        ws.once('error', reject);
    });
    return { hub, connect, port };
}

test('commands are checked and cleaned', () => {
    assert.deepEqual(normalizeTarget(), { all: true });
    assert.deepEqual(normalizeTarget({ admins: true }), { admins: true });
    assert.deepEqual(normalizeTarget({ handles: 'alice, bob，alice  carol' }), { handles: ['alice', 'bob', 'carol'] });
    assert.equal(normalizeTarget({ handles: [] }), null);
    assert.equal(normalizeTarget('all'), null);
    assert.deepEqual(normalizeReload({}), { delay: 5, message: '', wait: true });
    assert.deepEqual(normalizeReload({ delay: 9999, message: ' 更新了\u0007 ', wait: false }), { delay: 300, message: '更新了', wait: false });
    assert.equal(normalizeNotice({ text: '   ' }), null);
    assert.deepEqual(normalizeNotice({ text: '第一行\n第二行', level: 'bogus', timeout: -5 }), { text: '第一行\n第二行', title: '', level: 'info', timeout: 0 });
});

test('a ticket lets a page connect; others are refused', async t => {
    const { hub, connect } = await setup(t);
    const page = await connect({ handle: 'alice' });
    assert.deepEqual((await page.next('hello')).d, { heartbeat: 30000 });
    assert.equal(hub.clients.size, 1);

    const forged = hub.issueTicket({ handle: 'alice' }).replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
    await assert.rejects(connect(forged), { status: 401 });
    await assert.rejects(connect('not-a-ticket'), { status: 401 });
    await assert.rejects(connect({ handle: 'alice' }, { pathname: '/somewhere-else' }), { status: 404 });

    const realNow = Date.now;
    const old = (() => {
        Date.now = () => realNow() - 61e3;
        try {
            return hub.issueTicket({ handle: 'alice' });
        } finally {
            Date.now = realNow;
        }
    })();
    await assert.rejects(connect(old), { status: 401 });
    assert.equal(hub.clients.size, 1);
});

test('other upgrade requests stay ordinary requests', async t => {
    const { port } = await setup(t);
    const ask = upgrade => new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /plain HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: ${upgrade}\r\n\r\n`));
        let reply = '';
        socket.on('data', chunk => {
            reply += chunk;
            if (reply.includes('ordinary')) socket.destroy();
        });
        socket.on('close', () => resolve(reply.split('\r\n')[0]));
    });
    assert.equal(await ask('h2c'), 'HTTP/1.1 200 OK');
    assert.equal(await ask('websocket'), 'HTTP/1.1 200 OK');
});

test('messages go to the pages of the target, and pages can send messages back', async t => {
    const { hub, connect } = await setup(t);
    const alice = await connect({ handle: 'alice' });
    const alice2 = await connect({ handle: 'alice' });
    const boss = await connect({ handle: 'boss', admin: true });
    for (const page of [alice, alice2, boss]) await page.next('hello');

    assert.equal(hub.send({ all: true }, 'x', 1), 3);
    assert.equal(hub.send({ handles: ['alice', 'nobody'] }, 'y'), 2);
    assert.equal(hub.send({ admins: true }, 'z', { a: 1 }), 1);
    assert.deepEqual(await alice.next('x'), { t: 'x', d: 1 });
    assert.deepEqual(await alice.next('y'), { t: 'y' });
    assert.deepEqual(await boss.next('x'), { t: 'x', d: 1 });
    assert.deepEqual(await boss.next('z'), { t: 'z', d: { a: 1 } });

    hub.on('echo', (client, data) => client.send('echo', { data, handle: client.handle }));
    boss.ws.send(JSON.stringify({ t: 'echo', d: 42 }));
    assert.deepEqual((await boss.next('echo')).d, { data: 42, handle: 'boss' });
    boss.ws.send('not json');
    boss.ws.send(JSON.stringify({ t: 'unknown' }));

    assert.deepEqual(hub.status().users, [{ handle: 'alice', pages: 2 }, { handle: 'boss', pages: 1 }]);
    assert.equal(hub.status().admins, 1);
});

test('the heartbeat drops pages that went quiet', async t => {
    const { hub, connect } = await setup(t);
    const quiet = await connect({ handle: 'quiet' });
    const awake = await connect({ handle: 'awake' });
    const quietClient = [...hub.clients].find(client => client.handle === 'quiet');
    quietClient.heardAt = Date.now() - 80e3;
    hub.heartbeat();
    assert.equal(await quiet.closed, 1006);
    await awake.next('hello');
    assert.deepEqual(awake.messages.shift(), { t: 'ping' });
    assert.deepEqual([...hub.clients].map(client => client.handle), ['awake']);
});

test('a kept command reaches pages that were open but not connected, once', async t => {
    const { hub, connect } = await setup(t);
    const result = hub.dispatch({ type: 'reload', data: { delay: 1 } });
    assert.equal(result.pages, 0);
    assert.equal(result.kept, true);

    // Loaded a minute ago, reconnecting now (asleep, or the server restarted): gets it.
    const old = await connect({ handle: 'alice' }, { age: 60e3 });
    await old.next('hello');
    assert.deepEqual(await old.next('reload'), { t: 'reload', d: { delay: 1, message: '', wait: true }, id: result.id });

    // Loaded after the command (for example because of it): does not.
    const fresh = await connect({ handle: 'alice' }, { age: 0 });
    await fresh.next('hello');
    hub.send({ all: true }, 'marker');
    await fresh.next('marker');

    // Not kept: only the pages connected at the time.
    const notice = hub.dispatch({ type: 'notice', data: { text: 'hi' }, target: { handles: ['alice'] } });
    assert.equal(notice.kept, false);
    assert.equal(notice.pages, 2);
    assert.equal((await fresh.next('notice')).id, notice.id);
    const later = await connect({ handle: 'alice' }, { age: 60e3 });
    await later.next('hello');
    assert.equal((await later.next('reload')).id, result.id);
    hub.send({ all: true }, 'marker');
    await later.next('marker');

    // Kept on disk for the process taking over; can be called back.
    const file = path.join(dataRoot, '_global', 'live', 'kept.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);
    assert.equal(new LiveHub().loadKept()[0].id, result.id);
    assert.equal(hub.cancel(result.id), true);
    assert.equal(hub.cancel(result.id), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);

    assert.deepEqual(hub.dispatch({ type: 'eval', data: {} }), { error: 'unknown_type' });
    assert.deepEqual(hub.dispatch({ type: 'reload', target: { handles: [] } }), { error: 'bad_target' });
    assert.deepEqual(hub.dispatch({ type: 'notice', data: { text: '' } }), { error: 'bad_data' });
});

test('a late notice also reaches people who come online later, until each account has seen it', async t => {
    const { hub, connect } = await setup(t);
    hub.on('echo', (client, data) => client.send('echo', data));
    const alice = await connect({ handle: 'alice' });
    await alice.next('hello');
    const result = hub.dispatch({ type: 'notice', data: { text: '空间已提到 5 GB', timeout: 0 }, target: { handles: ['alice', 'bob'] }, late: true });
    assert.equal(result.pages, 1);
    assert.equal(result.kept, true);
    assert.equal(result.late, true);
    assert.deepEqual(await alice.next('notice'), { t: 'notice', d: { text: '空间已提到 5 GB', title: '', level: 'info', timeout: 0 }, id: result.id, late: true });

    // bob was not online: a page he opens later gets it.
    const bob = await connect({ handle: 'bob' }, { age: 0 });
    await bob.next('hello');
    assert.equal((await bob.next('notice')).id, result.id);
    // So does another page of alice's, as long as she has not closed it anywhere.
    const alice2 = await connect({ handle: 'alice' }, { age: 0 });
    await alice2.next('hello');
    assert.equal((await alice2.next('notice')).id, result.id);

    // alice closes it: her other page takes it down, her pages opened later do not get it.
    alice.ws.send(JSON.stringify({ t: 'seen', d: { id: result.id } }));
    assert.deepEqual(await alice2.next('seen'), { t: 'seen', d: { id: result.id } });
    const alice3 = await connect({ handle: 'alice' }, { age: 0 });
    await alice3.next('hello');
    assert.deepEqual(await alice3.next('seen'), { t: 'seen', d: { id: result.id } });
    hub.send({ all: true }, 'marker');
    await alice3.next('marker');
    await alice.next('marker');

    // Not for others; their "seen" counts for nothing.
    const carol = await connect({ handle: 'carol' }, { age: 0 });
    await carol.next('hello');
    carol.ws.send(JSON.stringify({ t: 'seen', d: { id: result.id } }));
    carol.ws.send(JSON.stringify({ t: 'echo', d: 1 }));
    await carol.next('echo');
    alice.ws.send(JSON.stringify({ t: 'seen', d: { id: result.id } }));
    alice.ws.send(JSON.stringify({ t: 'echo', d: 1 }));
    await alice.next('echo');
    const [kept] = hub.status().kept;
    assert.deepEqual([kept.seen, kept.seenCount, kept.late], [['alice'], 1, true]);

    // On disk for the process taking over, with who has seen it.
    const reloaded = new LiveHub().loadKept().find(command => command.id === result.id);
    assert.deepEqual([reloaded.late, reloaded.seen], [true, ['alice']]);

    // Kept 7 days unless told otherwise, 30 at most; a reload cannot be sent late.
    const days = command => Math.round((command.until - command.at) / 86400e3);
    assert.equal(days(hub.kept.find(command => command.id === result.id)), 7);
    const long = hub.dispatch({ type: 'notice', data: { text: 'x' }, target: { all: true }, late: true, keep: 999 * 86400 });
    assert.equal(days(hub.kept.find(command => command.id === long.id)), 30);
    assert.equal(hub.status().kept.find(command => command.id === long.id).seen, undefined);
    assert.deepEqual(hub.dispatch({ type: 'reload', late: true }), { error: 'not_late' });
});

test('command files in the outbox are sent and removed', async t => {
    const { hub, connect } = await setup(t);
    const page = await connect({ handle: 'alice' });
    await page.next('hello');
    const outbox = path.join(dataRoot, '_global', 'live', 'outbox');
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, 'a.json'), JSON.stringify({ type: 'notice', data: { text: '维护' }, target: { handles: ['alice'] }, keep: 0 }));
    fs.writeFileSync(path.join(outbox, 'b.json'), '{"type": "rel');
    hub.readOutbox();
    assert.equal((await page.next('notice')).d.text, '维护');
    assert.deepEqual(fs.readdirSync(outbox), ['b.json']);

    // A broken file is retried for a while (it may still be being written), then dropped.
    const old = new Date(Date.now() - 120e3);
    fs.utimesSync(path.join(outbox, 'b.json'), old, old);
    hub.readOutbox();
    assert.deepEqual(fs.readdirSync(outbox), []);
});

test('handing over closes pages with 1012 so they reconnect at once', async t => {
    const { hub, connect } = await setup(t);
    const page = await connect({ handle: 'alice' });
    hub.stop();
    assert.equal(await page.closed, 1012);
    assert.equal(hub.clients.size, 0);
});

test('tickets for everybody, commands for administrators', async t => {
    live.enabled = true;
    live.key = crypto.randomBytes(32);
    t.after(() => {
        live.enabled = false;
    });
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const admin = request.get('x-test-admin') === '1';
        request.user = { profile: { handle: admin ? 'boss' : 'alice', admin } };
        next();
    });
    app.use('/api/live', router);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api/live`;

    const { ticket } = await (await fetch(`${base}/ticket`)).json();
    assert.deepEqual(live.readTicket(ticket), { handle: 'alice', admin: false });
    const post = (pathname, body, admin) => fetch(`${base}/${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-admin': admin ? '1' : '0' },
        body: JSON.stringify(body),
    });
    assert.equal((await post('send', { type: 'reload' }, false)).status, 403);
    assert.equal((await fetch(`${base}/status`)).status, 403);
    const sent = await post('send', { type: 'reload', keep: 0 }, true);
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).pages, 0);
    assert.equal((await post('send', { type: 'nope' }, true)).status, 400);
    assert.equal((await post('cancel', { id: 'nope' }, true)).status, 404);
    const status = await (await fetch(`${base}/status`, { headers: { 'x-test-admin': '1' } })).json();
    assert.deepEqual(status.commands, [{ type: 'reload', keep: 3600 }, { type: 'notice', keep: 0, late: true }]);

    live.enabled = false;
    assert.equal((await fetch(`${base}/ticket`)).status, 404);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('stcontrol keeps the page-presence heartbeat alive while standalone idle behavior is unchanged', () => {
    const source = fs.readFileSync(new URL('../public/scripts/user-heartbeat.js', import.meta.url), 'utf8');
    const listeners = new Map();
    const document = {
        hidden: false,
        readyState: 'loading',
        addEventListener(name, callback) { listeners.set(name, callback); },
        querySelector() { return null; },
    };
    const window = {
        addEventListener(name, callback) { listeners.set(name, callback); },
    };
    const context = {
        Boolean,
        Date,
        console: { log() {}, warn() {} },
        document,
        fetch: async () => ({ ok: true }),
        navigator: { userAgent: 'test' },
        setInterval: () => 1,
        clearInterval() {},
        setTimeout() {},
        window,
    };
    vm.runInNewContext(source, context, { filename: 'user-heartbeat.js' });

    const heartbeat = window.userHeartbeat.init();
    heartbeat.lastActivity = Date.now() - heartbeat.inactivityThreshold - 1;
    let sent = 0;
    heartbeat.sendHeartbeat = () => sent++;

    heartbeat.checkAndSendHeartbeat();
    assert.equal(sent, 0, 'standalone idle behavior changed');
    window.userHeartbeat.setStcontrolEnabled(true);
    heartbeat.checkAndSendHeartbeat();
    assert.equal(sent, 1, 'managed page presence was not reported');
});

test('managed heartbeat applies public foreground/background timing and stops a stale sleeping page', async () => {
    const source = fs.readFileSync(new URL('../public/scripts/user-heartbeat.js', import.meta.url), 'utf8');
    const listeners = new Map();
    const intervals = [];
    const alerts = [];
    const redirects = [];
    const events = [];
    const document = {
        hidden: false,
        readyState: 'loading',
        addEventListener(name, callback) { listeners.set(name, callback); },
        querySelector() { return null; },
    };
    const window = {
        addEventListener(name, callback) { listeners.set(name, callback); },
        alert(message) { alerts.push(message); },
        dispatchEvent(event) { events.push(event.type); },
        location: { assign(url) { redirects.push(url); } },
    };
    const context = {
        Boolean,
        CustomEvent: class { constructor(type) { this.type = type; } },
        Date,
        Number,
        console: { log() {}, warn() {} },
        document,
        fetch: async () => ({ ok: true }),
        navigator: { userAgent: 'test' },
        setInterval: (_callback, delay) => { intervals.push(delay); return intervals.length; },
        clearInterval() {},
        setTimeout(callback, delay) { if (delay === 0) callback(); },
        window,
    };
    vm.runInNewContext(source, context, { filename: 'user-heartbeat.js' });

    window.userHeartbeat.setStcontrolEnabled(true, {
        foregroundHeartbeatMs: 30_000,
        backgroundHeartbeatMs: 40_000,
    }, 'https://controller.example.test/login');
    const heartbeat = window.userHeartbeat.init();
    heartbeat.start();
    assert.equal(intervals.at(-1), 30_000);

    document.hidden = true;
    listeners.get('visibilitychange')();
    assert.equal(intervals.at(-1), 40_000);

    context.fetch = async () => ({ ok: false, status: 409 });
    await heartbeat.sendHeartbeat();
    assert.equal(heartbeat.stcontrolSessionStale, true);
    assert.equal(heartbeat.isActive, false);
    assert.equal(alerts.length, 1);
    assert.deepEqual(events, ['stcontrol-session-stale']);
    assert.deepEqual(redirects, ['https://controller.example.test/login']);

    const intervalCount = intervals.length;
    heartbeat.recordActivity();
    assert.equal(intervals.length, intervalCount, 'activity must not silently restart a stale managed page');
});

test('managed heartbeat keeps retrying transient network failures while standalone behavior is unchanged', async () => {
    const source = fs.readFileSync(new URL('../public/scripts/user-heartbeat.js', import.meta.url), 'utf8');
    const document = {
        hidden: true,
        readyState: 'loading',
        addEventListener() {},
        querySelector() { return null; },
    };
    const window = { addEventListener() {} };
    const context = {
        Boolean,
        Date,
        Number,
        console: { log() {}, warn() {} },
        document,
        fetch: async () => { throw new TypeError('Failed to fetch'); },
        navigator: { userAgent: 'test' },
        setInterval: () => 1,
        clearInterval() {},
        setTimeout() {},
        window,
    };
    vm.runInNewContext(source, context, { filename: 'user-heartbeat.js' });
    const heartbeat = window.userHeartbeat.init();
    heartbeat.start();
    await heartbeat.sendHeartbeat();
    assert.equal(heartbeat.isActive, false, 'standalone network behavior changed');

    window.userHeartbeat.setStcontrolEnabled(true);
    heartbeat.start();
    await heartbeat.sendHeartbeat();
    assert.equal(heartbeat.isActive, true, 'managed page stopped retrying after a transient network failure');
});

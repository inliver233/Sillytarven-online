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
        URLSearchParams,
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
        URLSearchParams,
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
        URLSearchParams,
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

test('admin-only stcontrol pages do not auto-start user heartbeat and user.js imports the production entry', () => {
    const heartbeatSource = fs.readFileSync(new URL('../public/scripts/user-heartbeat.js', import.meta.url), 'utf8');
    const userSource = fs.readFileSync(new URL('../public/scripts/user.js', import.meta.url), 'utf8');
    const document = {
        hidden: false,
        readyState: 'loading',
        addEventListener() {},
        querySelector() { return null; },
    };
    const window = {
        addEventListener() {},
        location: { search: '?stcontrol_admin=1' },
    };
    const context = {
        Boolean,
        Date,
        Number,
        URLSearchParams,
        console: { log() {}, warn() {} },
        document,
        fetch: async () => ({ ok: true }),
        navigator: { userAgent: 'test' },
        setInterval: () => 1,
        clearInterval() {},
        setTimeout() {},
        window,
    };
    vm.runInNewContext(heartbeatSource, context, { filename: 'user-heartbeat.js' });
    assert.equal(window.userHeartbeat.forceStart(), null);
    assert.match(userSource, /import '\.\/user-heartbeat\.js';/);
    assert.match(userSource, /stcontrol_admin/);
});

test('the controller admin-only page never starts a heartbeat, so it is not sent back to the controller', () => {
    const source = fs.readFileSync(new URL('../public/scripts/user-heartbeat.js', import.meta.url), 'utf8');
    const listeners = new Map();
    const document = {
        hidden: false,
        readyState: 'loading',
        addEventListener(name, callback) { listeners.set(name, callback); },
        querySelector() { return null; },
    };
    const window = {
        location: { search: '?stcontrol_admin=1' },
        addEventListener(name, callback) { listeners.set(name, callback); },
    };
    let requests = 0;
    const context = {
        Boolean,
        Date,
        console: { log() {}, warn() {} },
        document,
        fetch: async () => { requests++; return { ok: true }; },
        navigator: { userAgent: 'test' },
        setInterval: () => 1,
        clearInterval() {},
        setTimeout() {},
        URLSearchParams,
        window,
    };
    vm.runInNewContext(source, context, { filename: 'user-heartbeat.js' });

    const heartbeat = window.userHeartbeat.init();
    heartbeat.start();
    heartbeat.recordActivity();
    listeners.get('visibilitychange')?.();
    assert.equal(requests, 0, 'a heartbeat was sent from the admin-only page');
    assert.equal(window.userHeartbeat.forceStart(), null);
});

/**
 * Runs user-heartbeat.js in a page with the Controller address in a meta tag, session storage,
 * and just enough DOM for the notice it may put on screen.
 * @param {Record<string, string>} session Session storage contents
 */
function loadStalePage(session = {}) {
    const source = fs.readFileSync(new URL('../public/scripts/user-heartbeat.js', import.meta.url), 'utf8');
    const redirects = [];
    const appended = [];
    const element = () => ({ style: {}, children: [], setAttribute(name, value) { this[name] = value; }, append(...nodes) { this.children.push(...nodes); } });
    const document = {
        hidden: false,
        readyState: 'loading',
        addEventListener() {},
        querySelector: selector => selector === 'meta[name="stcontrol-controller-url"]' ? { getAttribute: () => 'https://controller.example.test' } : null,
        getElementById: id => appended.find(node => node.id === id) ?? null,
        createElement: element,
        body: { append: node => appended.push(node) },
    };
    const window = {
        addEventListener() {},
        dispatchEvent() {},
        location: { assign(url) { redirects.push(url); } },
        sessionStorage: { getItem: key => session[key] ?? null, setItem: (key, value) => { session[key] = String(value); } },
        toastr: { error() {} },
    };
    vm.runInNewContext(source, {
        Boolean, CustomEvent: class { constructor(type) { this.type = type; } }, Date, Number, console: { log() {}, warn() {} },
        document, fetch: async () => ({ ok: true }), navigator: { userAgent: 'test' },
        setInterval: () => 1, clearInterval() {}, setTimeout(callback, delay) { if (delay === 0) callback(); },
        URLSearchParams, window,
    }, { filename: 'user-heartbeat.js' });
    return { window, redirects, appended, session };
}

test('a page that goes stale before it knows the Controller is sent to the address in the page', () => {
    // A new tab: no session storage yet, and /api/users/me never answered.
    const page = loadStalePage();
    page.window.userHeartbeat.handleStcontrolSessionStale();
    assert.deepEqual(page.redirects, ['https://controller.example.test']);
    assert.ok(Number(page.session.stcontrolStaleRedirectAt) > 0);
    assert.equal(page.appended.length, 0);
});

test('a page stale again right after the Controller is not bounced back, it shows a way there', () => {
    const page = loadStalePage({ stcontrolStaleRedirectAt: String(Date.now() - 5_000) });
    page.window.userHeartbeat.handleStcontrolSessionStale();
    assert.deepEqual(page.redirects, [], 'no redirect loop');
    assert.equal(page.appended.length, 1);
    const notice = page.appended[0];
    assert.equal(notice.id, 'stcontrol-stale-notice');
    const link = notice.children[0].children.find(child => child.href);
    assert.equal(link.href, 'https://controller.example.test');

    const later = loadStalePage({ stcontrolStaleRedirectAt: String(Date.now() - 120_000) });
    later.window.userHeartbeat.handleStcontrolSessionStale();
    assert.deepEqual(later.redirects, ['https://controller.example.test'], 'a minute later it goes again');
});

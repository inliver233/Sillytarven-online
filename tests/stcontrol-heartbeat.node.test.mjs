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

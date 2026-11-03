/* eslint-disable playwright/expect-expect -- Node test runner uses assert instead of Playwright expect. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { runExtensionActivateHook } from '../public/scripts/util/extension-hooks.js';

test('an extension without hooks is left as it was', async () => {
    let loaded = false;
    const load = async () => { loaded = true; return {}; };
    assert.equal(await runExtensionActivateHook('third-party/plain', { js: 'index.js' }, load), false);
    assert.equal(await runExtensionActivateHook('third-party/plain', { hooks: {} }, load), false);
    assert.equal(loaded, false, 'its module is not even asked for');
});

test('hooks.activate runs the exported function once and waits for it', async () => {
    const calls = [];
    const module = {
        async init() {
            calls.push('init started');
            await new Promise(resolve => setTimeout(resolve, 10));
            calls.push('init done');
        },
    };
    assert.equal(await runExtensionActivateHook('third-party/st-catiecli-tasks', { hooks: { activate: 'init' } }, async () => module), true);
    assert.deepEqual(calls, ['init started', 'init done'], 'activation waits, so extensions that depend on it start after');
});

test('a hook that cannot run fails the activation with a reason', async () => {
    const module = { init: 'not a function' };
    await assert.rejects(runExtensionActivateHook('third-party/x', { hooks: { activate: 'start' } }, async () => module), /names "start"/);
    await assert.rejects(runExtensionActivateHook('third-party/x', { hooks: { activate: 'init' } }, async () => module), /does not export as a function/);
    await assert.rejects(runExtensionActivateHook('third-party/x', { hooks: { activate: 42 } }, async () => module), /must be the name/);
    await assert.rejects(runExtensionActivateHook('third-party/x', { hooks: { activate: 'init' } }, async () => { throw new Error('module failed'); }), /module failed/);
    await assert.rejects(runExtensionActivateHook('third-party/x', { hooks: { activate: 'init' } }, async () => ({ init() { throw new Error('init failed'); } })), /init failed/);
});

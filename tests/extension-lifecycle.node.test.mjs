/* eslint-disable playwright/no-conditional-in-test -- Fake-timer tests must wait for scheduled hook callbacks. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createExtensionAssetLoader,
    createExtensionLifecycle,
    EXTENSION_HOOK_STATUS,
    EXTENSION_HOOK_TIMEOUT,
    EXTENSION_LIFECYCLE_STATE,
} from '../public/scripts/util/extension-lifecycle.js';

function descriptor({ hooks = { activate: 'activate' }, enabled = true } = {}) {
    return {
        canonicalName: 'third-party/demo',
        shortName: 'demo',
        type: 'local',
        manifest: { js: 'index.js', hooks, nested: { isolated: true } },
        resourceBaseUrl: '/scripts/extensions/third-party/demo',
        enabled,
    };
}

test('hook status values match the public lifecycle contract', () => {
    assert.deepEqual(new Set(Object.values(EXTENSION_HOOK_STATUS)), new Set([
        'ok', 'skipped', 'invalid-hook', 'missing-export', 'rejected', 'timeout',
    ]));
});

test('lifecycle supports synchronous, asynchronous, zero-argument, and legacy activation', async () => {
    let zeroArgumentCount;
    for (const [module, expected] of [
        [{ activate() { zeroArgumentCount = arguments.length; } }, EXTENSION_HOOK_STATUS.OK],
        [{ async activate() {} }, EXTENSION_HOOK_STATUS.OK],
        [{}, EXTENSION_HOOK_STATUS.SKIPPED],
    ]) {
        const item = descriptor({ hooks: module.activate ? { activate: 'activate' } : {} });
        const lifecycle = createExtensionLifecycle({ importModule: async () => module });
        lifecycle.discover([item]);
        const result = await lifecycle.activate(item);
        assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
        assert.equal(result.hookStatus, expected);
    }
    assert.equal(zeroArgumentCount, 1, 'hook context remains ignorable by zero-argument functions');
});

test('malformed hook declarations report invalid-hook while missing hooks are skipped', async () => {
    for (const hooks of [null, [], { activate: 42 }, { activate: '' }]) {
        const item = descriptor({ hooks });
        const lifecycle = createExtensionLifecycle({ importModule: async () => ({}) });
        const result = await lifecycle.activate(item);
        assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.FAILED);
        assert.equal(result.hookStatus, EXTENSION_HOOK_STATUS.INVALID_HOOK);
    }

    const item = descriptor({ hooks: {} });
    const lifecycle = createExtensionLifecycle({ importModule: async () => ({}) });
    const result = await lifecycle.activate(item);
    assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
    assert.equal(result.hookStatus, EXTENSION_HOOK_STATUS.SKIPPED);
});

test('activation never becomes active when import, export, sync, or async execution fails', async () => {
    const faults = [
        {
            importModule: async () => { throw new Error('import failed'); },
            hooks: { activate: 'activate' },
            expected: EXTENSION_HOOK_STATUS.REJECTED,
        },
        {
            importModule: async () => ({}),
            hooks: { activate: 'missing' },
            expected: EXTENSION_HOOK_STATUS.MISSING_EXPORT,
        },
        {
            importModule: async () => ({ activate() { throw new Error('sync failed'); } }),
            hooks: { activate: 'activate' },
            expected: EXTENSION_HOOK_STATUS.REJECTED,
        },
        {
            importModule: async () => ({ activate: async () => { throw new Error('async failed'); } }),
            hooks: { activate: 'activate' },
            expected: EXTENSION_HOOK_STATUS.REJECTED,
        },
    ];

    for (const fault of faults) {
        const item = descriptor({ hooks: fault.hooks });
        const lifecycle = createExtensionLifecycle({ importModule: fault.importModule });
        const result = await lifecycle.activate(item);
        assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.FAILED);
        assert.equal(result.hookStatus, fault.expected);
        assert.notEqual(lifecycle.getStatus(item).status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
        assert.ok(result.error?.message);
    }
});

test('hook timeout is exactly 5000ms, aborts cooperatively, and ignores late rejection', async () => {
    let scheduledDelay;
    let fireTimeout;
    let receivedSignal;
    let rejectLate;
    const item = descriptor();
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({
            activate({ signal }) {
                receivedSignal = signal;
                return new Promise((_resolve, reject) => {
                    rejectLate = reject;
                });
            },
        }),
        setTimeoutImpl(callback, delay) {
            scheduledDelay = delay;
            fireTimeout = callback;
            return 1;
        },
        clearTimeoutImpl() {},
    });

    const activation = lifecycle.activate(item);
    while (!fireTimeout || !receivedSignal) {
        await Promise.resolve();
    }
    assert.equal(EXTENSION_HOOK_TIMEOUT, 5000);
    assert.equal(scheduledDelay, 5000);
    assert.equal(receivedSignal.aborted, false);
    fireTimeout();

    const result = await activation;
    assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.FAILED);
    assert.equal(result.hookStatus, EXTENSION_HOOK_STATUS.TIMEOUT);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(receivedSignal.reason.name, 'TimeoutError');

    rejectLate(new Error('late rejection'));
    await Promise.resolve();
});

test('concurrent identity and phase calls deduplicate module import and hook execution', async () => {
    let imports = 0;
    let activations = 0;
    let release;
    const item = descriptor();
    const lifecycle = createExtensionLifecycle({
        importModule: async () => {
            imports++;
            return {
                activate: async () => {
                    activations++;
                    await new Promise(resolve => { release = resolve; });
                },
            };
        },
    });

    const first = lifecycle.activate(item);
    const second = lifecycle.activate(structuredClone(item));
    while (!release) {
        await Promise.resolve();
    }
    release();
    assert.deepEqual(await Promise.all([first, second]), [await first, await first]);
    assert.equal(imports, 1);
    assert.equal(activations, 1);
});

test('deactivation requested during activation runs afterward and leaves the identity inactive', async () => {
    const calls = [];
    let releaseActivation;
    const item = descriptor({ hooks: { activate: 'activate', disable: 'disable' } });
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({
            async activate() {
                calls.push('activate:start');
                await new Promise(resolve => { releaseActivation = resolve; });
                calls.push('activate:end');
            },
            disable() {
                calls.push('disable');
            },
        }),
    });

    const activation = lifecycle.activate(item);
    const deactivation = lifecycle.deactivate(item);
    while (!releaseActivation) {
        await Promise.resolve();
    }

    assert.deepEqual(calls, ['activate:start']);
    releaseActivation();
    assert.equal((await activation).status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
    assert.equal((await deactivation).status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
    assert.deepEqual(calls, ['activate:start', 'activate:end', 'disable']);
    assert.equal(lifecycle.getStatus(item).status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
});

test('enable, disable, enable preserves the final enable intent', async () => {
    const calls = [];
    let releaseActivation;
    const item = descriptor({
        enabled: false,
        hooks: { enable: 'enable', activate: 'activate', disable: 'disable' },
    });
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({
            enable() {
                calls.push('enable');
            },
            async activate() {
                calls.push('activate:start');
                if (!releaseActivation) {
                    await new Promise(resolve => { releaseActivation = resolve; });
                }
                calls.push('activate:end');
            },
            disable() {
                calls.push('disable');
            },
        }),
    });

    const firstEnable = lifecycle.enable(item);
    const disable = lifecycle.disable(item);
    const finalEnable = lifecycle.enable(item);
    assert.notStrictEqual(finalEnable, firstEnable);
    while (!releaseActivation) {
        await Promise.resolve();
    }

    releaseActivation();
    await Promise.all([firstEnable, disable, finalEnable]);
    assert.deepEqual(calls, [
        'enable', 'activate:start', 'activate:end', 'disable',
        'enable', 'activate:start', 'activate:end',
    ]);
    assert.equal(lifecycle.getStatus(item).status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
});

test('disable, enable, disable preserves the final disable intent', async () => {
    const calls = [];
    let disableCount = 0;
    let releaseDisable;
    const item = descriptor({
        hooks: { enable: 'enable', activate: 'activate', disable: 'disable' },
    });
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({
            enable() {
                calls.push('enable');
            },
            activate() {
                calls.push('activate');
            },
            async disable() {
                disableCount++;
                calls.push(`disable:${disableCount}:start`);
                if (disableCount === 1) {
                    await new Promise(resolve => { releaseDisable = resolve; });
                }
                calls.push(`disable:${disableCount}:end`);
            },
        }),
    });
    await lifecycle.enable(item);
    calls.length = 0;

    const firstDisable = lifecycle.disable(item);
    const enable = lifecycle.enable(item);
    const finalDisable = lifecycle.disable(item);
    assert.notStrictEqual(finalDisable, firstDisable);
    while (!releaseDisable) {
        await Promise.resolve();
    }

    releaseDisable();
    await Promise.all([firstDisable, enable, finalDisable]);
    assert.deepEqual(calls, [
        'disable:1:start', 'disable:1:end', 'enable', 'activate',
        'disable:2:start', 'disable:2:end',
    ]);
    assert.equal(lifecycle.getStatus(item).status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
});

test('update waits for activation and concurrent update calls deduplicate', async () => {
    let releaseActivation;
    let pulls = 0;
    const item = descriptor();
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({
            activate: () => new Promise(resolve => { releaseActivation = resolve; }),
        }),
    });

    const activation = lifecycle.activate(item);
    const pullUpdate = async () => {
        pulls++;
        return { isUpToDate: true };
    };
    const firstUpdate = lifecycle.update(item, pullUpdate);
    const secondUpdate = lifecycle.update(structuredClone(item), pullUpdate);
    while (!releaseActivation) {
        await Promise.resolve();
    }

    assert.equal(pulls, 0);
    releaseActivation();
    await activation;
    assert.deepEqual(await Promise.all([firstUpdate, secondUpdate]), [await firstUpdate, await firstUpdate]);
    assert.equal(pulls, 1);
    assert.equal(lifecycle.getStatus(item).status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
});

test('asset loader recognizes server-rendered styles and deduplicates locale loading', async () => {
    const elements = new Map();
    let appendedStyles = 0;
    let fetches = 0;
    let resolveFetch;
    const localeData = [];
    const loader = createExtensionAssetLoader({
        document: {
            getElementById: id => elements.get(id) ?? null,
            createElement: () => ({}),
            head: {
                appendChild(link) {
                    appendedStyles++;
                    elements.set(link.id, link);
                },
            },
        },
        fetch: async () => {
            fetches++;
            await new Promise(resolve => { resolveFetch = resolve; });
            return { ok: true, json: async () => ({ greeting: 'Hello' }) };
        },
        sanitizeSelector: value => value,
        getCurrentLocale: () => 'en',
        addLocaleData: (locale, data) => localeData.push([locale, data]),
        logger: { log() {} },
    });

    elements.set('third-party/demo-css', { id: 'third-party/demo-css', sheet: {} });
    await loader.addStyle('third-party/demo', { css: 'style.css' });
    assert.equal(appendedStyles, 0);

    const manifest = { i18n: { en: 'en.json' } };
    const firstLocale = loader.addLocale('third-party/demo', manifest);
    const secondLocale = loader.addLocale('third-party/demo', manifest);
    assert.strictEqual(secondLocale, firstLocale);
    while (!resolveFetch) {
        await Promise.resolve();
    }
    resolveFetch();
    await Promise.all([firstLocale, secondLocale]);
    await loader.addLocale('third-party/demo', manifest);

    assert.equal(fetches, 1);
    assert.deepEqual(localeData, [['en', { greeting: 'Hello' }]]);
});

test('concurrent style loads share a promise and append one link', async () => {
    const elements = new Map();
    const appendedStyles = [];
    const loader = createExtensionAssetLoader({
        document: {
            getElementById: id => elements.get(id) ?? null,
            createElement: () => ({
                remove() {
                    elements.delete(this.id);
                },
            }),
            head: {
                appendChild(link) {
                    appendedStyles.push(link);
                    elements.set(link.id, link);
                },
            },
        },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        sanitizeSelector: value => value,
        getCurrentLocale: () => 'en',
        addLocaleData() {},
    });

    const first = loader.addStyle('third-party/demo', { css: 'style.css' });
    const second = loader.addStyle('third-party/demo', { css: 'style.css' });
    assert.strictEqual(second, first);
    assert.equal(appendedStyles.length, 1);

    appendedStyles[0].onload();
    await Promise.all([first, second]);
    await loader.addStyle('third-party/demo', { css: 'style.css' });
    assert.equal(appendedStyles.length, 1);
});

test('failed style loads remove the link and retry with a fresh node', async () => {
    const elements = new Map();
    const appendedStyles = [];
    let removals = 0;
    const loader = createExtensionAssetLoader({
        document: {
            getElementById: id => elements.get(id) ?? null,
            createElement: () => ({
                remove() {
                    removals++;
                    elements.delete(this.id);
                },
            }),
            head: {
                appendChild(link) {
                    appendedStyles.push(link);
                    elements.set(link.id, link);
                },
            },
        },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        sanitizeSelector: value => value,
        getCurrentLocale: () => 'en',
        addLocaleData() {},
    });

    const first = loader.addStyle('third-party/demo', { css: 'style.css' });
    const failedLink = appendedStyles[0];
    failedLink.onerror(new Error('style failed'));
    const retry = loader.addStyle('third-party/demo', { css: 'style.css' });
    await assert.rejects(first, /style failed/);
    assert.equal(removals, 1);

    const retryLink = appendedStyles[1];
    assert.strictEqual(elements.get(failedLink.id), retryLink);
    assert.notStrictEqual(retry, first);
    assert.notStrictEqual(retryLink, failedLink);
    retryLink.onload();
    await retry;
    assert.equal(appendedStyles.length, 2);
});

test('existing stylesheet nodes without a sheet wait for their load event', async () => {
    const existingLink = { id: 'third-party/demo-css', sheet: null };
    let settled = false;
    const loader = createExtensionAssetLoader({
        document: {
            getElementById: () => existingLink,
            createElement: () => ({}),
            head: { appendChild() { assert.fail('must reuse the existing link'); } },
        },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        sanitizeSelector: value => value,
        getCurrentLocale: () => 'en',
        addLocaleData() {},
    });

    const load = loader.addStyle('third-party/demo', { css: 'style.css' });
    load.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);

    existingLink.onload();
    await load;
    assert.equal(settled, true);
});

test('deactivate records reload requirement when its hook is missing', async () => {
    const item = descriptor({ hooks: {} });
    const lifecycle = createExtensionLifecycle({ importModule: async () => ({}) });
    await lifecycle.activate(item);

    const result = await lifecycle.deactivate(item);
    assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED);
    assert.equal(result.hookStatus, EXTENSION_HOOK_STATUS.SKIPPED);
});

test('reload-required prevents disable then enable from repeating module side effects', async () => {
    let imports = 0;
    let activations = 0;
    const item = descriptor({ hooks: { activate: 'activate' } });
    const lifecycle = createExtensionLifecycle({
        importModule: async () => {
            imports++;
            return { activate() { activations++; } };
        },
    });
    await lifecycle.activate(item);
    const deactivated = await lifecycle.deactivate(item);
    assert.equal(deactivated.status, EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED);

    lifecycle.discover([{ ...item, enabled: true }]);
    const reactivated = await lifecycle.activate({ ...item, enabled: true });
    assert.equal(reactivated.status, EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED);
    assert.equal(reactivated.hookStatus, EXTENSION_HOOK_STATUS.SKIPPED);
    assert.equal(imports, 1);
    assert.equal(activations, 1);
});

test('failed lifecycle work does not prevent a later disable transition', async () => {
    const item = descriptor();
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({ activate: async () => { throw new Error('failed'); } }),
    });
    await lifecycle.activate(item);

    const result = await lifecycle.deactivate(item);
    assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
});

test('active update pulls first, reuses namespace, and requires reload without another import', async () => {
    const calls = [];
    let imports = 0;
    const namespace = {
        activate() { calls.push('activate'); },
        update() { calls.push('update'); },
    };
    const item = descriptor({ hooks: { activate: 'activate', update: 'update' } });
    const lifecycle = createExtensionLifecycle({
        importModule: async () => {
            imports++;
            return namespace;
        },
    });
    await lifecycle.activate(item);

    const result = await lifecycle.update(item, async () => {
        calls.push('pull');
        return { isUpToDate: false };
    });

    assert.deepEqual(calls, ['activate', 'pull', 'update']);
    assert.equal(imports, 1);
    assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED);
});

test('inactive update never imports the extension module', async () => {
    let imports = 0;
    const item = descriptor({ enabled: false });
    const lifecycle = createExtensionLifecycle({ importModule: async () => { imports++; return {}; } });
    lifecycle.discover([item]);
    lifecycle.setEligibility(item, false);

    const result = await lifecycle.update(item, async () => ({ isUpToDate: false }));
    assert.equal(imports, 0);
    assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
});

test('official install, enable, activate, deactivate, clean, and delete hooks run in lifecycle order', async () => {
    const calls = [];
    const item = descriptor({
        enabled: false,
        hooks: {
            install: 'install',
            enable: 'enable',
            activate: 'activate',
            deactivate: 'deactivate',
            clean: 'clean',
            delete: 'remove',
        },
    });
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({
            install: () => calls.push('install'),
            enable: () => calls.push('enable'),
            activate: () => calls.push('activate'),
            deactivate: () => calls.push('deactivate'),
            clean: () => calls.push('clean'),
            remove: () => calls.push('delete'),
        }),
    });
    lifecycle.discover([item]);

    assert.equal((await lifecycle.install(item)).hookStatus, EXTENSION_HOOK_STATUS.OK);
    assert.equal((await lifecycle.enable(item)).status, EXTENSION_LIFECYCLE_STATE.ACTIVE);
    assert.equal((await lifecycle.disable(item)).status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
    assert.equal((await lifecycle.clean(item)).status, EXTENSION_LIFECYCLE_STATE.RELOAD_REQUIRED);
    const deletion = await lifecycle.delete(item, async () => calls.push('server'), { clean: true });

    assert.equal(deletion.status, EXTENSION_LIFECYCLE_STATE.INACTIVE);
    assert.deepEqual(calls, ['install', 'enable', 'activate', 'deactivate', 'clean', 'clean', 'delete', 'server']);
});

test('configured disable and update hook failures remain failed lifecycle results', async () => {
    for (const hookName of ['disable', 'update']) {
        const item = descriptor({ hooks: { activate: 'activate', [hookName]: hookName } });
        const lifecycle = createExtensionLifecycle({
            importModule: async () => ({
                activate() {},
                [hookName]() { throw new Error(`${hookName} failed`); },
            }),
        });
        await lifecycle.activate(item);

        const result = hookName === 'disable'
            ? await lifecycle.disable(item)
            : await lifecycle.update(item, async () => ({ isUpToDate: false }));
        assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.FAILED);
        assert.equal(result.hookStatus, EXTENSION_HOOK_STATUS.REJECTED);
        assert.match(result.error.message, new RegExp(`${hookName} failed`));
    }
});

test('clean or delete hook failure prevents the server delete operation', async () => {
    for (const failingHook of ['clean', 'delete']) {
        const calls = [];
        const item = descriptor({ hooks: { clean: 'clean', delete: 'remove' } });
        const lifecycle = createExtensionLifecycle({
            importModule: async () => ({
                clean() {
                    calls.push('clean');
                    if (failingHook === 'clean') throw new Error('clean failed');
                },
                remove() {
                    calls.push('delete');
                    if (failingHook === 'delete') throw new Error('delete failed');
                },
            }),
        });

        const result = await lifecycle.delete(item, async () => calls.push('server'), { clean: true });
        assert.equal(result.status, EXTENSION_LIFECYCLE_STATE.FAILED);
        assert.equal(result.deleteResponse, null);
        assert.equal(calls.includes('server'), false);
        assert.deepEqual(calls, failingHook === 'clean' ? ['clean'] : ['clean', 'delete']);
    }
});

test('status and hook descriptors cannot mutate lifecycle manifest state', async () => {
    let hookDescriptor;
    const item = descriptor();
    const lifecycle = createExtensionLifecycle({
        importModule: async () => ({ activate(context) { hookDescriptor = context.descriptor; } }),
    });
    lifecycle.discover([item]);
    item.manifest.nested.isolated = false;
    await lifecycle.activate(lifecycle.listStatuses()[0].descriptor);
    hookDescriptor.manifest.nested.isolated = false;
    const status = lifecycle.listStatuses()[0];
    status.descriptor.manifest.nested.isolated = false;

    assert.equal(lifecycle.listStatuses()[0].descriptor.manifest.nested.isolated, true);
});

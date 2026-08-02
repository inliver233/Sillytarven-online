import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const extensionRoot = path.join(root, 'public', 'scripts', 'extensions');
const builtins = [
    'memory',
    'quick-reply',
    'regex',
    'stable-diffusion',
    'translate',
    'tts',
    'vectors',
];

function readBuiltin(name, file) {
    return fs.readFileSync(path.join(extensionRoot, name, file), 'utf8');
}

function extractInitializer(source, name) {
    const match = source.match(/export function init\(\) \{\s*initPromise \?\?= initInternal\(\);\s*return initPromise;\s*\}/);
    assert.ok(match, `${name} must export the memoized initializer contract`);
    return match[0];
}

test('batch B manifests activate the exported init hook', () => {
    for (const name of builtins) {
        const manifest = JSON.parse(readBuiltin(name, 'manifest.json'));
        assert.equal(manifest.hooks?.activate, 'init', `${name} activate hook`);
    }
});

test('batch B entrypoints use the shared lifecycle gate and have no unconditional startup', () => {
    for (const name of builtins) {
        const source = readBuiltin(name, 'index.js');
        assert.match(source, /import \{ isExtensionLifecycleEnabled \} from '\.\.\/feature-gate\.js';/, `${name} gate import`);
        assert.match(source, /let initPromise = null;/, `${name} promise cache`);
        assert.match(source, /async function initInternal\(\)|const initInternal = async \(\) =>/, `${name} internal initializer`);
        extractInitializer(source, name);
        assert.match(source, /if \(!isExtensionLifecycleEnabled\(\)\) \{/, `${name} legacy-only startup guard`);
        assert.doesNotMatch(source, /jQuery\(async (?:function )?\(/, `${name} unconditional DOM-ready initializer`);
    }

    const loggedLegacyBuiltins = builtins.filter(name => name !== 'quick-reply');
    for (const name of loggedLegacyBuiltins) {
        assert.match(readBuiltin(name, 'index.js'), /init\(\)\.catch\(error => console\.error\(/, `${name} legacy startup rejection handler`);
    }

    const quickReply = readBuiltin('quick-reply', 'index.js');
    assert.match(quickReply, /if \(!isExtensionLifecycleEnabled\(\)\) \{\s*await init\(\);/s, 'quick reply preserves gate-aware top-level failure propagation');
    assert.doesNotMatch(quickReply, /^await init\(\);/m, 'quick reply has no unconditional top-level init');
});

test('batch B initializers reuse the first promise and execute once', async () => {
    for (const name of builtins) {
        const source = readBuiltin(name, 'index.js');
        const initializer = extractInitializer(source, name);
        const moduleSource = `
            let initPromise = null;
            let calls = 0;
            const result = { name: ${JSON.stringify(name)} };
            const initInternal = () => {
                calls++;
                return Promise.resolve(result);
            };
            ${initializer}
            export { calls, result };
        `;
        const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}#${name}`;
        const imported = await import(moduleUrl);
        const first = imported.init();
        const second = imported.init();
        assert.strictEqual(second, first, `${name} must return the same promise`);
        assert.strictEqual(await first, imported.result, `${name} initializer result`);
        assert.equal(imported.calls, 1, `${name} must initialize once`);
    }
});

test('batch B lifecycle failures reject and remain memoized', async () => {
    for (const name of builtins) {
        const source = readBuiltin(name, 'index.js');
        const initializer = extractInitializer(source, name);
        const moduleSource = `
            let initPromise = null;
            let calls = 0;
            const failure = new Error(${JSON.stringify(`${name} failed`)});
            const initInternal = () => {
                calls++;
                return Promise.reject(failure);
            };
            ${initializer}
            export { calls, failure };
        `;
        const moduleUrl = `data:text/javascript,${encodeURIComponent(moduleSource)}#failure-${name}`;
        const imported = await import(moduleUrl);
        const first = imported.init();
        const second = imported.init();
        assert.strictEqual(second, first, `${name} must retain the failed promise`);
        await assert.rejects(first, error => error === imported.failure, `${name} lifecycle failure`);
        assert.equal(imported.calls, 1, `${name} failed initialization must not restart`);
    }
});

test('one-time network, worker, and registration setup remains inside memoized lifecycle bodies', () => {
    const quickReply = readBuiltin('quick-reply', 'index.js');
    const stableDiffusion = readBuiltin('stable-diffusion', 'index.js');
    const tts = readBuiltin('tts', 'index.js');
    const vectors = readBuiltin('vectors', 'index.js');

    assert.ok(quickReply.indexOf('await loadSets();') > quickReply.indexOf('const initInternal = async () =>'), 'quick reply network load is lifecycle-owned');
    assert.ok(stableDiffusion.indexOf('await addSDGenButtons();') > stableDiffusion.indexOf('async function initInternal()'), 'stable diffusion setup is lifecycle-owned');
    assert.ok(tts.indexOf('setInterval(wrapper.update.bind(wrapper), UPDATE_INTERVAL)') > tts.indexOf('async function initInternal()'), 'TTS worker interval is lifecycle-owned');
    assert.ok(vectors.indexOf('const template = await renderExtensionTemplateAsync(MODULE_NAME, \'settings\');') > vectors.indexOf('async function initInternal()'), 'vectors setup is lifecycle-owned');
});

/* eslint-disable playwright/no-conditional-in-test -- Source contracts intentionally validate each builtin. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const BUILTINS = [
    'assets',
    'attachments',
    'caption',
    'connection-manager',
    'expressions',
    'gallery',
    'token-counter',
];

const READY_BUILTINS = new Set([
    'assets',
    'attachments',
    'caption',
    'token-counter',
]);

const extensionsUrl = new URL('../public/scripts/extensions/', import.meta.url);

async function readBuiltinFile(name, file) {
    return readFile(new URL(`${name}/${file}`, extensionsUrl), 'utf8');
}

test('batch A enumerates exactly the seven requested builtins', () => {
    assert.deepEqual(BUILTINS, [
        'assets',
        'attachments',
        'caption',
        'connection-manager',
        'expressions',
        'gallery',
        'token-counter',
    ]);
});

for (const builtin of BUILTINS) {
    test(`${builtin} declares a gated, idempotent lifecycle activation hook`, async () => {
        const manifest = JSON.parse(await readBuiltinFile(builtin, 'manifest.json'));
        const source = await readBuiltinFile(builtin, 'index.js');

        assert.deepEqual(manifest.hooks, { activate: 'init' });
        assert.match(source, /export function init\s*\(\)\s*\{/);
        assert.match(source, /initPromise\s*\?\?=\s*initialize\(\)/);
        assert.match(source, /import \{ isExtensionLifecycleEnabled \} from '\.\.\/feature-gate\.js';/);
        assert.match(source, /if\s*\(\s*!isExtensionLifecycleEnabled\(\)\s*\)/);
        assert.equal(source.match(/void init\(\)/g)?.length, 1);

        if (READY_BUILTINS.has(builtin)) {
            assert.match(source, /if\s*\(\s*!isExtensionLifecycleEnabled\(\)\s*\)\s*\{\s*jQuery\(\(\)\s*=>\s*\{\s*void init\(\)\.catch\([\s\S]*?\);\s*\}\);\s*\}/);
            assert.equal(source.match(/\bjQuery\s*\(/g)?.length, 1);
        } else {
            assert.match(source, /if\s*\(\s*!isExtensionLifecycleEnabled\(\)\s*\)\s*\{\s*void init\(\)\.catch\(/s);
            assert.doesNotMatch(source, /\bjQuery\s*\(/);
        }

        assert.doesNotMatch(source, /\bjQuery\s*\(\s*async\b/);
        assert.doesNotMatch(source, /^\s*\((?:async\s+)?function\s*\(\)\s*\{/m);
    });
}

function extractInitializer(source) {
    const match = source.match(/export function init\(\)\s*\{\s*initPromise \?\?= initialize\(\);\s*return initPromise;\s*\}/);
    assert.ok(match, 'token-counter must export the memoized initializer contract');
    return match[0];
}

test('an importable batch A initializer performs its underlying setup once', async () => {
    const source = await readBuiltinFile('token-counter', 'index.js');
    const initializer = extractInitializer(source);
    const moduleSource = `
        let initPromise;
        let calls = 0;
        const initialize = async () => {
            calls++;
            return 'initialized';
        };
        ${initializer}
        export { calls };
    `;
    const imported = await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);

    const first = imported.init();
    const second = imported.init();
    assert.strictEqual(second, first);
    assert.equal(await first, 'initialized');
    assert.equal(imported.calls, 1);
});

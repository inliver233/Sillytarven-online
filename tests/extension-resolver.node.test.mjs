import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createExtensionDescriptors,
    createExtensionResolver,
    getExtensionIdentity,
    setExtensionEnabled,
} from '../public/scripts/util/extension-resolver.js';

function manifest(name) {
    return { display_name: name, nested: { isolated: true } };
}

test('resolver creates the public descriptor contract and stable internal identity', () => {
    const descriptors = createExtensionDescriptors([
        { name: 'regex', type: 'system' },
        { name: 'third-party/demo', type: 'global' },
    ], {
        regex: manifest('Regex'),
        'third-party/demo': manifest('Demo'),
    }, { disabledExtensions: ['third-party/demo'] });

    assert.equal(descriptors[0].type, 'builtin');
    assert.deepEqual(descriptors[1], {
        canonicalName: 'third-party/demo',
        shortName: 'demo',
        type: 'global',
        manifest: manifest('Demo'),
        resourceBaseUrl: '/scripts/extensions/third-party/demo',
        enabled: false,
    });
    assert.equal(getExtensionIdentity(descriptors[1]), 'global:third-party/demo');
});

test('normalized exact names win and short aliases resolve only when unique', () => {
    const descriptors = createExtensionDescriptors([
        { name: 'Demo', type: 'system' },
        { name: 'third-party/demo', type: 'local' },
    ], {
        Demo: manifest('Built-in Demo'),
        'third-party/demo': manifest('Third-party Demo'),
    });
    const resolver = createExtensionResolver(descriptors);

    assert.equal(resolver.resolve('demo').canonicalName, 'Demo');
    assert.equal(resolver.resolve('DEMO').type, 'builtin');
    assert.equal(resolver.resolve('third-party/demó').canonicalName, 'third-party/demo');

    const ambiguous = createExtensionResolver([
        ...descriptors,
        { ...descriptors[1], canonicalName: 'vendor/demo', shortName: 'alias' },
        { ...descriptors[1], canonicalName: 'other/demo', shortName: 'alias' },
    ]);
    assert.equal(ambiguous.resolve('alias'), null);
});

test('local discovery shadows global consistently while typed exact identity remains available', () => {
    const descriptors = createExtensionDescriptors([
        { name: 'third-party/Demó', type: 'global' },
        { name: 'third-party/demo', type: 'local' },
    ], { 'third-party/demo': manifest('Demo') });
    const resolver = createExtensionResolver(descriptors);

    assert.equal(descriptors.length, 2);
    assert.equal(resolver.resolve('third-party/DEMO').type, 'local');
    assert.equal(resolver.resolve('demo').type, 'local');
    assert.equal(resolver.resolve('global:third-party/demo').type, 'global');
    assert.equal(resolver.resolve('third-party/demó', 'local').canonicalName, 'third-party/demo');
    assert.deepEqual(new Set(resolver.list().map(descriptor => descriptor.type)), new Set(['global', 'local']));
});

test('enabled updates rebuild descriptors without mutating prior snapshots', () => {
    const descriptors = createExtensionDescriptors([
        { name: 'third-party/demo', type: 'local' },
    ], { 'third-party/demo': manifest('Demo') });
    const before = createExtensionResolver(descriptors).resolve('demo');
    const updated = setExtensionEnabled(descriptors, 'DEMO', false);

    assert.equal(before.enabled, true);
    assert.equal(descriptors[0].enabled, true);
    assert.equal(createExtensionResolver(updated).resolve('demo').enabled, false);
    updated[0].manifest.nested.isolated = false;
    assert.equal(descriptors[0].manifest.nested.isolated, true);
});

test('resolver manifests are isolated from source and caller mutation', () => {
    const sourceManifest = manifest('Demo');
    const descriptors = createExtensionDescriptors([
        { name: 'third-party/demo', type: 'local' },
    ], { 'third-party/demo': sourceManifest });
    const resolver = createExtensionResolver(descriptors);

    sourceManifest.nested.isolated = false;
    descriptors[0].manifest.nested.isolated = false;
    const first = resolver.resolve('demo');
    first.manifest.nested.isolated = false;

    assert.equal(resolver.resolve('demo').manifest.nested.isolated, true);
    assert.equal(resolver.list()[0].manifest.nested.isolated, true);
});

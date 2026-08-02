import assert from 'node:assert/strict';
import test from 'node:test';

import { getExtensionActivationPlan } from '../public/scripts/util/extension-eligibility.js';
import { preloadExtensionResources } from '../public/scripts/util/extension-resource-preload.js';

function createFakeDocument({ failAt = Number.POSITIVE_INFINITY } = {}) {
    const appended = [];
    let appendCount = 0;
    return {
        appended,
        createElement(tagName) {
            assert.equal(tagName, 'link');
            return {
                removed: false,
                remove() {
                    this.removed = true;
                },
            };
        },
        head: {
            appendChild(link) {
                appendCount++;
                if (appendCount === failAt) {
                    throw new Error('head unavailable');
                }
                appended.push(link);
            },
        },
    };
}

test('extension resource preloads use passive module and style hints', () => {
    const documentRef = createFakeDocument();
    const result = preloadExtensionResources({
        vectors: { js: 'index.js', css: 'style.css' },
        expressions: { js: 'main.js' },
    }, { documentRef });

    assert.equal(result.count, 3);
    assert.deepEqual(documentRef.appended.map(link => ({
        rel: link.rel,
        as: link.as,
        href: link.href,
    })), [
        { rel: 'modulepreload', as: undefined, href: '/scripts/extensions/expressions/main.js' },
        { rel: 'modulepreload', as: undefined, href: '/scripts/extensions/vectors/index.js' },
        { rel: 'preload', as: 'style', href: '/scripts/extensions/vectors/style.css' },
    ]);

    result.dispose();
    result.dispose();
    assert.equal(documentRef.appended.every(link => link.removed), true);
});

test('extension resource preloads exclude disabled entries and enforce the cap', () => {
    const documentRef = createFakeDocument();
    const result = preloadExtensionResources({
        disabled: { js: 'disabled.js', css: 'disabled.css' },
        invalid: null,
        empty: { js: '', css: 5 },
        active: { js: 'active.js', css: 'active.css' },
        later: { js: 'later.js' },
    }, {
        documentRef,
        excludedExtensions: new Set(['disabled']),
        maxPreloads: 1.9,
    });

    assert.equal(result.count, 1);
    assert.equal(documentRef.appended[0].href, '/scripts/extensions/active/active.js');
});

test('extension preloads share activation eligibility and apply limits after loading order', () => {
    const manifests = {
        tooNew: { js: 'too-new.js', loading_order: 0, minimum_client_version: '99.0.0' },
        missingModule: { js: 'missing-module.js', loading_order: 1, requires: ['caption'] },
        missingDependency: { js: 'missing-dependency.js', loading_order: 2, dependencies: ['absent'] },
        disabled: { js: 'disabled.js', loading_order: 3 },
        later: { js: 'later.js', loading_order: 20 },
        early: { js: 'early.js', loading_order: 10 },
    };
    const plan = getExtensionActivationPlan(manifests, {
        clientVersion: '1.15.0',
        modules: [],
        disabledExtensions: ['disabled'],
    });
    const eligibleExtensions = new Set(plan.filter(entry => entry.eligible).map(entry => entry.name));

    assert.deepEqual([...eligibleExtensions], ['early', 'later']);
    assert.equal(plan.find(entry => entry.name === 'tooNew').meetsClientMinimumVersion, false);
    assert.deepEqual(plan.find(entry => entry.name === 'missingModule').missingModules, ['caption']);
    assert.deepEqual(plan.find(entry => entry.name === 'missingDependency').missingDependencies, ['absent']);

    const documentRef = createFakeDocument();
    const result = preloadExtensionResources(manifests, {
        documentRef,
        eligibleExtensions,
        maxPreloads: 2,
    });
    assert.equal(result.count, 2);
    assert.deepEqual(documentRef.appended.map(link => link.href), [
        '/scripts/extensions/early/early.js',
        '/scripts/extensions/later/later.js',
    ]);
});

test('descriptor preloads preserve ordering and local shadowing', () => {
    const documentRef = createFakeDocument();
    const result = preloadExtensionResources([
        {
            canonicalName: 'third-party/Demo', shortName: 'Demo', type: 'global', enabled: true,
            manifest: { js: 'global.js', loading_order: 0 }, resourceBaseUrl: '/global/demo',
        },
        {
            canonicalName: 'third-party/demo', shortName: 'demo', type: 'local', enabled: true,
            manifest: { js: 'local.js', css: 'local.css', loading_order: 20 }, resourceBaseUrl: '/local/demo',
        },
        {
            canonicalName: 'early', shortName: 'early', type: 'builtin', enabled: true,
            manifest: { js: 'early.js', loading_order: 10 }, resourceBaseUrl: '/builtin/early',
        },
    ], { documentRef });

    assert.equal(result.count, 3);
    assert.deepEqual(documentRef.appended.map(link => link.href), [
        '/builtin/early/early.js',
        '/local/demo/local.js',
        '/local/demo/local.css',
    ]);
});

test('extension resource preloads clean partial hints when insertion fails', () => {
    const documentRef = createFakeDocument({ failAt: 2 });

    assert.throws(() => preloadExtensionResources({
        regex: { js: 'index.js', css: 'style.css' },
    }, { documentRef }), /head unavailable/);
    assert.equal(documentRef.appended.length, 1);
    assert.equal(documentRef.appended[0].removed, true);
});

test('extension resource preloads validate public inputs', () => {
    const documentRef = createFakeDocument();

    assert.throws(() => preloadExtensionResources(null, { documentRef }), /array or manifest object/i);
    assert.throws(() => preloadExtensionResources({}, { documentRef, excludedExtensions: 'regex' }), /array or Set/);
    assert.throws(() => preloadExtensionResources({}, { documentRef, eligibleExtensions: 'regex' }), /array or Set/);
    assert.throws(() => preloadExtensionResources({}, { documentRef, maxPreloads: -1 }), /non-negative finite number/);
    assert.throws(() => preloadExtensionResources({}, { documentRef: {} }), /writable head/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

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
        { rel: 'modulepreload', as: undefined, href: '/scripts/extensions/vectors/index.js' },
        { rel: 'preload', as: 'style', href: '/scripts/extensions/vectors/style.css' },
        { rel: 'modulepreload', as: undefined, href: '/scripts/extensions/expressions/main.js' },
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

    assert.throws(() => preloadExtensionResources(null, { documentRef }), /manifests must be an object/i);
    assert.throws(() => preloadExtensionResources({}, { documentRef, excludedExtensions: 'regex' }), /array or Set/);
    assert.throws(() => preloadExtensionResources({}, { documentRef, maxPreloads: -1 }), /non-negative finite number/);
    assert.throws(() => preloadExtensionResources({}, { documentRef: {} }), /writable head/);
});

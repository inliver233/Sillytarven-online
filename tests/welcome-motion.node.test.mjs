import assert from 'node:assert/strict';
import test from 'node:test';

import {
    canUseInliverMotion,
    cancelWelcomeMotion,
    runRecentChatTransition,
    runShowMoreTransition,
} from '../public/scripts/welcome-motion.js';

class FakeClassList {
    values = new Set();
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    toggle(value, force) {
        const next = force === undefined ? !this.values.has(value) : Boolean(force);
        next ? this.values.add(value) : this.values.delete(value);
        return next;
    }
    contains(value) { return this.values.has(value); }
}

class FakeElement {
    constructor(rect = { left: 0, top: 0, width: 40, height: 40 }) {
        this.rect = rect;
        this.classList = new FakeClassList();
        this.style = {
            values: new Map(),
            visibility: '',
            setProperty: (name, value) => this.style.values.set(name, value),
            getPropertyValue: name => this.style.values.get(name) ?? '',
        };
        this.isConnected = true;
        this.children = [];
        this.dataset = {};
        this.animations = [];
    }
    getBoundingClientRect() { return this.rect; }
    cloneNode() { return new FakeElement(this.rect); }
    append(...nodes) { this.children.push(...nodes); }
    remove() { this.isConnected = false; }
    removeAttribute() {}
    setAttribute() {}
    querySelector(selector) { return this.queryResults?.get(selector) ?? null; }
    animate() {
        const animation = { finished: Promise.resolve(), cancel() { this.cancelled = true; } };
        this.animations.push(animation);
        return animation;
    }
}

function createDocument() {
    const body = new FakeElement();
    body.dataset = { uiMotion: 'inliver' };
    return {
        body,
        documentElement: new FakeElement(),
        createElement: () => new FakeElement(),
    };
}

const noReduce = () => ({ matches: false });

test('motion policy is explicit and rejects other themes or reduced motion', () => {
    const documentRef = createDocument();
    assert.equal(canUseInliverMotion({ documentRef, matchMedia: noReduce }), true);
    documentRef.body.dataset.uiMotion = '';
    assert.equal(canUseInliverMotion({ documentRef, matchMedia: noReduce }), false);
    documentRef.body.dataset.uiMotion = 'inliver';
    assert.equal(canUseInliverMotion({ documentRef, matchMedia: () => ({ matches: true }) }), false);
});

test('recent transition falls back to the original opener when motion is disabled', async () => {
    const documentRef = createDocument();
    documentRef.body.dataset.uiMotion = '';
    let opened = 0;
    await runRecentChatTransition({
        card: new FakeElement(),
        openChat: () => { opened++; },
        getTarget: () => null,
        dependencies: { documentRef, matchMedia: noReduce },
    });
    assert.equal(opened, 1);
    assert.equal(documentRef.body.children.filter(child => child.isConnected).length, 0);
});

test('recent transition cleans its overlay when the target is unavailable', async () => {
    const documentRef = createDocument();
    const avatar = new FakeElement();
    const card = new FakeElement();
    card.queryResults = new Map([['.avatar', avatar]]);
    let opened = 0;
    await runRecentChatTransition({
        card,
        openChat: async () => { opened++; },
        getTarget: () => null,
        dependencies: {
            documentRef,
            matchMedia: noReduce,
            requestAnimationFrameFn: callback => { callback(); return 1; },
            setTimeoutFn: callback => { callback(); return 1; },
            clearTimeoutFn: () => {},
        },
    });
    assert.equal(opened, 1);
    assert.equal(documentRef.body.children.filter(child => child.isConnected).length, 0);
});

test('show-more transition animates at most eight items and commits all visibility', async () => {
    const documentRef = createDocument();
    const nodes = Array.from({ length: 10 }, () => new FakeElement());
    nodes.forEach(node => node.classList.add('hidden'));
    await runShowMoreTransition({
        items: nodes,
        expanded: true,
        dependencies: { documentRef, matchMedia: noReduce, setTimeoutFn: callback => { callback(); return 1; }, clearTimeoutFn: () => {} },
    });
    assert.equal(nodes.every(node => !node.classList.contains('hidden')), true);
    assert.equal(nodes.slice(0, 8).filter(node => node.animations.length > 0).length, 8);
    assert.equal(nodes.slice(8).every(node => node.animations.length === 0), true);

    await runShowMoreTransition({
        items: nodes,
        expanded: false,
        dependencies: { documentRef, matchMedia: noReduce, setTimeoutFn: callback => { callback(); return 1; }, clearTimeoutFn: () => {} },
    });
    assert.equal(nodes.every(node => node.classList.contains('hidden')), true);
    cancelWelcomeMotion();
});

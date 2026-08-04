import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHAT_RENDER_THRESHOLDS,
    ChatRenderOptimizer,
    makeChatHeightKey,
    shouldOptimizeChatRender,
} from '../public/scripts/util/chat-render-optimizer.js';

class FakeClassList {
    values = new Set();
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
}

class FakeStyle {
    values = new Map();
    setProperty(name, value) { this.values.set(name, value); }
    removeProperty(name) { this.values.delete(name); }
}

function createMessageNode(id, rect, { classes = [], editing = false, pendingImage = false } = {}) {
    const classList = new FakeClassList();
    classes.forEach(value => classList.add(value));
    return {
        classList,
        style: new FakeStyle(),
        dataset: {},
        clientWidth: 640,
        getAttribute: name => name === 'mesid' ? String(id) : null,
        getBoundingClientRect: () => ({ height: rect.bottom - rect.top, width: 640, ...rect }),
        querySelector: selector => editing && selector.includes('edit_textarea') ? {} : null,
        querySelectorAll: selector => selector === 'img' && pendingImage ? [{ complete: false }] : [],
    };
}

function createChat(nodes) {
    return {
        clientWidth: 640,
        clientHeight: 500,
        querySelectorAll: () => nodes,
        getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }),
    };
}

const immediateFrameProcessor = async (items, process, { shouldContinue = () => true } = {}) => {
    let inserted = 0;
    for (const [index, item] of items.entries()) {
        if (!shouldContinue()) break;
        process(item, index);
        inserted++;
    }
    return { completed: inserted === items.length, inserted, frames: items.length ? 1 : 0 };
};

test('chat render thresholds remain conservative for small chats and activate at every documented boundary', () => {
    assert.equal(shouldOptimizeChatRender([{ mes: 'short' }]), false);
    assert.equal(shouldOptimizeChatRender([{ mes: 'x'.repeat(12_000) }]), true);
    assert.equal(shouldOptimizeChatRender([{ mes: 'x'.repeat(60_000) }]), true);
    assert.equal(shouldOptimizeChatRender(Array.from({ length: 20 }, () => ({ mes: 'x'.repeat(1_200) }))), true);
    assert.equal(shouldOptimizeChatRender(null), false);
});

test('height keys bucket width and isolate layout revisions', () => {
    assert.equal(makeChatHeightKey('chat', 7, 641, 1), makeChatHeightKey('chat', 7, 639, 1));
    assert.notEqual(makeChatHeightKey('chat', 7, 641, 1), makeChatHeightKey('chat', 7, 721, 1));
    assert.notEqual(makeChatHeightKey('chat', 7, 641, 1), makeChatHeightKey('chat', 7, 641, 2));
});

test('optimizer culls only distant messages and always protects the last four', async () => {
    const nodes = [
        createMessageNode(0, { top: 1800, bottom: 2000 }),
        createMessageNode(1, { top: 100, bottom: 220 }),
        ...Array.from({ length: 4 }, (_, index) => createMessageNode(index + 2, { top: 1800, bottom: 1900 })),
    ];
    const optimizer = new ChatRenderOptimizer({
        ResizeObserverClass: undefined,
        frameProcessor: immediateFrameProcessor,
        getViewportHeight: () => 500,
    });
    optimizer.setChatContext('chat-a');
    const result = await optimizer.refresh(createChat(nodes), [{ mes: 'x'.repeat(60_000) }]);

    assert.deepEqual(result, { optimized: true, messages: 6, culled: 1, cancelled: false });
    assert.equal(nodes[0].classList.contains('st-chat-content-culled'), true);
    assert.equal(nodes[1].classList.contains('st-chat-content-culled'), false);
    nodes.slice(-4).forEach(node => assert.equal(node.classList.contains('st-chat-content-culled'), false));
});

test('editing, streaming, selected, and pending-media messages are never culled', async () => {
    const far = { top: 1800, bottom: 1950 };
    const nodes = [
        createMessageNode(0, far, { editing: true }),
        createMessageNode(1, far, { classes: ['streaming'] }),
        createMessageNode(2, far, { classes: ['selected'] }),
        createMessageNode(3, far, { pendingImage: true }),
        ...Array.from({ length: 4 }, (_, index) => createMessageNode(index + 4, far)),
    ];
    const optimizer = new ChatRenderOptimizer({ ResizeObserverClass: undefined, frameProcessor: immediateFrameProcessor });
    const result = await optimizer.refresh(createChat(nodes), [{ mes: 'x'.repeat(60_000) }]);

    assert.equal(result.culled, 0);
    nodes.forEach(node => assert.equal(node.classList.contains('st-chat-content-culled'), false));
});

test('resize height cache is bounded and layout invalidation clears measurements', async () => {
    let observer;
    class FakeResizeObserver {
        constructor(callback) { this.callback = callback; observer = this; }
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    const nearNode = createMessageNode(0, { top: 10, bottom: 110 });
    const optimizer = new ChatRenderOptimizer({ ResizeObserverClass: FakeResizeObserver, frameProcessor: immediateFrameProcessor });
    optimizer.setChatContext('cache-chat');
    await optimizer.refresh(createChat([nearNode]), [{ mes: 'x'.repeat(60_000) }]);

    for (let index = 0; index < CHAT_RENDER_THRESHOLDS.maxHeights + 5; index++) {
        const node = createMessageNode(index, { top: 10, bottom: 110 });
        observer.callback([{ target: node, contentRect: { height: 100 + index } }]);
    }
    assert.equal(optimizer.getDebugState().cachedHeights, CHAT_RENDER_THRESHOLDS.maxHeights);
    optimizer.invalidateLayout();
    assert.equal(optimizer.getDebugState().cachedHeights, 0);
});

test('stale refreshes cancel before writes and dispose removes every artifact', async () => {
    let releaseRead;
    let calls = 0;
    const delayedFrameProcessor = async (items, process, options = {}) => {
        calls++;
        if (calls === 1) {
            await new Promise(resolve => { releaseRead = resolve; });
        }
        let inserted = 0;
        for (const [index, item] of items.entries()) {
            if (!options.shouldContinue?.()) break;
            process(item, index);
            inserted++;
        }
        return { completed: inserted === items.length, inserted, frames: 1 };
    };
    const node = createMessageNode(0, { top: 1800, bottom: 1950 });
    const optimizer = new ChatRenderOptimizer({ ResizeObserverClass: undefined, frameProcessor: delayedFrameProcessor });
    optimizer.setChatContext('old');
    const pending = optimizer.refresh(createChat([node]), [{ mes: 'x'.repeat(60_000) }]);
    optimizer.setChatContext('new');
    releaseRead();
    assert.equal((await pending).cancelled, true);
    assert.equal(node.classList.contains('st-chat-content-culled'), false);

    node.classList.add('st-chat-content-culled');
    node.style.setProperty('--st-cull-height', '200px');
    await optimizer.refresh(createChat([node]), [{ mes: 'x'.repeat(60_000) }]);
    optimizer.dispose({ clearCache: true });
    assert.equal(node.classList.contains('st-chat-content-culled'), false);
    assert.equal(node.style.values.has('--st-cull-height'), false);
    assert.equal(optimizer.getDebugState().trackedNodes, 0);
});

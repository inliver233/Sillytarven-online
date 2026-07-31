import assert from 'node:assert/strict';
import test from 'node:test';

import { processItemsWithFrameBudget } from '../public/scripts/util/frame-budget.js';

test('frame budget keeps cheap work synchronous and ordered', async () => {
    let clock = 0;
    let waits = 0;
    const processed = [];
    const result = await processItemsWithFrameBudget(
        Array.from({ length: 20 }, (_, index) => index),
        (item) => {
            processed.push(item);
            clock += 0.25;
        },
        {
            now: () => clock,
            waitForNextFrame: async () => { waits++; },
        },
    );

    assert.deepEqual(processed, Array.from({ length: 20 }, (_, index) => index));
    assert.deepEqual(result, {
        completed: true,
        inserted: 20,
        frames: 1,
        maxFrameDurationMs: 5,
        workDurationMs: 5,
    });
    assert.equal(waits, 0);
});

test('frame budget yields expensive work and preserves viewport after every chunk', async () => {
    let clock = 0;
    let height = 100;
    let scrollTop = 25;
    let waits = 0;
    const frameSizes = [];
    const result = await processItemsWithFrameBudget(
        Array.from({ length: 20 }, (_, index) => index),
        () => {
            clock += 3;
            height += 10;
        },
        {
            frameBudgetMs: 8,
            now: () => clock,
            waitForNextFrame: async () => { waits++; },
            beforeFrame: () => height,
            afterFrame: (previousHeight, details) => {
                frameSizes.push(details.frameItems);
                scrollTop += height - previousHeight;
            },
        },
    );

    assert.deepEqual(frameSizes, [3, 3, 3, 3, 3, 3, 2]);
    assert.equal(scrollTop, 225);
    assert.equal(waits, 6);
    assert.deepEqual(result, {
        completed: true,
        inserted: 20,
        frames: 7,
        maxFrameDurationMs: 9,
        workDurationMs: 60,
    });
});

test('frame budget cancellation stops stale work between and within frames', async () => {
    let clock = 0;
    let inserted = 0;
    let waits = 0;
    const result = await processItemsWithFrameBudget(
        Array.from({ length: 10 }, (_, index) => index),
        () => {
            inserted++;
            clock += 1;
        },
        {
            frameBudgetMs: 2.5,
            now: () => clock,
            waitForNextFrame: async () => { waits++; },
            shouldContinue: () => inserted < 4,
        },
    );

    assert.equal(inserted, 4);
    assert.equal(waits, 1);
    assert.deepEqual(result, {
        completed: false,
        inserted: 4,
        frames: 2,
        maxFrameDurationMs: 3,
        workDurationMs: 4,
    });
});

test('frame budget handles empty input, invalid options, and scheduler errors', async () => {
    assert.deepEqual(
        await processItemsWithFrameBudget([], () => {}),
        { completed: true, inserted: 0, frames: 0, maxFrameDurationMs: 0, workDurationMs: 0 },
    );
    await assert.rejects(processItemsWithFrameBudget(null, () => {}), /items must be an array/);
    await assert.rejects(processItemsWithFrameBudget([], null), /processor must be a function/);

    let clock = 0;
    await assert.rejects(
        processItemsWithFrameBudget([1, 2], () => { clock += 10; }, {
            now: () => clock,
            waitForNextFrame: async () => { throw new Error('frame unavailable'); },
        }),
        /frame unavailable/,
    );
});

test('frame budget uses the browser clock and animation frame defaults', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    let frameRequests = 0;
    globalThis.requestAnimationFrame = (callback) => {
        frameRequests++;
        setImmediate(() => callback(globalThis.performance.now()));
        return frameRequests;
    };

    try {
        const result = await processItemsWithFrameBudget([1, 2], () => {
            const workUntil = globalThis.performance.now() + 9;
            while (globalThis.performance.now() < workUntil) {
                // Simulate one rich message that exceeds the fallback 8 ms budget.
            }
        }, { frameBudgetMs: 0 });

        assert.equal(result.completed, true);
        assert.equal(result.inserted, 2);
        assert.equal(result.frames, 2);
        assert.equal(frameRequests, 1);
        assert.ok(result.maxFrameDurationMs >= 8);
    } finally {
        if (originalRequestAnimationFrame === undefined) {
            delete globalThis.requestAnimationFrame;
        } else {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        }
    }
});

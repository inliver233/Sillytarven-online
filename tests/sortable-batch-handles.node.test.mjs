import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Window } from 'happy-dom';

const { installBatchedSortableHandles } = await import('../public/scripts/util/sortable-batch-handles.js');

const lib = file => fs.readFileSync(new URL(`../public/lib/${file}`, import.meta.url), 'utf8');
const JQUERY = lib('jquery-3.5.1.min.js');
const JQUERY_UI = lib('jquery-ui.min.js');

/** A fresh page with jQuery UI, optionally patched. */
function page({ patched }) {
    const window = new Window({ url: 'http://localhost/' });
    window.eval(JQUERY);
    window.eval(JQUERY_UI);
    if (patched) assert.equal(installBatchedSortableHandles(window.$), true);
    return window;
}

function listHtml(count) {
    return '<ul id="list">' + Array.from({ length: count }, (_, i) =>
        `<li class="item${i % 7 ? '' : ' locked'}" data-id="${i}" style="${i % 3 ? '' : 'display:none'}"><span class="grip">≡</span><span class="grip extra">≡</span>${i}</li>`,
    ).join('') + '<li class="other">not sortable</li></ul>';
}

/** Everything the handle marking affects: classes, the widget's lookup and remove tracking. */
function snapshot(window) {
    const $ = window.$;
    const all = [...window.document.querySelectorAll('#list *')];
    const id = element => all.indexOf(element);
    const instance = $('#list').sortable('instance');
    // Plain data: arrays from the page's realm would differ from ours by prototype alone.
    return structuredClone({
        classes: all.map(element => element.className),
        lookup: Object.fromEntries(Object.entries(instance.classesElementLookup).map(([key, set]) => [key, set.get().map(id)])),
        removeHandlers: all.map(element => $._data(element, 'events')?.remove?.length ?? 0),
    });
}

const SCENARIOS = [
    ['whole items as handles', { items: '.item' }],
    ['a handle selector inside each item', { items: '.item', handle: '.grip' }],
    ['a subset of items', { items: '.item:not(.locked)', handle: '.grip.extra' }],
];

test('batched handle marking leaves exactly the same state as jQuery UI', () => {
    for (const [name, options] of SCENARIOS) {
        const results = [false, true].map(patched => {
            const window = page({ patched });
            window.document.body.innerHTML = listHtml(60);
            window.$('#list').sortable(options);
            const created = snapshot(window);
            // Re-marking after the list changes, as an option change or refresh does.
            window.$('#list li.item').slice(0, 5).remove();
            window.$('#list').append('<li class="item" data-id="new"><span class="grip">≡</span></li>');
            window.$('#list').sortable('refresh');
            window.$('#list').sortable('option', 'handle', options.handle ? '.grip' : null);
            const refreshed = snapshot(window);
            window.$('#list').sortable('destroy');
            const destroyed = [...window.document.querySelectorAll('#list *')].map(element => element.className);
            return { created, refreshed, destroyed };
        });
        assert.deepEqual(results[1], results[0], name);
    }
});

test('installing twice keeps a single patch', () => {
    const window = page({ patched: true });
    const patchedMethod = window.$.ui.sortable.prototype._setHandleClassName;
    assert.equal(installBatchedSortableHandles(window.$), true);
    assert.equal(window.$.ui.sortable.prototype._setHandleClassName, patchedMethod);
    assert.equal(installBatchedSortableHandles(undefined), false);
});

test('marking hundreds of items no longer grows quadratically', () => {
    const time = patched => {
        const window = page({ patched });
        window.document.body.innerHTML = listHtml(400);
        const start = performance.now();
        window.$('#list').sortable({ items: '.item' });
        return performance.now() - start;
    };
    const before = time(false);
    const after = time(true);
    assert.ok(after * 3 < before, `expected a clear speed-up, got ${before.toFixed(0)} ms vs ${after.toFixed(0)} ms`);
});

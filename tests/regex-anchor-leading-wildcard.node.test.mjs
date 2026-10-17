import assert from 'node:assert/strict';
import test from 'node:test';

const { anchorLeadingWildcard } = await import('../public/scripts/extensions/regex/anchor-leading-wildcard.js');

// Patterns seen in presets on our sites, plus shapes chosen to sit on either side of the rule.
const REWRITTEN = [
    /[\s\S]*<scene>|<\/scene>|<summary>摘要<\/summary>|<details>|<\/details>[\s\S]*/gs,
    /[\s\S]*(<content>[\s\S]*<\/content>)[\s\S]*/g,
    /[\s\S]*(<ZhaiyaoGeshi>[\s\S]*<\/ZhaiyaoGeshi>)[\s\S]*/g,
    /[\s\S]*(?<tag><t>)/g,
    /[^]*ab+/g,
    /[\w\W]*\/end/gi,
    /.*<scene>/gs,
    /[\s\S]*<scene>/gm,
    /[\s\S]*<scene>/,
    /[\s\S]*<scene>|(<scene>)?/gu,
];
const UNCHANGED = [
    /[\s\S]*/g,
    /[\s\S]*?<scene>/g,
    /[\s\S]*?(?<!<details>\s*)<summary>([\s\S]*?)<\/summary>/g,
    /[\s\S]*<?scene/g,
    /[\s\S]*<*scene/g,
    /[\s\S]*<{0,1}scene/g,
    /[\s\S]*(<a>|)x/g,
    /[\s\S]*(?:<a>|<b>)x/g,
    /[\s\S]*(<a>)?x/g,
    /[\s\S]*(?=<a>)/g,
    /[\s\S]*(?<=a)b/g,
    /[\s\S]*\s/g,
    /[\s\S]*\b/g,
    /[\s\S]*$/g,
    /.*<scene>/g,
    /[\s\S]*<scene>/y,
    /x|[\s\S]*<scene>/g,
    /a[\s\S]*<scene>/g,
];

test('only the provably safe shape is anchored', () => {
    for (const regex of REWRITTEN) {
        const anchored = anchorLeadingWildcard(regex);
        assert.notEqual(anchored, regex, String(regex));
        assert.equal(anchored.flags, regex.flags);
        assert.ok(anchored.source.endsWith(regex.source));
    }
    for (const regex of UNCHANGED) {
        assert.equal(anchorLeadingWildcard(regex), regex, String(regex));
    }
    assert.equal(anchorLeadingWildcard(undefined), undefined);
});

test('the m flag uses a start-of-input anchor instead of ^', () => {
    const anchored = anchorLeadingWildcard(/[\s\S]*<scene>/gm);
    assert.equal('a\n<scene>b\n<scene>'.replace(anchored, 'X'), 'X');
    assert.equal(anchored.source.startsWith('(?<![\\s\\S])'), true);
});

/** Deterministic pseudo-random generator so failures are reproducible. */
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

const PIECES = ['a', 'b', 'x', '\n', ' ', '摘要', '<', '>', '/', 'scene', '<scene>', '</scene>', '<details>', '</details>',
    '<summary>摘要</summary>', '<content>', '</content>', '<ZhaiyaoGeshi>', '</ZhaiyaoGeshi>', '<a>', '<b>', '<t>', 'end', 'ab', 'bb'];

function sample(next, length) {
    let text = '';
    while (text.length < length) text += PIECES[Math.floor(next() * PIECES.length)];
    return text;
}

/** Every replacement call with its match, groups and offset, as the engine would see them. */
function trace(text, regex) {
    const calls = [];
    const output = text.replace(regex, (...args) => {
        calls.push(JSON.stringify(args.filter(arg => typeof arg !== 'string' || arg !== text)));
        return `[${calls.length}]`;
    });
    return { output, calls };
}

test('anchored regexes produce exactly the same replacements on random text', () => {
    const next = random(20261018);
    const texts = ['', '<scene>', 'a', ...Array.from({ length: 1500 }, (_, i) => sample(next, i % 120))];
    for (const regex of REWRITTEN) {
        const anchored = anchorLeadingWildcard(regex);
        for (const text of texts) {
            regex.lastIndex = 0;
            anchored.lastIndex = 0;
            assert.deepEqual(trace(text, anchored), trace(text, regex), `${regex} on ${JSON.stringify(text)}`);
        }
    }
});

test('a long message without the tag no longer takes quadratic time', () => {
    const regex = /[\s\S]*<scene>|<\/scene>|<summary>摘要<\/summary>|<details>|<\/details>[\s\S]*/gs;
    const anchored = anchorLeadingWildcard(regex);
    const text = '风枢的舞步已经不复先前的轻缓。'.repeat(1500);
    const time = (re) => {
        const start = performance.now();
        for (let i = 0; i < 5; i++) text.replace(re, '');
        return (performance.now() - start) / 5;
    };
    const before = time(regex);
    const after = time(anchored);
    assert.equal(text.replace(anchored, ''), text.replace(regex, ''));
    assert.ok(after < 5, `anchored took ${after.toFixed(2)} ms`);
    assert.ok(before > after * 20, `expected a large speed-up, got ${before.toFixed(2)} ms vs ${after.toFixed(2)} ms`);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BoundedCache } from '../src/bounded-cache.js';
import {
    CharacterListCache,
    clearCharacterListCache,
    getCharacterListCacheStatus,
    invalidateCharacterListCache,
    registerCharacterListCache,
} from '../src/character-list-cache.js';
import { mapWithConcurrency } from '../src/concurrency.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function withCharacterDirectory(callback) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-character-list-'));
    try {
        return await callback(directory);
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
}

test('mapWithConcurrency preserves order and never exceeds its worker bound', async () => {
    let active = 0;
    let maximum = 0;
    const values = Array.from({ length: 40 }, (_, index) => index);
    const result = await mapWithConcurrency(values, 4, async value => {
        active++;
        maximum = Math.max(maximum, active);
        await delay(2);
        active--;
        return value * 2;
    });

    assert.deepEqual(result, values.map(value => value * 2));
    assert.ok(maximum > 1 && maximum <= 4);
    assert.deepEqual(await mapWithConcurrency([], 4, async value => value), []);
    await assert.rejects(() => mapWithConcurrency([1, 2], 1, async value => {
        if (value === 2) throw new Error('mapper failed');
        return value;
    }), /mapper failed/);
});

test('bounded cache applies TTL, LRU, byte limits, invalidation, and single-flight', async () => {
    let now = 1000;
    const cache = new BoundedCache({ ttlMs: 50, maxEntries: 2, maxBytes: 1000, now: () => now });
    let loads = 0;
    const load = async value => {
        loads++;
        await delay(2);
        return value;
    };

    assert.equal((await cache.getOrLoad('a', { signature: '1', load: () => load('A') })).state, 'miss');
    assert.equal((await cache.getOrLoad('a', { signature: '1', load: () => load('wrong') })).state, 'hit');
    const concurrent = await Promise.all([
        cache.getOrLoad('b', { signature: '1', load: () => load('B') }),
        cache.getOrLoad('b', { signature: '1', load: () => load('wrong') }),
    ]);
    assert.deepEqual(concurrent.map(result => result.state).sort(), ['miss', 'shared']);
    assert.equal(loads, 2);

    // Touch a, then insert c: b is the least recently used entry.
    cache.get('a', '1');
    await cache.getOrLoad('c', { signature: '1', load: () => load('C') });
    assert.equal(cache.get('b', '1').hit, false);
    assert.equal(cache.getStatus().entries, 2);
    cache.invalidateWhere(key => key === 'c');
    assert.equal(cache.get('c', '1').hit, false);

    now += 50;
    assert.equal(cache.get('a', '1').hit, false);
    await cache.getOrLoad('oversized', {
        signature: '1',
        load: () => load('large'),
        sizeOf: () => 2000,
    });
    assert.equal(cache.get('oversized', '1').hit, false);

    let release;
    const pending = cache.getOrLoad('race', {
        signature: '1',
        load: () => new Promise(resolve => { release = resolve; }),
    });
    await delay(0);
    cache.invalidate('race');
    release('old');
    await pending;
    assert.equal(cache.get('race', '1').hit, false);
    assert.equal((await cache.getOrLoad('race', { signature: '1', load: () => load('new') })).value, 'new');

    await assert.rejects(() => cache.getOrLoad('failure', {
        signature: '1',
        load: async () => { throw new Error('load failed'); },
    }), /load failed/);
    assert.equal((await cache.getOrLoad('failure', { signature: '1', load: () => load('recovered') })).value, 'recovered');

    cache.clear();
    assert.deepEqual(cache.getStatus(), { entries: 0, inflight: 0, totalBytes: 0 });

    const disabled = new BoundedCache({ enabled: false });
    assert.equal((await disabled.getOrLoad('key', { signature: '1', load: () => load('value') })).state, 'miss');
    assert.equal((await disabled.getOrLoad('key', { signature: '1', load: () => load('value') })).state, 'miss');
});

test('character list cache handles empty, corrupt, large, and many-card libraries with bounded workers', async () => {
    await withCharacterDirectory(async directory => {
        const cache = new CharacterListCache({
            concurrency: 3,
            signatureTtlMs: 0,
            ttlMs: 60_000,
            maxBytes: 10 * 1024 * 1024,
        });
        let calls = 0;
        const empty = await cache.get({
            userKey: 'alice',
            directory,
            shallow: false,
            loadCharacter: async () => { calls++; return {}; },
        });
        assert.deepEqual(empty.characters, []);
        assert.equal(empty.fileCount, 0);
        assert.equal(empty.concurrency, 0);
        assert.equal(calls, 0);
        assert.equal((await cache.get({
            userKey: 'alice',
            directory,
            shallow: false,
            loadCharacter: async () => { calls++; return {}; },
        })).state, 'hit');

        const validCardCount = 120;
        const names = [...Array.from({ length: validCardCount }, (_, index) => `card-${String(index).padStart(3, '0')}.png`), 'bad.png', 'nameless.png'];
        await Promise.all(names.map(name => fs.promises.writeFile(path.join(directory, name), name)));
        cache.invalidate('alice');
        let active = 0;
        let maximum = 0;
        const loader = async fileName => {
            calls++;
            active++;
            maximum = Math.max(maximum, active);
            await delay(2);
            active--;
            if (fileName === 'bad.png') throw new Error('corrupt PNG');
            if (fileName === 'nameless.png') return {};
            return {
                name: fileName,
                avatar: fileName,
                data: { creator_notes: fileName === 'card-000.png' ? 'x'.repeat(1024 * 1024) : '' },
            };
        };
        const built = await cache.get({ userKey: 'alice', directory, shallow: false, loadCharacter: loader });
        assert.equal(built.state, 'miss');
        assert.equal(built.fileCount, names.length);
        assert.equal(built.characters.length, validCardCount);
        assert.equal(built.failures, 2);
        assert.ok(maximum <= 3);
        assert.deepEqual(built.characters.map(character => character.avatar), [...built.characters.map(character => character.avatar)].sort());
        const callsAfterBuild = calls;

        const hit = await cache.get({ userKey: 'alice', directory, shallow: false, loadCharacter: loader });
        assert.equal(hit.state, 'hit');
        assert.equal(calls, callsAfterBuild);
        assert.equal(hit.characters[0].data.creator_notes.length, 1024 * 1024);

        const otherUser = await cache.get({ userKey: 'bob', directory, shallow: false, loadCharacter: loader });
        assert.equal(otherUser.state, 'miss');
        assert.equal(calls, callsAfterBuild + names.length);
    });
});

test('character list signature and explicit invalidation refresh edited libraries', async () => {
    await withCharacterDirectory(async directory => {
        const cardPath = path.join(directory, 'card.png');
        await fs.promises.writeFile(cardPath, 'v1');
        const cache = new CharacterListCache({ concurrency: 2, signatureTtlMs: 0, ttlMs: 60_000 });
        registerCharacterListCache(cache);
        let calls = 0;
        const loader = async fileName => ({ name: `${fileName}-${++calls}`, avatar: fileName });

        const first = await cache.get({ userKey: 'alice', directory, shallow: true, loadCharacter: loader });
        const hit = await cache.get({ userKey: 'alice', directory, shallow: true, loadCharacter: loader });
        assert.equal(first.state, 'miss');
        assert.equal(hit.state, 'hit');
        assert.equal(calls, 1);

        await fs.promises.writeFile(cardPath, 'version-two-is-larger');
        const externallyEdited = await cache.get({ userKey: 'alice', directory, shallow: true, loadCharacter: loader });
        assert.equal(externallyEdited.state, 'miss');
        assert.equal(calls, 2);

        invalidateCharacterListCache('alice');
        const explicitlyInvalidated = await cache.get({ userKey: 'alice', directory, shallow: true, loadCharacter: loader });
        assert.equal(explicitlyInvalidated.state, 'miss');
        assert.equal(calls, 3);
        assert.ok(getCharacterListCacheStatus().entries >= 1);
        clearCharacterListCache();
        assert.deepEqual(getCharacterListCacheStatus(), { entries: 0, inflight: 0, totalBytes: 0, signatures: 0 });
    });
});

test('concurrent identical character list requests share one complete build and never return placeholders', async () => {
    await withCharacterDirectory(async directory => {
        await Promise.all(['a.png', 'b.png', 'c.png'].map(name => fs.promises.writeFile(path.join(directory, name), name)));
        const cache = new CharacterListCache({ concurrency: 2, signatureTtlMs: 1000, ttlMs: 60_000 });
        let calls = 0;
        const loader = async fileName => {
            calls++;
            await delay(10);
            return { name: fileName, avatar: fileName };
        };
        const [first, second] = await Promise.all([
            cache.get({ userKey: 'alice', directory, shallow: false, loadCharacter: loader }),
            cache.get({ userKey: 'alice', directory, shallow: false, loadCharacter: loader }),
        ]);

        assert.deepEqual([first.state, second.state].sort(), ['miss', 'shared']);
        assert.equal(calls, 3);
        assert.equal(first.characters.length, 3);
        assert.deepEqual(second.characters, first.characters);
    });
});

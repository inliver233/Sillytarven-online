import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CharacterListCache } from '../src/character-list-cache.js';
import { buildCharacterListDelta, getCharacterVersion, readKnownVersions, VOLATILE_CHARACTER } from '../src/character-list-delta.js';
import { rebuildCharacterList } from '../public/scripts/util/character-list-store.js';

const card = (avatar, extra = {}) => ({
    name: avatar.replace('.png', ''),
    avatar,
    description: `long text of ${avatar}\nwith a line feed and ${String.fromCharCode(0x2028)} separators`,
    data: { character_book: { entries: [{ content: 'lore "quoted" \\ backslash' }] } },
    json_data: JSON.stringify({ spec: 'chara_card_v2', note: 'a\nb' }),
    chat_size: 10,
    date_last_chat: 100,
    ...extra,
});
const stats = (overrides = {}) => ({ size: 100, mtimeMs: 1000.5, ctimeMs: 1000.5, ino: 7, ...overrides });

/** What the browser would hold after storing every sent card of a response. */
function store(previous, result) {
    const next = new Map(previous);
    for (const { avatar, version, json } of result.fresh) {
        next.set(avatar, { version, json });
    }
    return next;
}
const knownOf = stored => new Map([...stored].map(([avatar, entry]) => [avatar, entry.version]));
const full = characters => JSON.parse(JSON.stringify(characters));

test('versions change with every file change, user and file name', () => {
    const base = getCharacterVersion('alice', 'a.png', stats());
    assert.equal(base, getCharacterVersion('alice', 'a.png', stats()));
    assert.ok(base.length > 0 && base.length <= 64);
    for (const changed of [{ size: 101 }, { mtimeMs: 1000.6 }, { ctimeMs: 2000 }, { ino: 8 }]) {
        assert.notEqual(getCharacterVersion('alice', 'a.png', stats(changed)), base, JSON.stringify(changed));
    }
    assert.notEqual(getCharacterVersion('bob', 'a.png', stats()), base);
    assert.notEqual(getCharacterVersion('alice', 'b.png', stats()), base);
    assert.equal(getCharacterVersion('alice', 'a.png', undefined), '');
});

test('only requests that send a version map get a delta, and bad entries are ignored', () => {
    assert.equal(readKnownVersions({}), null);
    assert.equal(readKnownVersions(undefined), null);
    assert.equal(readKnownVersions({ cached: [] }), null);
    assert.equal(readKnownVersions({ cached: 'x' }), null);
    assert.deepEqual([...readKnownVersions({ cached: {} })], []);
    const known = readKnownVersions({ cached: { 'a.png': 'v1', 'b.png': 5, 'c.png': '', 'd.png': 'x'.repeat(65) } });
    assert.deepEqual([...known], [['a.png', 'v1']]);
});

test('the browser rebuilds exactly the full list across first load, reuse, edits, chats, additions and deletions', () => {
    const fileStats = new Map([['a.png', stats()], ['b.png', stats({ ino: 8 })], ['c.png', stats({ ino: 9 })]]);
    let characters = [card('a.png'), card('b.png'), card('c.png')];

    // First load: nothing stored, everything sent.
    let delta = buildCharacterListDelta(characters, fileStats, 'alice', new Map());
    assert.equal(delta.sent, 3);
    let result = rebuildCharacterList(delta.body, new Map());
    assert.deepEqual(result.characters, full(characters));
    let stored = store(new Map(), result);

    // Nothing changed: nothing sent, same list.
    delta = buildCharacterListDelta(characters, fileStats, 'alice', knownOf(stored));
    assert.deepEqual([delta.sent, delta.reused], [0, 3]);
    assert.ok(delta.body.length < 400, `${delta.body.length} bytes`);
    result = rebuildCharacterList(delta.body, stored);
    assert.deepEqual(result.characters, full(characters));
    assert.deepEqual(result.fresh, []);

    // A new chat moves the chat statistics without touching the card file.
    characters = [card('a.png', { chat_size: 999, date_last_chat: 555 }), card('b.png'), card('c.png')];
    delta = buildCharacterListDelta(characters, fileStats, 'alice', knownOf(stored));
    assert.equal(delta.sent, 0);
    result = rebuildCharacterList(delta.body, stored);
    assert.deepEqual(result.characters, full(characters));

    // An edited card is sent again; a deleted one disappears; a new one is sent.
    fileStats.set('b.png', stats({ ino: 8, mtimeMs: 5000, size: 120 }));
    fileStats.delete('c.png');
    fileStats.set('d.png', stats({ ino: 10 }));
    characters = [card('a.png'), card('b.png', { description: 'edited' }), card('d.png')];
    delta = buildCharacterListDelta(characters, fileStats, 'alice', knownOf(stored));
    assert.deepEqual([delta.sent, delta.reused], [2, 1]);
    result = rebuildCharacterList(delta.body, stored);
    assert.deepEqual(result.characters, full(characters));
    assert.deepEqual(result.avatars, ['a.png', 'b.png', 'd.png']);
    assert.deepEqual(result.fresh.map(entry => entry.avatar), ['b.png', 'd.png']);
});

test('the browser refuses to rebuild from a missing or outdated copy', () => {
    const fileStats = new Map([['a.png', stats()]]);
    const characters = [card('a.png')];
    const first = rebuildCharacterList(buildCharacterListDelta(characters, fileStats, 'alice', new Map()).body, new Map());
    const stored = store(new Map(), first);
    const delta = buildCharacterListDelta(characters, fileStats, 'alice', knownOf(stored));

    assert.equal(rebuildCharacterList(delta.body, null), null);
    assert.equal(rebuildCharacterList(delta.body, new Map()), null);
    assert.equal(rebuildCharacterList(delta.body, new Map([['a.png', { version: 'other', json: '{}' }]])), null);
    assert.equal(rebuildCharacterList(JSON.stringify({ format: 2, list: [] }), stored), null);
    // A truncated body (fewer card lines than announced) is rejected, as are extra lines.
    const sent = buildCharacterListDelta(characters, fileStats, 'alice', new Map()).body;
    assert.equal(rebuildCharacterList(sent.split('\n')[0], new Map()), null);
    assert.equal(rebuildCharacterList(`${sent}\n{}`, new Map()), null);
});

test('cards without file stats are always sent and never stored', () => {
    const delta = buildCharacterListDelta([card('a.png')], new Map(), 'alice', new Map([['a.png', '']]));
    assert.equal(delta.sent, 1);
    const result = rebuildCharacterList(delta.body, new Map());
    assert.deepEqual(result.fresh, []);
    assert.deepEqual(result.unversioned, ['a.png']);
    assert.deepEqual(result.characters, full([card('a.png')]));
});

test('cards that change on every read (fresh chat name) are always sent, even when the browser holds the file version', () => {
    const fileStats = new Map([['a.png', stats()], ['b.png', stats({ ino: 8 })]]);
    const volatile = card('a.png', { chat: 'a - 2026-10-06T07:00:00.000Z' });
    volatile[VOLATILE_CHARACTER] = true;
    const known = new Map([['a.png', getCharacterVersion('alice', 'a.png', stats())], ['b.png', getCharacterVersion('alice', 'b.png', stats({ ino: 8 }))]]);
    const delta = buildCharacterListDelta([volatile, card('b.png')], fileStats, 'alice', known);
    assert.deepEqual([delta.sent, delta.reused], [1, 1]);
    const stored = new Map([['b.png', { version: known.get('b.png'), json: JSON.stringify(card('b.png')) }]]);
    const result = rebuildCharacterList(delta.body, stored);
    assert.deepEqual(result.characters, full([volatile, card('b.png')]));
    assert.deepEqual(result.unversioned, ['a.png']);
    assert.equal(JSON.stringify(volatile).includes('volatile'), false);
});

test('the list cache reports file stats that follow edits and replacements', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-character-delta-'));
    try {
        const cardPath = path.join(directory, 'card.png');
        await fs.promises.writeFile(cardPath, 'v1');
        const cache = new CharacterListCache({ signatureTtlMs: 0, ttlMs: 60_000 });
        const loader = async fileName => ({ name: fileName, avatar: fileName });
        const version = async () => {
            const result = await cache.get({ userKey: 'alice', directory, shallow: false, loadCharacter: loader });
            return getCharacterVersion('alice', 'card.png', result.fileStats.get('card.png'));
        };

        const first = await version();
        assert.equal(await version(), first);
        await new Promise(resolve => setTimeout(resolve, 20));
        await fs.promises.writeFile(cardPath, 'v2');
        const edited = await version();
        assert.notEqual(edited, first);

        // Replaced by another file of the same size and time (a restore): the inode differs.
        const replacement = path.join(directory, 'replacement.tmp');
        await fs.promises.writeFile(replacement, 'v3');
        const { atime, mtime } = await fs.promises.stat(cardPath);
        await fs.promises.utimes(replacement, atime, mtime);
        await fs.promises.rename(replacement, cardPath);
        assert.notEqual(await version(), edited);
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
});

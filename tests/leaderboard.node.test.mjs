import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
    LIMITS,
    LeaderboardStore,
    cleanNickname,
    dayOf,
    discordIdOf,
    hourOf,
    parseSendDate,
    signPeerRequest,
    verifyPeerRequest,
    windowDays,
} from '../src/leaderboard.js';

const SECRET = 'test-secret-shared-by-both-sites';
const MINUTE = 60e3;
// 2026-11-07 12:00 Beijing time (a Saturday)
const NOON = Date.UTC(2026, 10, 7, 4, 0, 0);

function makeStore(site = 'legacy', start = NOON) {
    const clock = { now: start };
    const store = new LeaderboardStore({ site, secret: SECRET, now: () => clock.now, recomputeMs: 0 });
    store.countingSince = start - 60 * MINUTE;
    return { store, clock };
}

const iso = ts => new Date(ts).toISOString();
const ai = (ts, mes = 'x'.repeat(100), name = 'Alice') => ({ name, is_user: false, send_date: iso(ts), mes });
const user = (ts, mes = 'hi') => ({ name: 'Me', is_user: true, send_date: iso(ts), mes });

function board(store, metric = 'chat', window = 'today', site = 'all', handle = 'a') {
    return store.board({ metric, window, site, handle });
}

test('days, hours and windows are in Beijing time; weeks start on Monday', () => {
    // 2026-11-07 23:30 UTC is 2026-11-08 07:30 in Beijing.
    const late = Date.UTC(2026, 10, 7, 23, 30);
    assert.equal(dayOf(late), dayOf(Date.UTC(2026, 10, 8, 3, 0)));
    assert.equal(hourOf(late), 7);
    assert.equal(hourOf(Date.UTC(2026, 10, 7, 18, 30)), 2, '02:30 Beijing counts for the night owls');
    const [weekStart] = windowDays('week', NOON);
    // Monday 2026-11-02
    assert.equal(weekStart, dayOf(Date.UTC(2026, 10, 2, 4)));
    const [monthStart, today] = windowDays('month', NOON);
    assert.equal(monthStart, dayOf(Date.UTC(2026, 10, 1, 4)));
    assert.equal(today, dayOf(NOON));
    assert.deepEqual(windowDays('all', NOON), [-Infinity, Infinity]);
});

test('send dates in every format chats have used', () => {
    assert.equal(parseSendDate('2026-11-07T04:00:00.000Z'), NOON);
    assert.equal(parseSendDate(NOON), NOON);
    assert.equal(parseSendDate(String(NOON)), NOON);
    assert.equal(parseSendDate('2026-11-07 @12h 00m 00s 000ms'), NOON, 'old humanized dates are Beijing time');
    assert.equal(parseSendDate('November 7, 2026 12:00pm'), NOON);
    assert.equal(parseSendDate('November 7, 2026 12:00 AM'), NOON - 12 * 60 * MINUTE);
    assert.equal(parseSendDate(''), null);
    assert.equal(parseSendDate('not a date'), null);
    assert.equal(parseSendDate({}), null);
});

test('Discord ids from old-site and new-site records', () => {
    assert.equal(discordIdOf({ oauthProvider: 'discord', oauthUserId: 'discord_123456789012' }), '123456789012');
    assert.equal(discordIdOf({ oauthIdentities: { discord: '123456789012' }, oauthUserId: '123456789012' }), '123456789012');
    assert.equal(discordIdOf({ oauthIdentities: { discord: 'discord_123456789012' } }), '123456789012');
    assert.equal(discordIdOf({ oauthProvider: 'github', oauthUserId: '42' }), null);
    assert.equal(discordIdOf({}), null);
});

test('nicknames lose markup and invisible characters and are kept short', () => {
    assert.equal(cleanNickname('  <b>小  明</b>  '), 'b小 明/b');
    assert.equal(cleanNickname('a‮b​c'), 'abc');
    assert.equal(Array.from(cleanNickname('一二三四五六七八九十一二三四五六七八')).length, LIMITS.NICKNAME_MAX);
});

test('an AI reply counts only against a generation request, once, and grows while streaming', () => {
    const { store, clock } = makeStore();
    store.ensureAccount({ handle: 'a', created: NOON - 100 * 864e5 });
    const chat = [ai(NOON - 30 * MINUTE, 'greeting'), user(NOON - MINUTE), ai(NOON, 'Hello')];

    // Without a generation request the reply (made up in the save) does not count.
    assert.equal(store.recordMessages('a', [ai(NOON - 5000)], {}), 0);

    store.recordGeneration('a', NOON - 2000);
    assert.equal(store.recordMessages('a', chat, { fromStart: true }), 2, 'the reply and the user message before it');
    // Saved again, partly streamed: no second reply, only the new characters.
    clock.now += 5000;
    chat[2].mes = 'Hello there, how are you?';
    assert.equal(store.recordMessages('a', chat, { fromStart: true }), 0);
    const today = store.accounts.get('a').days.get(dayOf(NOON));
    assert.equal(today.ai, 1);
    assert.equal(today.user, 1);
    assert.equal(today.chars, 'Hello there, how are you?'.length);
    assert.equal(today.cset.length, 1);

    // "Continue": a new send date, the old text plus more. One more generation, only new text counts.
    store.recordGeneration('a', clock.now);
    const continued = { ...chat[2], send_date: iso(clock.now), mes: `${chat[2].mes} Fine, thanks!` };
    assert.equal(store.recordMessages('a', [...chat.slice(0, 2), continued], { fromStart: true }), 1);
    assert.equal(today.ai, 2);
    assert.equal(today.chars, `${chat[2].mes} Fine, thanks!`.length);

    // A regenerated reply (new swipe, new text) counts in full.
    clock.now += 30e3;
    store.recordGeneration('a', clock.now);
    store.recordMessages('a', [...chat.slice(0, 2), ai(clock.now, 'Totally different')], { fromStart: true });
    assert.equal(today.ai, 3);
    assert.equal(today.chars, `${chat[2].mes} Fine, thanks!`.length + 'Totally different'.length);
});

test('a failed generation request pays for nothing', () => {
    const { store } = makeStore();
    store.ensureAccount({ handle: 'a' });
    const first = store.recordGeneration('a', NOON - 2000);
    const second = store.recordGeneration('a', NOON - 2000);
    assert.notEqual(first, second, 'two credits even in the same millisecond');
    store.revokeGeneration('a', first);
    store.revokeGeneration('a', second);
    assert.equal(store.recordMessages('a', [ai(NOON - 5 * MINUTE, 'g'), ai(NOON - 1000)], {}), 0);
});

test('greetings, system notes, old and copied messages do not count', () => {
    const { store, clock } = makeStore();
    store.ensureAccount({ handle: 'a' });
    for (let i = 0; i < 5; i++) store.recordGeneration('a', NOON - i * 1000);
    const counted = store.recordMessages('a', [
        ai(NOON - 1000, 'greeting'),
        { ...ai(NOON - 900), is_system: true },
        { ...ai(NOON - 800), extra: { type: 'narrator' } },
        ai(NOON - 30 * MINUTE, 'too old'),
    ], { fromStart: true });
    assert.equal(counted, 0);
    // A chat copied (branch) carries the same messages: counted once.
    clock.now += 1000;
    store.recordGeneration('a', clock.now - 500);
    const reply = ai(clock.now - 400, 'reply');
    assert.equal(store.recordMessages('a', [ai(NOON - 5 * MINUTE, 'g'), reply], { fromStart: true }), 1);
    assert.equal(store.recordMessages('a', [ai(NOON - 5 * MINUTE, 'g'), reply], { fromStart: true }), 0);
    // Messages before counting started are left to the history scan.
    const { store: fresh } = makeStore();
    fresh.countingSince = NOON;
    fresh.ensureAccount({ handle: 'a' });
    fresh.recordGeneration('a', NOON - 1000);
    assert.equal(fresh.recordMessages('a', [ai(NOON - 3 * MINUTE, 'g'), ai(NOON - 2000)], {}), 0);
});

test('a user message counts when a generation request follows it', () => {
    const { store, clock } = makeStore();
    store.ensureAccount({ handle: 'a' });
    // Saved before the generation request arrives: waits for it.
    assert.equal(store.recordMessages('a', [ai(NOON - 10 * MINUTE, 'g'), user(NOON - 1000)], { fromStart: true }), 0);
    store.recordGeneration('a', NOON + 1000);
    assert.equal(store.accounts.get('a').days.get(dayOf(NOON)).user, 1);
    // Sent without asking for a reply: does not count.
    clock.now += 10 * MINUTE;
    store.recordMessages('a', [user(clock.now - 1000)], {});
    clock.now += 5 * MINUTE;
    store.recordGeneration('a', clock.now);
    assert.equal(store.accounts.get('a').days.get(dayOf(NOON)).user, 1);
});

test('rates are limited: made-up messages cannot flood the counts', () => {
    const { store } = makeStore();
    store.ensureAccount({ handle: 'a' });
    for (let i = 0; i < 100; i++) store.recordGeneration('a', NOON - i * 100);
    const replies = Array.from({ length: 60 }, (_, i) => ai(NOON - i * 1000, `reply ${i}`));
    store.recordMessages('a', [ai(NOON - 10 * MINUTE, 'g'), ...replies.reverse()], { fromStart: true });
    assert.equal(store.accounts.get('a').days.get(dayOf(NOON)).ai, LIMITS.MAX_AI_PER_MINUTE);
});

test('the user clock offset is corrected before the time checks', () => {
    const { store } = makeStore();
    store.ensureAccount({ handle: 'a' });
    // The phone is 20 minutes fast.
    store.recordClock('a', NOON + 20 * MINUTE, NOON);
    store.recordGeneration('a', NOON - 1000);
    assert.equal(store.recordMessages('a', [ai(NOON - 5 * MINUTE, 'g'), ai(NOON + 20 * MINUTE - 500, 'reply')], {}), 1);
});

test('online time: gaps up to 10 minutes count, longer ones count a minute, 16 hours a day at most', () => {
    const { store, clock } = makeStore();
    store.ensureAccount({ handle: 'a' });
    store.recordActivity('a', clock.now);
    for (let i = 0; i < 10; i++) store.recordActivity('a', clock.now += MINUTE);
    store.recordActivity('a', clock.now += 30 * MINUTE);
    const stats = store.accounts.get('a').days.get(dayOf(NOON));
    assert.equal(stats.online, 12 * MINUTE, 'first report 1 min, ten 1-minute gaps, then 1 min after a long break');
    for (let i = 0; i < 200; i++) store.recordActivity('a', clock.now += 5 * MINUTE);
    assert.ok(store.accounts.get('a').days.get(dayOf(NOON)).online <= LIMITS.ONLINE_DAY_CAP_MS);
});

test('everybody is anonymous by default; nicknames are unique and not official-looking; leaving keeps a private rank', () => {
    const { store } = makeStore();
    for (const handle of ['a', 'b', 'c']) store.ensureAccount({ handle });
    const add = (handle, count) => {
        const stats = store.dayStats(store.accounts.get(handle), dayOf(NOON));
        stats.ai += count;
        store.touch(store.accounts.get(handle), stats);
    };
    add('a', 5);
    add('b', 9);
    add('c', 7);
    let view = board(store, 'chat', 'today', 'all', 'a');
    assert.deepEqual(view.rows.map(row => row.value), [9, 7, 5]);
    assert.ok(view.rows.every(row => row.anonymous && /·[0-9a-f]{3}$/.test(row.name)));
    assert.equal(view.me.rank, 3);
    assert.equal(view.me.gap, 2);
    assert.equal(view.me.explicit, false, 'not asked yet');

    assert.equal(store.setPrefs('b', { mode: 'public', nickname: '官方客服' }).error, 'nickname_reserved');
    assert.ok(store.setPrefs('b', { mode: 'public', nickname: '小明' }).prefs);
    assert.equal(store.setPrefs('c', { mode: 'public', nickname: ' 小明 ' }).error, 'nickname_taken');
    assert.ok(store.setPrefs('c', { mode: 'none' }).prefs);
    view = board(store, 'chat', 'today', 'all', 'c');
    assert.deepEqual(view.rows.map(row => [row.name, row.value]), [['小明', 9], [store.anonymousName(store.personKey(store.accounts.get('a'))), 5]]);
    assert.equal(view.me.rank, 2, 'the one who left still sees where they would be');
    assert.equal(view.me.mode, 'none');
    // The labels never contain the account name.
    assert.ok(!JSON.stringify(board(store)).includes('"a"'));
});

test('ties share a rank; streak, active days, variety and rookies', () => {
    const { store } = makeStore();
    store.ensureAccount({ handle: 'a', created: NOON - 100 * 864e5 });
    store.ensureAccount({ handle: 'b', created: NOON - 3 * 864e5 });
    const today = dayOf(NOON);
    const set = (handle, day, values) => {
        const stats = store.dayStats(store.accounts.get(handle), day);
        Object.assign(stats, values);
        store.touch(store.accounts.get(handle), stats);
    };
    // a: yesterday and the two days before (today not yet): streak 3
    for (const day of [today - 1, today - 2, today - 3, today - 5]) set('a', day, { ai: 2, cset: [`c${day % 2}`] });
    set('b', today, { ai: 2, cset: ['x', 'y', 'z'] });
    set('b', today - 1, { ai: 3 });
    assert.equal(board(store, 'streak', 'all').rows.find(row => row.value === 3)?.value, 3);
    assert.deepEqual(board(store, 'active', 'all').rows.map(row => row.value), [4, 2]);
    assert.deepEqual(board(store, 'variety', 'all').rows.map(row => row.value), [3, 2]);
    assert.deepEqual(board(store, 'rookie', 'all').rows.map(row => row.value), [5], 'only the new account');
    // The week started on Monday (today - 5): all of a's days are in it.
    const week = board(store, 'chat', 'week');
    assert.deepEqual(week.rows.map(row => [row.rank, row.value]), [[1, 8], [2, 5]]);
    assert.deepEqual(board(store, 'chat', 'today').rows.map(row => row.value), [2]);
    set('b', today - 1, { ai: 6 });
    assert.deepEqual(board(store, 'chat', 'week').rows.map(row => [row.rank, row.value]), [[1, 8], [1, 8]]);
});

test('two sites: the same Discord account is one person with both badges; changes travel in small steps', () => {
    const legacy = makeStore('legacy').store;
    const modern = makeStore('modern').store;
    legacy.ensureAccount({ handle: 'old-me', discord: '111111111111' });
    legacy.ensureAccount({ handle: 'old-other', discord: '222222222222' });
    modern.ensureAccount({ handle: 'new-me', discord: '111111111111' });
    const add = (store, handle, values) => {
        const stats = store.dayStats(store.accounts.get(handle), dayOf(NOON));
        for (const [key, value] of Object.entries(values)) stats[key] += value;
        store.touch(store.accounts.get(handle), stats);
    };
    add(legacy, 'old-me', { ai: 4, online: 20 * 3600e3 });
    add(legacy, 'old-other', { ai: 6 });
    add(modern, 'new-me', { ai: 5, online: 3 * 3600e3 });
    assert.ok(modern.setPrefs('new-me', { mode: 'public', nickname: '跨站的我' }).prefs);

    // modern pulls legacy, legacy pulls modern
    let fromLegacy = legacy.exportForPeer(-1, 'none');
    assert.equal(fromLegacy.full, true);
    assert.ok(!JSON.stringify(fromLegacy).includes('old-me'), 'no account names leave the site');
    assert.ok(!JSON.stringify(fromLegacy).includes('111111111111'), 'nor Discord ids');
    assert.ok(modern.applyPeer('https://legacy', fromLegacy));
    assert.ok(legacy.applyPeer('https://modern', modern.exportForPeer(-1, 'none')));

    for (const [store, handle] of [[legacy, 'old-me'], [modern, 'new-me']]) {
        const view = store.board({ metric: 'chat', window: 'today', site: 'all', handle });
        assert.deepEqual(view.rows.map(row => [row.name, row.value, row.sites.join('+')]), [
            ['跨站的我', 9, 'legacy+modern'],
            [store.anonymousName(legacy.personKey(legacy.accounts.get('old-other'))), 6, 'legacy'],
        ]);
        assert.equal(view.me.rank, 1);
        // Online time of one person is capped per day across both sites.
        assert.equal(store.board({ metric: 'online', window: 'today', site: 'all', handle }).me.value, LIMITS.ONLINE_DAY_CAP_MS);
    }
    // The site filter ranks only what was done on that site.
    assert.deepEqual(modern.board({ metric: 'chat', window: 'today', site: 'modern', handle: 'new-me' }).rows.map(row => row.value), [5]);
    // The anonymous name is the same on both sites.
    const otherKey = legacy.personKey(legacy.accounts.get('old-other'));
    assert.equal(legacy.anonymousName(otherKey), modern.anonymousName(otherKey));

    // A delta carries only what changed; a removed account is dropped by the peer.
    const peer = modern.peers.get('https://legacy');
    add(legacy, 'old-other', { ai: 1 });
    let delta = legacy.exportForPeer(peer.version, peer.epoch);
    assert.equal(delta.full, false);
    assert.equal(delta.accounts.length, 1);
    assert.equal(delta.accounts[0].days.length, 1);
    modern.applyPeer('https://legacy', delta);
    legacy.syncUsers([{ handle: 'old-me', discord: '111111111111' }]);
    delta = legacy.exportForPeer(peer.version, peer.epoch);
    assert.equal(delta.removed.length, 1);
    modern.applyPeer('https://legacy', delta);
    assert.deepEqual(modern.board({ metric: 'chat', window: 'today', site: 'all', handle: 'new-me' }).rows.map(row => row.value), [9]);
    // After a restart (new epoch) the peer gets everything again.
    fromLegacy = legacy.exportForPeer(peer.version, 'old-epoch');
    assert.equal(fromLegacy.full, true);

    // The latest choice on either site counts.
    legacy.setPrefs('old-me', { mode: 'anon' });
    modern.applyPeer('https://legacy', legacy.exportForPeer(modern.peers.get('https://legacy').version, legacy.epoch));
    assert.equal(modern.prefsOf('new-me').mode, 'anon');
    assert.equal(modern.prefsOf('new-me').explicit, true);
});

test('administrators are not ranked and not sent to the other site', () => {
    const { store } = makeStore();
    store.ensureAccount({ handle: 'boss', admin: true });
    store.recordGeneration('boss', NOON - 1000);
    assert.equal(store.recordMessages('boss', [ai(NOON - 5 * MINUTE, 'g'), ai(NOON - 500)], {}), 0);
    assert.equal(store.exportForPeer(-1, '').accounts.length, 0);
    assert.equal(store.board({ metric: 'chat', window: 'today', site: 'all', handle: 'boss' }).admin, true);
});

test('saved numbers survive a restart, and recent messages are not counted again', () => {
    const { store, clock } = makeStore();
    store.ensureAccount({ handle: 'a', created: 5, discord: '333333333333' });
    store.recordGeneration('a', NOON - 1000);
    const chat = [ai(NOON - 10 * MINUTE, 'g'), user(NOON - 2000), ai(NOON - 500, 'reply')];
    store.recordMessages('a', chat, { fromStart: true });
    store.recordGeneration('a', NOON);
    store.setPrefs('a', { mode: 'public', nickname: '存档' });
    store.backfilled.add('a');
    const saved = JSON.parse(JSON.stringify(store.exportState()));

    const { store: next } = makeStore('legacy', clock.now + 1000);
    assert.ok(next.importState(saved));
    assert.notEqual(next.epoch, store.epoch);
    assert.equal(next.countingSince, store.countingSince);
    assert.ok(next.backfilled.has('a'));
    assert.equal(next.prefsOf('a').nickname, '存档');
    // The same chat saved again after the restart: nothing new.
    assert.equal(next.recordMessages('a', chat, { fromStart: true }), 0);
    // The unused generation request carried over and pays for the next reply.
    assert.equal(next.recordMessages('a', [...chat, ai(NOON + 500, 'next')], { fromStart: true }), 1);
    assert.equal(next.accounts.get('a').days.get(dayOf(NOON)).ai, 2);
    assert.equal(next.importState({ ...saved, site: 'modern' }), false);
});

test('peer requests are signed with the shared secret and expire', () => {
    const query = 'since=5&epoch=abc';
    const header = signPeerRequest(SECRET, NOON, query);
    assert.equal(verifyPeerRequest(SECRET, header, query, NOON + 1000), true);
    assert.equal(verifyPeerRequest(SECRET, header, 'since=0&epoch=abc', NOON), false);
    assert.equal(verifyPeerRequest('another-secret-entirely', header, query, NOON), false);
    assert.equal(verifyPeerRequest(SECRET, header, query, NOON + 10 * MINUTE), false);
    assert.equal(verifyPeerRequest(SECRET, 'garbage', query, NOON), false);
    assert.equal(verifyPeerRequest('', header, query, NOON), false);
});

test('the history scan counts swipes, skips greetings and copies, and stops where live counting starts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leaderboard-scan-'));
    try {
        const chats = path.join(root, 'chats');
        const groupChats = path.join(root, 'group chats');
        fs.mkdirSync(path.join(chats, 'Alice'), { recursive: true });
        fs.mkdirSync(groupChats, { recursive: true });
        const day = Date.UTC(2026, 9, 1, 4);
        const header = JSON.stringify({ user_name: 'Me', character_name: 'Alice', chat_metadata: {} });
        const lines = [
            ai(day, 'greeting', 'Alice'),
            user(day + 1000, 'hello'),
            { ...ai(day + 2000, 'second', 'Alice'), swipes: ['first try', 'second'], swipe_id: 1, swipe_info: [{ send_date: iso(day + 1500) }, { send_date: iso(day + 2000) }] },
            { ...ai(day + 3000, 'note'), is_system: true },
            user(Date.UTC(2026, 10, 7, 4), 'after counting started'),
        ];
        fs.writeFileSync(path.join(chats, 'Alice', 'chat 1.jsonl'), [header, ...lines.map(line => JSON.stringify(line))].join('\n'));
        // A branch: the same first messages again.
        fs.writeFileSync(path.join(chats, 'Alice', 'branch.jsonl'), [header, ...lines.slice(0, 3).map(line => JSON.stringify(line))].join('\n'));
        // A chunked group chat: the header file plus shards; 02:00 Beijing is at night.
        const night = Date.UTC(2026, 9, 1, 18);
        fs.writeFileSync(path.join(groupChats, 'group.jsonl'), JSON.stringify({ chat_metadata: {} }));
        fs.mkdirSync(path.join(groupChats, 'group.jsonl.chunks'));
        fs.writeFileSync(path.join(groupChats, 'group.jsonl.chunks', '000000.jsonl'), [ai(night - 5000, 'hi all', 'Bob'), user(night - 1000)].map(line => JSON.stringify(line)).join('\n'));
        fs.writeFileSync(path.join(groupChats, 'group.jsonl.chunks', '000001.jsonl'), JSON.stringify(ai(night, 'group reply', 'Carol')));

        const messages = [];
        await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('../src/leaderboard-backfill.js', import.meta.url), {
                workerData: { secret: SECRET, countingSince: Date.UTC(2026, 10, 7), users: [{ handle: 'a', created: Date.UTC(2026, 0, 1), chats, groupChats }] },
            });
            worker.on('message', message => messages.push(message));
            worker.on('error', reject);
            worker.on('exit', resolve);
        });
        assert.equal(messages.length, 1);
        const { days } = messages[0];
        const first = days[dayOf(day)];
        const second = days[dayOf(night)];
        // [ai, chars, user, night, group, online, characters]
        assert.deepEqual(first.slice(0, 6), [2, 'first try'.length + 'second'.length, 1, 0, 0, 0]);
        assert.deepEqual(second.slice(0, 6), [1, 'group reply'.length, 1, 1, 1, 0]);
        const { store } = makeStore();
        assert.equal(first[6], store.characterKey('Alice'), 'the same character keys as live counting');
        assert.equal(Object.keys(days).length, 2, 'nothing after counting started');

        store.ensureAccount({ handle: 'a' });
        assert.ok(store.applyBackfill('a', days));
        assert.equal(store.applyBackfill('a', days), false, 'added once');
        assert.equal(store.board({ metric: 'chat', window: 'all', site: 'all', handle: 'a' }).me.value, 3);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

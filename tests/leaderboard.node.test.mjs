import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
    DAILY_CAPS,
    LIMITS,
    LeaderboardStore,
    SCORE_PARTS,
    cleanEmoji,
    compositeScore,
    cleanName,
    dayOf,
    discordIdOf,
    hourOf,
    numberedName,
    parseSendDate,
    signPeerRequest,
    verifyPeerRequest,
    windowDays,
    withEmoji,
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

test('display names lose markup, invisible characters and "#", and are kept short', () => {
    assert.equal(cleanName('  <b>小  明</b>  '), 'b小 明/b');
    assert.equal(cleanName('a\u202eb\u200bc'), 'abc');
    assert.equal(cleanName('小明#1203'), '小明1203', 'the number is ours to add');
    assert.equal(Array.from(cleanName('一二三四五六七八九十一二三四五六七八')).length, LIMITS.NAME_MAX);
});

test('everybody has a number for good: 匿名用户#number, or the display name with it', () => {
    assert.equal(numberedName({ mode: 'anon' }, '小明', 7), '匿名用户#7');
    assert.equal(numberedName({ mode: 'public' }, '小明', 7), '小明#7');
    assert.equal(numberedName({ mode: 'public' }, '', 7), '匿名用户#7', 'no display name: anonymous');
    // Odd on legacy, even on modern: never the same number twice.
    const { store: legacy } = makeStore('legacy');
    const { store: modern } = makeStore('modern');
    assert.deepEqual(['a', 'b', 'c'].map(handle => legacy.ensureAccount({ handle }).number), [1, 3, 5]);
    assert.deepEqual(['d', 'e'].map(handle => modern.ensureAccount({ handle }).number), [2, 4]);
    // Saved numbers from before numbers existed: given by age, the oldest account first.
    const { store: upgraded } = makeStore('legacy');
    upgraded.importState({ version: 1, site: 'legacy', countingSince: NOON, accounts: [
        { h: 'young', c: NOON - 864e5, days: [] },
        { h: 'old', c: NOON - 300 * 864e5, days: [] },
        { h: 'mid', c: NOON - 30 * 864e5, days: [] },
    ] });
    assert.deepEqual(['old', 'mid', 'young'].map(handle => upgraded.accounts.get(handle).number), [1, 3, 5]);
    // A process loads twice in a reload (on standby, then taking over): the same numbers both times.
    const { store: twice } = makeStore('modern');
    const before = { version: 1, site: 'modern', countingSince: NOON, accounts: [{ h: 'x', c: 2, days: [] }, { h: 'y', c: 1, days: [] }] };
    twice.importState(before);
    twice.importState(before);
    assert.deepEqual(['y', 'x'].map(handle => twice.accounts.get(handle).number), [2, 4]);
    assert.equal(upgraded.ensureAccount({ handle: 'new' }).number, 7);
    // Kept across restarts, and never given out again (not even after an account is gone).
    upgraded.syncUsers([{ handle: 'old' }, { handle: 'mid' }, { handle: 'young' }]);
    const { store: again } = makeStore('legacy');
    again.importState(JSON.parse(JSON.stringify(upgraded.exportState())));
    assert.deepEqual(['old', 'mid', 'young'].map(handle => again.accounts.get(handle).number), [1, 3, 5]);
    assert.equal(again.ensureAccount({ handle: 'newer' }).number, 9);
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

test('everybody is anonymous by default; real name shows the display name with the number; nobody can leave', () => {
    const { store } = makeStore();
    for (const [handle, name] of [['alice-10001', 'Alice'], ['bobby-20002', '小明'], ['carol-30003', '小明']]) store.ensureAccount({ handle, name });
    const add = (handle, count) => {
        const stats = store.dayStats(store.accounts.get(handle), dayOf(NOON));
        stats.ai += count;
        store.touch(store.accounts.get(handle), stats);
    };
    add('alice-10001', 5);
    add('bobby-20002', 9);
    add('carol-30003', 7);
    let view = board(store, 'chat', 'today', 'all', 'alice-10001');
    assert.deepEqual(view.rows.map(row => [row.name, row.value]), [['匿名用户#3', 9], ['匿名用户#5', 7], ['匿名用户#1', 5]]);
    assert.ok(view.rows.every(row => row.anonymous && /^[0-9a-f]{10}$/.test(row.key)));
    assert.equal(view.me.rank, 3);
    assert.equal(view.me.gap, 2);
    assert.equal(view.me.explicit, false, 'not asked yet');
    assert.equal(store.prefsOf('alice-10001').anonymousName, '匿名用户#1');
    assert.equal(store.prefsOf('alice-10001').publicName, 'Alice#1');

    // Real name: the same display name twice is told apart by the numbers.
    assert.ok(store.setPrefs('bobby-20002', { mode: 'public' }).prefs);
    assert.ok(store.setPrefs('carol-30003', { mode: 'public' }).prefs);
    view = board(store, 'chat', 'today', 'all', 'carol-30003');
    assert.deepEqual(view.rows.map(row => [row.name, row.anonymous]), [['小明#3', false], ['小明#5', false], ['匿名用户#1', true]]);
    // Leaving the board is not a choice.
    assert.equal(store.setPrefs('carol-30003', { mode: 'none' }).error, 'bad_mode');
    assert.equal(board(store, 'chat', 'today', 'all', 'carol-30003').me.rank, 2);
    // The account names themselves never show.
    assert.ok(!JSON.stringify(board(store)).includes('alice-10001'));
    // A new display name shows at once.
    store.ensureAccount({ handle: 'bobby-20002', name: '大明' });
    assert.equal(board(store, 'chat', 'today', 'all', 'x').rows[0].name, '大明#3');
});

test('the hour board: this clock hour only, starting over on the hour, merged over both sites', () => {
    const legacy = makeStore('legacy');
    const modern = makeStore('modern');
    legacy.store.ensureAccount({ handle: 'a', discord: '101010101010' });
    modern.store.ensureAccount({ handle: 'b', discord: '101010101010' });
    modern.store.ensureAccount({ handle: 'c' });
    const at = minutes => NOON + minutes * MINUTE;
    const reply = (store, handle, minute, earlier = []) => {
        store.recordGeneration(handle, at(minute) - 1000);
        const message = ai(at(minute) - 500, `reply at ${minute}`);
        store.recordMessages(handle, [...earlier, message], { at: at(minute) });
        return message;
    };
    // 11:50 (the hour before), then 12:10 on the old site; 12:20 on the new site (the same person).
    const first = reply(legacy.store, 'a', -10);
    reply(legacy.store, 'a', 10, [first]);
    reply(modern.store, 'b', 20);
    for (const minute of [25, 26, 27]) reply(modern.store, 'c', minute);
    // Online time in the hour: two reports a couple of minutes apart.
    modern.store.recordActivity('c', at(30));
    modern.store.recordActivity('c', at(32));
    const sync = () => {
        modern.store.applyPeer('https://legacy', legacy.store.exportForPeer(-1, 'none'));
        legacy.store.applyPeer('https://modern', modern.store.exportForPeer(-1, 'none'));
    };
    legacy.clock.now = modern.clock.now = at(40);
    sync();
    for (const store of [legacy.store, modern.store]) {
        const hour = store.board({ metric: 'chat', window: 'hour', site: 'all', handle: 'a' });
        assert.deepEqual(hour.rows.map(row => [row.value, row.sites.join('+')]), [[3, 'modern'], [2, 'legacy+modern']], '12:00–12:59 only');
        assert.deepEqual(store.board({ metric: 'chat', window: 'today', site: 'all', handle: 'a' }).rows.map(row => row.value), [3, 3]);
        assert.deepEqual(store.board({ metric: 'online', window: 'hour', site: 'all', handle: 'a' }).rows.map(row => row.value), [3 * MINUTE]);
        assert.equal(store.board({ metric: 'score', window: 'hour', site: 'all', handle: 'a' }).rows.length, 2);
    }
    assert.equal(modern.store.board({ metric: 'online', window: 'hour', site: 'all', handle: 'c' }).me.value, 3 * MINUTE);
    // 13:05: a new hour, nobody on its board yet; the day goes on.
    legacy.clock.now = modern.clock.now = at(65);
    for (const store of [legacy.store, modern.store]) {
        assert.deepEqual(store.board({ metric: 'chat', window: 'hour', site: 'all', handle: 'a' }).rows, []);
        assert.equal(store.board({ metric: 'chat', window: 'today', site: 'all', handle: 'a' }).rows.length, 2);
    }
    // Hours survive a restart; after two days they are gone.
    const { store: next } = makeStore('modern', at(40));
    next.importState(JSON.parse(JSON.stringify(modern.store.exportState())));
    assert.equal(next.board({ metric: 'chat', window: 'hour', site: 'all', handle: 'c' }).me.value, 3);
    const account = modern.store.accounts.get('c');
    modern.store.recordActivity('c', at(40 + 50 * 60));
    assert.deepEqual([...account.hours.keys()], [Math.floor((at(40 + 50 * 60) + 8 * 3600e3) / 3600e3)]);
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

test('the overall score: log-normalized parts, weighted, out of 100', () => {
    assert.equal(SCORE_PARTS.reduce((sum, part) => sum + part.weight, 0), 100);
    const best = { chat: 1000, words: 200000, online: 600 * MINUTE, active: 7, talk: 900, variety: 20, streak: 30 };
    assert.equal(compositeScore(best, best).score, 100, 'the best at everything');
    assert.equal(compositeScore({}, best).score, 0);
    // Diminishing returns: 10 → 100 replies is worth about as much as 100 → 1000.
    const at = metric => SCORE_PARTS.findIndex(part => part.metric === metric);
    const chatPoints = chat => compositeScore({ chat }, best).parts[at('chat')];
    assert.ok(Math.abs((chatPoints(100) - chatPoints(10)) - (chatPoints(1000) - chatPoints(100))) < 0.3);
    assert.ok(Math.abs(chatPoints(10) - SCORE_PARTS[at('chat')].weight * Math.log(11) / Math.log(1001)) < 1e-9);
    // Weighted by dimension: how much someone chatted counts once (40), habits weigh 30.
    const byDimension = {};
    for (const part of SCORE_PARTS) byDimension[part.dimension] = (byDimension[part.dimension] ?? 0) + part.weight;
    assert.deepEqual(byDimension, { output: 40, time: 20, habit: 30, breadth: 10 });
    // The parts add up to the score.
    const someone = { chat: 120, words: 30000, online: 90 * MINUTE, active: 3, talk: 100, variety: 4, streak: 2 };
    const { score, parts } = compositeScore(someone, best);
    assert.ok(Math.abs(parts.reduce((sum, part) => sum + part, 0) - score) < 1e-9);
    assert.ok(score > 0 && score < 100);
    // A part nobody has yet (online time before it was counted) is left out, weight and all.
    const noOnline = compositeScore({ ...best, online: 0 }, { ...best, online: 0 });
    assert.equal(noOnline.score, 100);
    assert.equal(noOnline.parts[at('online')], null);
    // Above the best (someone off the board looking at their own score): capped.
    assert.equal(compositeScore({ ...best, chat: 5000 }, best).score, 100);
});

test('the overall board ranks the all-rounder above the one-trick grinder', () => {
    const { store } = makeStore();
    const today = dayOf(NOON);
    const set = (handle, values) => {
        const account = store.ensureAccount({ handle });
        const stats = store.dayStats(account, today);
        Object.assign(stats, values);
        store.touch(account, stats);
    };
    // Grinder: many replies, nothing else much. All-rounder: fewer replies, but long ones, time, many characters.
    set('grinder', { ai: 400, chars: 4000, user: 400, online: 30 * MINUTE, cset: ['a'] });
    set('rounded', { ai: 150, chars: 150000, user: 140, online: 300 * MINUTE, cset: ['a', 'b', 'c', 'd', 'e'] });
    set('casual', { ai: 10, chars: 5000, user: 10, online: 20 * MINUTE, cset: ['a'] });
    set('hidden', { ai: 900, chars: 300000, user: 900, online: 600 * MINUTE, cset: ['a', 'b', 'c', 'd', 'e', 'f'] });
    assert.ok(store.setBan(store.personKey(store.accounts.get('hidden')), true));
    const view = store.board({ metric: 'score', window: 'today', site: 'all', handle: 'rounded' });
    const handles = view.rows.map(row => row.name);
    assert.equal(view.rows.length, 3, 'people taken off the board do not count, not even for the best values');
    assert.equal(handles[0], view.me.name, 'the all-rounder leads');
    assert.ok(view.rows[0].value > view.rows[1].value && view.rows[1].value > view.rows[2].value);
    assert.equal(view.rows[0].parts.length, SCORE_PARTS.length);
    assert.ok(Math.abs(view.rows[0].parts.reduce((sum, part) => sum + (part ?? 0), 0) - view.rows[0].value) < 1e-9);
    // The one taken off sees their own score against the same best values: capped at 100.
    const hidden = store.board({ metric: 'score', window: 'today', site: 'all', handle: 'hidden' });
    assert.equal(hidden.me.banned, true);
    assert.equal(hidden.me.value, 100);
    assert.equal(hidden.me.rank, 1);
    // Only one site: the best values are that site's.
    assert.deepEqual(store.board({ metric: 'score', window: 'today', site: 'modern', handle: 'rounded' }).rows, []);
});

test('daily caps: whatever slips through gains at most a full day', () => {
    const { store, clock } = makeStore();
    const account = store.ensureAccount({ handle: 'a' });
    const today = store.dayStats(account, dayOf(NOON));
    today.ai = DAILY_CAPS.ai - 1;
    today.chars = DAILY_CAPS.chars - 10;
    today.user = DAILY_CAPS.user;
    store.recordGeneration('a', NOON - 3000);
    store.recordGeneration('a', NOON - 2000);
    store.recordMessages('a', [ai(NOON - 10 * MINUTE, 'g'), user(NOON - 2500), ai(NOON - 2000, 'x'.repeat(500)), ai(NOON - 1000, 'y'.repeat(500))], { fromStart: true });
    assert.equal(today.ai, DAILY_CAPS.ai, 'one more reply, then the cap');
    assert.equal(today.chars, DAILY_CAPS.chars);
    assert.equal(today.user, DAILY_CAPS.user);
    // The next day starts over.
    clock.now = NOON + 864e5;
    store.recordGeneration('a', clock.now - 1000);
    store.recordMessages('a', [ai(clock.now - 10 * MINUTE, 'g'), ai(clock.now - 500, 'z')], { fromStart: true });
    assert.equal(store.accounts.get('a').days.get(dayOf(clock.now)).ai, 1);
    // History added on top of the first live day stays within the caps too.
    const { store: other } = makeStore();
    const b = other.ensureAccount({ handle: 'b' });
    Object.assign(other.dayStats(b, dayOf(NOON)), { ai: 900, chars: 1000, user: 700 });
    other.applyBackfill('b', { [dayOf(NOON)]: [500, 2000000, 500, 0, 0, 0, ''] });
    const merged = b.days.get(dayOf(NOON));
    assert.deepEqual([merged.ai, merged.chars, merged.user], [DAILY_CAPS.ai, DAILY_CAPS.chars, DAILY_CAPS.user]);
});

test('administrators take someone off the board on both sites; the latest decision counts', () => {
    const legacy = makeStore('legacy').store;
    const modern = makeStore('modern').store;
    legacy.ensureAccount({ handle: 'boss', admin: true });
    legacy.ensureAccount({ handle: 'cheat', discord: '555555555555' });
    legacy.ensureAccount({ handle: 'honest' });
    modern.ensureAccount({ handle: 'cheat2', discord: '555555555555' });
    modern.ensureAccount({ handle: 'viewer' });
    for (const [store, handle, count] of [[legacy, 'cheat', 900], [legacy, 'honest', 50], [modern, 'cheat2', 901]]) {
        const account = store.accounts.get(handle);
        const stats = store.dayStats(account, dayOf(NOON));
        stats.ai = count;
        store.touch(account, stats);
    }
    const sync = () => {
        modern.applyPeer('https://legacy', legacy.exportForPeer(modern.peers.get('https://legacy')?.version ?? -1, modern.peers.get('https://legacy')?.epoch ?? 'none'));
        legacy.applyPeer('https://modern', modern.exportForPeer(legacy.peers.get('https://modern')?.version ?? -1, legacy.peers.get('https://modern')?.epoch ?? 'none'));
    };
    sync();
    const adminView = legacy.board({ metric: 'chat', window: 'today', site: 'all', handle: 'boss' });
    assert.ok(adminView.rows.every(row => typeof row.id === 'string'), 'administrators see whom to act on');
    assert.ok(!('id' in legacy.board({ metric: 'chat', window: 'today', site: 'all', handle: 'honest' }).rows[0]), 'others do not');
    const cheatId = adminView.rows.find(row => row.value === 1801).id;
    assert.equal(legacy.setBan('nobody', true), false);
    assert.ok(legacy.setBan(cheatId, true));
    sync();
    for (const [store, handle] of [[legacy, 'honest'], [modern, 'viewer']]) {
        assert.deepEqual(store.board({ metric: 'chat', window: 'today', site: 'all', handle }).rows.map(row => row.value), [50]);
        assert.deepEqual(store.board({ metric: 'score', window: 'today', site: 'all', handle }).rows.length, 1);
    }
    const self = modern.board({ metric: 'chat', window: 'today', site: 'all', handle: 'cheat2' });
    assert.equal(self.me.banned, true, 'they see that they were taken off');
    assert.deepEqual(legacy.board({ metric: 'chat', window: 'today', site: 'all', handle: 'boss' }).removed.map(person => person.id), [cheatId]);
    // Changing their own settings does not bring them back; an administrator on the other site can.
    modern.setPrefs('cheat2', { mode: 'public' });
    sync();
    assert.equal(legacy.board({ metric: 'chat', window: 'today', site: 'all', handle: 'honest' }).rows.length, 1);
    modern.accounts.get('viewer').admin = false;
    assert.ok(modern.setBan(cheatId, false));
    sync();
    assert.equal(legacy.board({ metric: 'chat', window: 'today', site: 'all', handle: 'honest' }).rows.length, 2);
    // Kept across a restart.
    legacy.setBan(cheatId, true);
    const { store: next } = makeStore('legacy');
    next.importState(JSON.parse(JSON.stringify(legacy.exportState())));
    assert.equal(next.latestBan(cheatId)?.banned, true);
});

test('two sites: the same Discord account is one person with both badges; changes travel in small steps', () => {
    const legacy = makeStore('legacy').store;
    const modern = makeStore('modern').store;
    legacy.ensureAccount({ handle: 'old-me', name: '老我', discord: '111111111111' });
    legacy.ensureAccount({ handle: 'old-other', name: '别人', discord: '222222222222' });
    modern.ensureAccount({ handle: 'new-me', name: '跨站的我', discord: '111111111111' });
    const add = (store, handle, values) => {
        const stats = store.dayStats(store.accounts.get(handle), dayOf(NOON));
        for (const [key, value] of Object.entries(values)) stats[key] += value;
        store.touch(store.accounts.get(handle), stats);
    };
    add(legacy, 'old-me', { ai: 4, online: 20 * 3600e3 });
    add(legacy, 'old-other', { ai: 6 });
    add(modern, 'new-me', { ai: 5, online: 3 * 3600e3 });
    assert.ok(modern.setPrefs('new-me', { mode: 'public' }).prefs);

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
            ['跨站的我#1', 9, 'legacy+modern'],
            ['匿名用户#3', 6, 'legacy'],
        ]);
        assert.equal(view.me.rank, 1);
        // Online time of one person is capped per day across both sites.
        assert.equal(store.board({ metric: 'online', window: 'today', site: 'all', handle }).me.value, LIMITS.ONLINE_DAY_CAP_MS);
    }
    // The site filter ranks only what was done on that site.
    assert.deepEqual(modern.board({ metric: 'chat', window: 'today', site: 'modern', handle: 'new-me' }).rows.map(row => row.value), [5]);
    // Display names go over only for real name.
    assert.ok(!JSON.stringify(legacy.exportForPeer(-1, 'none')).includes('老我'));
    assert.ok(JSON.stringify(modern.exportForPeer(-1, 'none')).includes('跨站的我'));

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

test('one person on two sites: the oldest account numbers them, badges show where the numbers came from, copied days count once', () => {
    const legacy = makeStore('legacy').store;
    const modern = makeStore('modern').store;
    const today = dayOf(NOON);
    legacy.ensureAccount({ handle: 'oldtimer-11111', discord: '777777777777', created: NOON - 300 * 864e5 });
    modern.ensureAccount({ handle: 'newname-99999', discord: '777777777777', created: NOON - 30 * 864e5 });
    modern.ensureAccount({ handle: 'stayer-22222', discord: '888888888888', created: NOON - 30 * 864e5 });
    legacy.ensureAccount({ handle: 'idle-33333', discord: '888888888888', created: NOON - 200 * 864e5 });
    const set = (store, handle, day, values) => {
        const account = store.accounts.get(handle);
        const stats = store.dayStats(account, day);
        Object.assign(stats, values);
        store.touch(account, stats);
    };
    // History copied to the new site with the account: the same numbers on the same days.
    set(legacy, 'oldtimer-11111', today - 10, { ai: 40, chars: 8000, user: 35 });
    set(modern, 'newname-99999', today - 10, { ai: 40, chars: 8000, user: 35 });
    // Since then: on the new site only.
    set(modern, 'newname-99999', today, { ai: 7, chars: 700, user: 6 });
    // Someone with an idle old account: all of it on the new site.
    set(modern, 'stayer-22222', today, { ai: 3, chars: 300, user: 3 });
    modern.applyPeer('https://legacy', legacy.exportForPeer(-1, 'none'));
    legacy.applyPeer('https://modern', modern.exportForPeer(-1, 'none'));
    for (const [store, handle] of [[legacy, 'oldtimer-11111'], [modern, 'newname-99999']]) {
        const all = store.board({ metric: 'chat', window: 'all', site: 'all', handle });
        assert.deepEqual(all.rows.map(row => [row.name, row.value, row.sites.join('+')]), [
            ['匿名用户#1', 47, 'legacy+modern'],
            ['匿名用户#3', 3, 'modern'],
        ], 'copied days once; the idle account adds no badge; named after the oldest account');
        const today_ = store.board({ metric: 'chat', window: 'today', site: 'all', handle });
        assert.deepEqual(today_.rows.map(row => [row.value, row.sites.join('+')]), [[7, 'modern'], [3, 'modern']]);
        assert.equal(all.me.name, '匿名用户#1');
    }
    // Looking at one site alone, each counts what it has.
    assert.equal(modern.board({ metric: 'chat', window: 'all', site: 'modern', handle: 'newname-99999' }).me.value, 47);
    assert.equal(modern.board({ metric: 'chat', window: 'all', site: 'legacy', handle: 'newname-99999' }).me.value, 40);
});

test('real name: the display name of the account it was chosen with, sent over only for those who chose it', () => {
    const legacy = makeStore('legacy').store;
    const modern = makeStore('modern').store;
    legacy.ensureAccount({ handle: 'oldtimer-11111', name: '老张', discord: '666666666666', created: NOON - 300 * 864e5 });
    modern.ensureAccount({ handle: 'newname-99999', name: '新张', discord: '666666666666', created: NOON - 30 * 864e5 });
    modern.ensureAccount({ handle: 'quiet-55555', name: '安静', created: NOON - 30 * 864e5 });
    for (const [store, handle, count] of [[legacy, 'oldtimer-11111', 6], [modern, 'quiet-55555', 5]]) {
        const account = store.accounts.get(handle);
        const stats = store.dayStats(account, dayOf(NOON));
        stats.ai = count;
        store.touch(account, stats);
    }
    const sync = () => {
        modern.applyPeer('https://legacy', legacy.exportForPeer(-1, 'none'));
        legacy.applyPeer('https://modern', modern.exportForPeer(-1, 'none'));
    };
    const names = store => store.board({ metric: 'chat', window: 'today', site: 'all', handle: 'x' }).rows.map(row => [row.name, row.anonymous]);
    // Chosen on the new site: its display name, with the number of the older account.
    assert.ok(modern.setPrefs('newname-99999', { mode: 'public' }).prefs);
    assert.equal(modern.prefsOf('newname-99999').publicName, '新张#2', 'before hearing of the older account');
    sync();
    assert.equal(modern.prefsOf('newname-99999').publicName, '新张#1');
    const exported = modern.exportForPeer(-1, 'none').accounts;
    assert.equal(exported.find(account => account.p.mode === 'public').nm, '新张');
    assert.ok(exported.filter(account => account.p.mode !== 'public').every(account => !('nm' in account)), 'nobody else\'s display name leaves the site');
    for (const store of [legacy, modern]) assert.deepEqual(names(store), [['新张#1', false], ['匿名用户#4', true]]);
    // Changed back on the old site later: anonymous everywhere again.
    assert.ok(legacy.setPrefs('oldtimer-11111', { mode: 'anon' }).prefs);
    sync();
    for (const store of [legacy, modern]) assert.equal(names(store)[0][0], '匿名用户#1');
    // Real name chosen on the old site: the old site's display name.
    assert.ok(legacy.setPrefs('oldtimer-11111', { mode: 'public' }).prefs);
    sync();
    for (const store of [legacy, modern]) assert.equal(names(store)[0][0], '老张#1');
    // Administrators answer the launch notice too, and are ranked like everybody.
    const boss = legacy.ensureAccount({ handle: 'boss-00001', name: '站长', admin: true });
    assert.ok(legacy.setPrefs('boss-00001', { mode: 'public' }).prefs);
    assert.equal(legacy.prefsOf('boss-00001').explicit, true);
    const stats = legacy.dayStats(boss, dayOf(NOON));
    stats.ai = 2;
    legacy.touch(boss, stats);
    sync();
    for (const store of [legacy, modern]) assert.ok(names(store).some(([name]) => name === `站长#${boss.number}`));
});

test('an administrator asks someone to choose again: undone on both sites, until they choose', () => {
    const legacy = makeStore('legacy');
    const modern = makeStore('modern');
    legacy.store.ensureAccount({ handle: 'sample-1', name: '示例', discord: '121212121212', created: NOON - 100 * 864e5 });
    modern.store.ensureAccount({ handle: 'sample-2', name: '示例', discord: '121212121212', created: NOON - 10 * 864e5 });
    modern.store.ensureAccount({ handle: 'only-modern' });
    const sync = () => {
        modern.store.applyPeer('https://legacy', legacy.store.exportForPeer(-1, 'none'));
        legacy.store.applyPeer('https://modern', modern.store.exportForPeer(-1, 'none'));
    };
    // Chose real name on the new site.
    assert.ok(modern.store.setPrefs('sample-2', { mode: 'public' }).prefs);
    sync();
    assert.equal(legacy.store.prefsOf('sample-1').explicit, true);
    // An administrator on the old site undoes it: both sites ask again, anonymous meanwhile.
    legacy.clock.now = modern.clock.now = NOON + MINUTE;
    const key = legacy.store.personKeyOf('sample-1');
    assert.equal(legacy.store.resetChoice(key), 1);
    sync();
    for (const [store, handle] of [[legacy.store, 'sample-1'], [modern.store, 'sample-2']]) {
        assert.deepEqual([store.prefsOf(handle).explicit, store.prefsOf(handle).mode], [false, 'anon']);
    }
    // The new site notices it was undone over there and can tell their pages there at once.
    assert.deepEqual(modern.store.takeChoiceResets(), [key]);
    assert.deepEqual(modern.store.people().get(key).handles, ['sample-2']);
    assert.deepEqual(legacy.store.takeChoiceResets(), [], 'undone here: told by the request itself');
    // Asking for everything again is no news.
    modern.store.applyPeer('https://legacy', legacy.store.exportForPeer(-1, 'other-epoch'));
    assert.deepEqual(modern.store.takeChoiceResets(), []);
    // They choose again (on either site): asked no more.
    modern.clock.now = NOON + 2 * MINUTE;
    assert.ok(modern.store.setPrefs('sample-2', { mode: 'anon' }).prefs);
    sync();
    for (const [store, handle] of [[legacy.store, 'sample-1'], [modern.store, 'sample-2']]) {
        assert.equal(store.prefsOf(handle).explicit, true);
    }
    // Someone with no account on this site cannot be reset from here; unknown accounts neither.
    assert.equal(legacy.store.resetChoice(modern.store.personKeyOf('only-modern')), 0);
    assert.equal(legacy.store.personKeyOf('nobody'), null);
});

test('the ROC flag is replaced by the PRC flag: when set, when stored before, when it comes from the other site', () => {
    const legacy = makeStore('legacy');
    const modern = makeStore('modern');
    legacy.store.ensureAccount({ handle: 'flag', name: '旗', discord: '575757575757', created: NOON - 100 * 864e5 });
    modern.store.ensureAccount({ handle: 'flag-2', name: '新站旗', discord: '575757575757', created: NOON - 10 * 864e5 });
    assert.deepEqual(modern.store.setEmoji('flag-2', 'chat', '🇹🇼').emoji, { chat: '🇨🇳' });
    // Stored before the replacement (or sent by a site that is not updated yet): read as the PRC flag.
    const account = legacy.store.accounts.get('flag');
    account.prefs = { ...account.prefs, emoji: { all: '🇹🇼' }, emojiAt: legacy.store.now() + 5 };
    account.v = legacy.store.bump();
    modern.store.applyPeer('https://legacy', legacy.store.exportForPeer(-1, 'none'));
    assert.equal(modern.store.prefsOf('flag-2').emojis.all, '🇨🇳');
});

test('an emoji next to the name: one board or all, both sites, apart from the choice; administrators clear it', () => {
    for (const emoji of ['🔥', '👍🏽', '🇨🇳', '1️⃣', '👨‍👩‍👧', '❤️']) assert.equal(cleanEmoji(emoji), emoji);
    for (const text of ['a', '中', '🔥🔥', '', ' ', '<b>', 'A🔥', '\u202e🔥', '#', 42, null]) assert.equal(cleanEmoji(text), '', String(text));
    assert.equal(cleanEmoji('🇹🇼'), '🇨🇳', 'the ROC flag becomes the PRC flag');
    assert.deepEqual(withEmoji({}, 'chat', '🔥'), { chat: '🔥' });
    assert.deepEqual(withEmoji({ chat: '🔥' }, 'all', '🌙'), { all: '🌙' }, 'all boards replace single ones');
    assert.deepEqual(withEmoji({ all: '🌙' }, 'chat', ''), { all: '🌙', chat: '' }, 'none on one board');
    assert.deepEqual(withEmoji({ all: '🌙', chat: '' }, 'chat', '🌙'), { all: '🌙' });
    assert.deepEqual(withEmoji({ chat: '🔥' }, 'chat', ''), {});
    assert.deepEqual(withEmoji({ all: '🌙', chat: '🔥' }, 'all', ''), {});

    const legacy = makeStore('legacy');
    const modern = makeStore('modern');
    legacy.store.ensureAccount({ handle: 'fan', name: '粉丝', discord: '565656565656', created: NOON - 100 * 864e5 });
    modern.store.ensureAccount({ handle: 'fan-2', name: '新站粉丝', discord: '565656565656', created: NOON - 10 * 864e5 });
    const fan = legacy.store.accounts.get('fan');
    const stats = legacy.store.dayStats(fan, dayOf(NOON));
    stats.ai += 3;
    stats.chars += 300;
    legacy.store.touch(fan, stats);
    const sync = () => {
        modern.store.applyPeer('https://legacy', legacy.store.exportForPeer(-1, 'none'));
        legacy.store.applyPeer('https://modern', modern.store.exportForPeer(-1, 'none'));
    };
    const row = (store, handle, metric) => store.board({ metric, window: 'today', site: 'all', handle }).rows[0];
    const everywhere = check => {
        for (const [store, handle] of [[legacy.store, 'fan'], [modern.store, 'fan-2']]) check(store, handle);
    };
    // Real name, chosen on the old site.
    legacy.store.setPrefs('fan', { mode: 'public' });
    sync();

    // An emoji on one board, set on the new site.
    assert.deepEqual(modern.store.setEmoji('fan-2', 'chat', '🔥').emoji, { chat: '🔥' });
    assert.equal(modern.store.setEmoji('fan-2', 'chat', 'no').error, 'bad_emoji');
    assert.equal(modern.store.setEmoji('fan-2', 'nope', '🔥').error, 'bad_scope');
    sync();
    everywhere((store, handle) => {
        assert.equal(row(store, handle, 'chat').emoji, '🔥');
        assert.equal(row(store, handle, 'words').emoji, undefined);
        // Changing the emoji over there does not make it the account the name comes from.
        assert.equal(row(store, handle, 'chat').name, '粉丝#1');
    });
    // All boards; then none on one of them.
    legacy.store.setEmoji('fan', 'all', '🌙');
    sync();
    everywhere((store, handle) => assert.deepEqual([row(store, handle, 'chat').emoji, row(store, handle, 'words').emoji], ['🌙', '🌙']));
    legacy.store.setEmoji('fan', 'words', '');
    sync();
    everywhere((store, handle) => {
        assert.deepEqual([row(store, handle, 'chat').emoji, row(store, handle, 'words').emoji], ['🌙', undefined]);
        assert.deepEqual(store.prefsOf(handle).emojis, { all: '🌙', words: '' });
        assert.equal(store.board({ metric: 'words', window: 'today', site: 'all', handle }).me.emoji, '');
    });
    // Asked to choose again: the emoji stays.
    const key = legacy.store.personKeyOf('fan');
    legacy.store.resetChoice(key);
    sync();
    everywhere((store, handle) => assert.equal(row(store, handle, 'chat').emoji, '🌙'));
    // Saved and loaded again.
    const restored = makeStore('legacy').store;
    assert.ok(restored.importState(JSON.parse(JSON.stringify(legacy.store.exportState()))));
    assert.deepEqual(restored.accounts.get('fan').prefs.emoji, { all: '🌙', words: '' });
    // An administrator of the new site clears it: gone on both.
    assert.equal(modern.store.clearEmoji(key), 1);
    assert.equal(modern.store.clearEmoji('nobody'), 0);
    sync();
    everywhere((store, handle) => assert.equal(row(store, handle, 'chat').emoji, undefined));
});

test('administrators are counted, ranked and sent to the other site like everybody', () => {
    const { store } = makeStore();
    store.ensureAccount({ handle: 'boss', admin: true });
    store.recordGeneration('boss', NOON - 1000);
    assert.equal(store.recordMessages('boss', [ai(NOON - 5 * MINUTE, 'g'), ai(NOON - 500)], {}), 1);
    assert.equal(store.exportForPeer(-1, '').accounts.length, 1);
    const view = store.board({ metric: 'chat', window: 'today', site: 'all', handle: 'boss' });
    assert.equal(view.admin, true, 'still administrators: they can take people off');
    assert.equal(view.me.rank, 1);
    assert.deepEqual(view.rows.map(row => row.value), [1]);
});

test('administrators carry a mark on both sites, until they are no longer administrators', () => {
    const legacy = makeStore('legacy').store;
    const modern = makeStore('modern').store;
    legacy.ensureAccount({ handle: 'boss', admin: true, discord: '333333333333' });
    legacy.ensureAccount({ handle: 'user', discord: '444444444444' });
    modern.ensureAccount({ handle: 'viewer', discord: '555555555555' });
    for (const handle of ['boss', 'user']) {
        const stats = legacy.dayStats(legacy.accounts.get(handle), dayOf(NOON));
        stats.ai += handle === 'boss' ? 2 : 1;
        legacy.touch(legacy.accounts.get(handle), stats);
    }
    const sync = () => modern.applyPeer('https://legacy', legacy.exportForPeer(modern.peers.get('https://legacy')?.version ?? -1, modern.peers.get('https://legacy')?.epoch ?? 'none'));
    sync();
    const marks = store => store.board({ metric: 'chat', window: 'today', site: 'all', handle: 'viewer' }).rows.map(row => !!row.admin);
    assert.deepEqual(marks(modern), [true, false]);
    assert.equal(legacy.board({ metric: 'chat', window: 'today', site: 'all', handle: 'boss' }).me.admin, true);

    legacy.ensureAccount({ handle: 'boss', admin: false, discord: '333333333333' });
    sync();
    assert.deepEqual(marks(modern), [false, false]);
});

test('an administrator tries their own place out: only they see it, the shared board stays real', () => {
    const { store } = makeStore();
    for (const [handle, ai] of [['boss', 2], ['p1', 30], ['p2', 20], ['p3', 10]]) {
        store.ensureAccount({ handle, admin: handle === 'boss' });
        const stats = store.dayStats(store.accounts.get(handle), dayOf(NOON));
        stats.ai += ai;
        store.touch(store.accounts.get(handle), stats);
    }
    const query = { metric: 'chat', window: 'today', site: 'all' };
    const real = store.board({ ...query, handle: 'boss' });
    assert.equal(real.me.rank, 4);

    // Second place: between the first and the second of the others.
    const value = store.valueForRank({ ...query, handle: 'boss', rank: 2 });
    assert.equal(value, 21);
    const trying = store.board({ ...query, handle: 'boss', test: value });
    assert.deepEqual(trying.rows.map(row => [row.rank, row.value, row.me]), [[1, 30, false], [2, 21, true], [3, 20, false], [4, 10, false]]);
    assert.deepEqual([trying.me.rank, trying.me.value, trying.me.real, trying.me.testing], [2, 21, 2, true]);
    assert.notEqual(trying.version, real.version, 'a new version, so the page shows the change');
    // Everybody else (and the shared ranking) still sees the real numbers.
    assert.deepEqual(store.board({ ...query, handle: 'p1' }).rows.map(row => row.value), [30, 20, 10, 2]);
    assert.equal(store.board({ ...query, handle: 'boss' }).me.rank, 4);
    // Not for anybody else, whatever they send.
    assert.equal(store.board({ ...query, handle: 'p3', test: 99 }).me.rank, 3);

    // First place, last place, and no room in between: shared.
    assert.equal(store.valueForRank({ ...query, handle: 'boss', rank: 1 }), 35);
    assert.equal(store.valueForRank({ ...query, handle: 'boss', rank: 10 }), 9);
    const crowded = store.board({ ...query, handle: 'boss', test: 20 });
    assert.deepEqual(crowded.rows.filter(row => row.value === 20).map(row => row.rank), [2, 2]);
});

test('saved numbers survive a restart, and recent messages are not counted again', () => {
    const { store, clock } = makeStore();
    store.ensureAccount({ handle: 'a', name: '存档', created: 5, discord: '333333333333' });
    store.recordGeneration('a', NOON - 1000);
    const chat = [ai(NOON - 10 * MINUTE, 'g'), user(NOON - 2000), ai(NOON - 500, 'reply')];
    store.recordMessages('a', chat, { fromStart: true });
    store.recordGeneration('a', NOON);
    store.setPrefs('a', { mode: 'public' });
    store.backfilled.add('a');
    const saved = JSON.parse(JSON.stringify(store.exportState()));

    const { store: next } = makeStore('legacy', clock.now + 1000);
    assert.ok(next.importState(saved));
    assert.notEqual(next.epoch, store.epoch);
    assert.equal(next.countingSince, store.countingSince);
    assert.ok(next.backfilled.has('a'));
    assert.equal(next.prefsOf('a').mode, 'public');
    assert.equal(next.board({ metric: 'chat', window: 'today', site: 'all', handle: 'a' }).me.name, '存档#1');
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

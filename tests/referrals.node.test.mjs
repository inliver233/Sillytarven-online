import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import storage from 'node-persist';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-referrals-'));
globalThis.DATA_ROOT = dataRoot;
await storage.init({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0 });
const configPath = path.join(dataRoot, 'config.yaml');
// This site is the old one; the new one is faked (setPeerTransport) in the cross-site test.
fs.writeFileSync(configPath, 'userStorage:\n  enabled: true\n  defaultLimitMiB: 2000\nleaderboard:\n  site: legacy\n  secret: test-secret-0123456789\n  peers:\n    - url: http://peer.invalid\n'
    + 'registration:\n  password:\n    enabled: false\n  github:\n    enabled: false\n  discord:\n    enabled: false\n  linuxdo:\n    enabled: false\n');
const { setConfigFilePath } = await import('../src/util.js');
setConfigFilePath(configPath);

const referrals = await import('../src/referrals.js');
const { setPeerTransport, identityKey } = await import('../src/referral-peer.js');
const { signPeerRequest } = await import('../src/leaderboard.js');
const { setUserInvitationConfig } = await import('../src/user-invitations.js');
const { router, peerRouter } = await import('../src/endpoints/referrals.js');
const { default: systemMonitor } = await import('../src/system-monitor.js');
after(() => {
    systemMonitor.destroy();
    systemMonitor.saveDataToDisk = () => {};
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

const DAY = 86_400_000;
async function makeUser(handle, ageDays) {
    await storage.setItem(`user:${handle}`, { handle, name: handle, created: Date.now() - ageDays * DAY, enabled: true, admin: false, storageLimitMiB: 2000 });
}
const limit = async handle => (await storage.getItem(`user:${handle}`)).storageLimitMiB;
const link = handle => storage.getItem(`referral:link:${handle}`);
/** noteValidReply settles in the background */
async function settled(handle, status = 'success') {
    for (let i = 0; i < 100; i++) {
        if ((await link(handle))?.status === status) return link(handle);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`${handle} never became ${status}`);
}

await setUserInvitationConfig({ minRegisteredDays: 7, minOnlineHours: 0 });
for (const [handle, age] of [['alice', 60], ['bob', 1], ['carol', 30], ['dave', 0], ['erin', 0], ['frank', 60], ['gina', 2]]) await makeUser(handle, age);

test('off by default; once on, a new account binds, and both get space after its first valid reply', async () => {
    const code = await referrals.ensureCode('alice');
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.equal(await referrals.ensureCode('alice'), code, 'one code per user');
    assert.deepEqual(await referrals.claimReferral('bob', code), { ok: false, reason: '邀请奖励暂未开放' });

    await referrals.setReferralConfig({ enabled: true, inviterRewardMiB: 500, inviteeRewardMiB: 200, inviterCapMiB: 600, claimWindowDays: 7, requireValidReply: true });
    const claimed = await referrals.claimReferral('bob', code.toLowerCase(), { source: 'link' });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.link.status, 'pending');
    assert.deepEqual([await limit('alice'), await limit('bob')], [2000, 2000], 'nothing yet');

    referrals.noteValidReply('bob');
    const done = await settled('bob');
    assert.deepEqual([done.inviterRewardMiB, done.inviteeRewardMiB], [500, 200]);
    assert.deepEqual([await limit('alice'), await limit('bob')], [2500, 2200]);
    referrals.noteValidReply('bob');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual([await limit('alice'), await limit('bob')], [2500, 2200], 'rewarded once');

    const mine = await referrals.getMyReferralData('alice');
    assert.equal(mine.code, code);
    assert.equal(mine.earnedMiB, 500);
    assert.deepEqual(mine.invitees.map(item => [item.name, item.status, item.rewardMiB]), [['bob', 'success', 500]]);
    const theirs = await referrals.getMyReferralData('bob');
    assert.deepEqual([theirs.invitedBy.name, theirs.invitedBy.rewardMiB, theirs.canClaim, theirs.eligible], ['alice', 200, false, false]);
});

test('the rules: once only, new accounts only, not oneself, not each other, a capped inviter', async () => {
    const code = await referrals.ensureCode('alice');
    assert.equal((await referrals.claimReferral('bob', code)).reason, '你已经绑定过邀请人了');
    assert.equal((await referrals.claimReferral('carol', code)).reason, '只有注册 7 天内的新账号可以绑定邀请人');
    assert.equal((await referrals.claimReferral('alice', code)).reason, '不能填写自己的邀请码');
    assert.equal((await referrals.claimReferral('dave', 'NOPE2345')).reason, '邀请码不存在或已更换');
    assert.equal((await referrals.claimReferral('dave', await referrals.ensureCode('gina'))).reason, '这个邀请人暂时还不能邀请别人', 'gina is only 2 days old');

    // The cap (600): 500 already earned, so 100 more; the new account still gets its 200.
    await referrals.claimReferral('dave', code);
    referrals.noteValidReply('dave');
    const capped = await settled('dave');
    assert.deepEqual([capped.inviterRewardMiB, capped.inviteeRewardMiB], [100, 200]);
    assert.deepEqual([await limit('alice'), await limit('dave')], [2600, 2200]);

    // Not each other (with a wide window, so that old accounts may bind).
    await referrals.setReferralConfig({ claimWindowDays: 3650 });
    assert.equal((await referrals.claimReferral('frank', code)).ok, true);
    assert.equal((await referrals.claimReferral('alice', await referrals.ensureCode('frank'))).reason, '不能互相邀请');
    await referrals.setReferralConfig({ claimWindowDays: 7 });

    // A new code: the old one stops working, bindings stay.
    const fresh = await referrals.resetCode('alice');
    assert.notEqual(fresh, code);
    assert.equal((await referrals.claimReferral('erin', code)).reason, '邀请码不存在或已更换');
});

test('already chatted, or no reply needed: settled at once; old pending ones expire; admins approve and revoke', async () => {
    const code = await referrals.ensureCode('frank');
    await referrals.setReferralConfig({ inviterCapMiB: 0 });
    const chatted = await referrals.claimReferral('erin', code, { hadValidReply: true });
    assert.equal(chatted.link.status, 'success');
    assert.deepEqual([await limit('frank'), await limit('erin')], [2500, 2200]);

    await makeUser('hank', 1);
    await makeUser('ivy', 1);
    await referrals.setReferralConfig({ requireValidReply: false });
    assert.equal((await referrals.claimReferral('hank', code)).link.status, 'success');
    await referrals.setReferralConfig({ requireValidReply: true, pendingExpireDays: 1 });
    await referrals.claimReferral('ivy', code);
    const stale = await link('ivy');
    await storage.setItem('referral:link:ivy', { ...stale, boundAt: Date.now() - 2 * DAY });
    const listed = await referrals.listReferrals({ status: 'expired' });
    assert.deepEqual(listed.rows.map(row => row.invitee), ['ivy']);
    assert.equal(listed.summary.expired, 1);
    assert.equal(listed.top[0].inviter, 'frank');
    referrals.noteValidReply('ivy');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await link('ivy')).status, 'expired', 'too late');

    assert.equal((await referrals.approveReferral('ivy')).ok, true);
    assert.equal((await link('ivy')).status, 'success');
    const before = [await limit('frank'), await limit('ivy')];
    assert.equal((await referrals.revokeReferral('ivy', { reclaim: true, by: 'admin' })).ok, true);
    assert.deepEqual([await limit('frank'), await limit('ivy')], [before[0] - 500, before[1] - 200]);
    assert.equal((await referrals.getMyReferralData('frank')).invitees.find(item => item.name === 'ivy').status, 'revoked');
});

test('a registration code a user issued counts as an invitation', async () => {
    await makeUser('jack', 0);
    await referrals.setReferralConfig({ requireValidReply: true });
    await referrals.bindFromInvitation({ issuanceSource: 'user', createdBy: 'alice', code: 'ABCDEF0123456789' }, 'jack');
    const bound = await link('jack');
    assert.deepEqual([bound.inviter, bound.source, bound.status], ['alice', 'registration', 'pending']);
    await makeUser('kate', 0);
    await referrals.bindFromInvitation({ issuanceSource: 'admin', createdBy: 'root', code: 'ABCDEF0123456780' }, 'kate');
    assert.equal(await link('kate'), undefined, 'administrator codes do not');
});

test('the API: a new user binds by code; errors come back as messages; admins only for the admin part', async t => {
    await makeUser('liam', 0);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const handle = request.get('x-test-user');
        request.user = { profile: { handle, admin: handle === 'alice' } };
        next();
    });
    app.use('/api/referrals', router);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api/referrals`;
    const call = (user, route, body) => fetch(`${base}${route}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-test-user': user },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async response => ({ status: response.status, data: await response.json().catch(() => null) }));

    assert.deepEqual((await call('liam', '/status')).data, { enabled: true, rewardMiB: 500 });
    const mine = await call('liam', '/my');
    assert.deepEqual([mine.data.canClaim, mine.data.eligible, mine.data.code], [true, false, null]);
    assert.equal((await call('liam', '/code', {})).status, 403);
    const code = (await call('alice', '/code', {})).data.code;
    assert.equal((await call('liam', '/claim', { code: 'WRONG234' })).data.error, '邀请码不存在或已更换');
    const claimed = await call('liam', '/claim', { code, source: 'link' });
    assert.deepEqual(claimed.data, { status: 'pending', rewardMiB: 0 });
    assert.equal((await call('liam', '/admin/list')).status, 403);
    await storage.setItem('user:liam', { ...await storage.getItem('user:liam'), name: 'Liam L.' });
    const listed = await call('alice', '/admin/list?query=liam');
    assert.deepEqual(listed.data.rows.map(row => [row.invitee, row.inviteeName, row.inviterName, row.source]), [['liam', 'Liam L.', 'alice', 'link']]);
    assert.equal((await call('alice', '/my')).data.invitees.find(item => item.status === 'pending' && item.name === 'Liam L.')?.name, 'Liam L.', 'inviters see display names');
    const config = await call('alice', '/admin/config', { inviteeRewardMiB: 300, minRegisteredDays: 10 });
    assert.deepEqual([config.data.inviteeRewardMiB, config.data.minRegisteredDays, config.data.enabled, config.data.rewardsAvailable], [300, 10, true, true]);
});

test('admins can stop someone inviting: the code dies, they earn nothing more, and their invitations can go', async () => {
    for (const handle of ['mona', 'nina', 'otto']) await makeUser(handle, 0);
    // From the tests above: the inviter gets 500, the new account 300, no cap.
    const code = await referrals.ensureCode('carol');
    await referrals.claimReferral('mona', code);
    referrals.noteValidReply('mona');
    await settled('mona');
    await referrals.claimReferral('nina', code);
    const [carolBefore, monaBefore] = [await limit('carol'), await limit('mona')];

    // Stopped: the code no longer works, no new one, and a pending invitation pays only the new account.
    assert.deepEqual(await referrals.setInviterBlocked('carol', true, { by: 'admin' }), { ok: true, mode: 'block', revoked: 0 });
    assert.equal((await referrals.claimReferral('otto', code)).reason, '邀请码不存在或已更换');
    await assert.rejects(referrals.ensureCode('carol'), /停用/);
    const mine = await referrals.getMyReferralData('carol');
    assert.deepEqual([mine.blocked, mine.eligible, mine.code], [true, false, null]);
    referrals.noteValidReply('nina');
    const late = await settled('nina');
    assert.deepEqual([late.inviterRewardMiB, late.inviteeRewardMiB], [0, 300]);
    assert.equal(await limit('carol'), carolBefore);

    // Only carol's, exactly; with how the new accounts are doing.
    const listed = await referrals.listReferrals({ inviter: 'carol' });
    assert.deepEqual(listed.rows.map(row => row.invitee).sort(), ['mona', 'nina']);
    assert.deepEqual([listed.focus.blocked, listed.focus.total, listed.focus.earnedMiB], [true, 2, 500]);
    assert.equal(listed.rows[0].inviteeOnlineHours, 0);
    assert.equal(typeof listed.rows[0].inviteeCreated, 'number');
    assert.equal(listed.top.find(row => row.inviter === 'carol').blocked, true);

    // Everything taken back.
    assert.deepEqual(await referrals.setInviterBlocked('carol', true, { revokeAll: true, reclaim: true, by: 'admin' }), { ok: true, mode: 'block', revoked: 2 });
    assert.deepEqual([await limit('carol'), await limit('mona'), await limit('nina')], [carolBefore - 500, monaBefore - 300, 2000]);

    // Allowed again: a new code, which works.
    await referrals.setInviterBlocked('carol', false, { by: 'admin' });
    const fresh = await referrals.ensureCode('carol');
    assert.notEqual(fresh, code);
    assert.equal((await referrals.claimReferral('otto', fresh)).ok, true);
    assert.equal((await referrals.setInviterBlocked('nobody', true)).ok, false);
});

test('the defaults are modest', () => {
    const defaults = referrals.mergeReferralConfig(undefined);
    assert.deepEqual([defaults.enabled, defaults.inviterRewardMiB, defaults.inviteeRewardMiB, defaults.inviterCapMiB], [false, 150, 150, 3000]);
});

/** Waits until check() is true (background work: the outbox, settling). */
async function until(check, what) {
    for (let i = 0; i < 200; i++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`never: ${what}`);
}

test('across the two sites: codes of the other site work here, and this site pays its own inviters', async t => {
    // The other site (new): one user zed with code ZEDZED22, open registration; it records what it is told.
    const told = [];
    setPeerTransport(async (path, payload) => {
        told.push({ path, payload });
        if (path === '/info') return { ok: true, site: 'modern', enabled: true, crossSite: true, registrationOpen: true, inviteeRewardMiB: 150 };
        if (path === '/lookup') return payload.code === 'ZEDZED22' ? { ok: true, site: 'modern', inviter: 'zed', inviterName: 'Zed' } : { ok: false, reason: '邀请码不存在或已更换' };
        if (path === '/sync') return { ok: true, inviterRewardMiB: payload.status === 'success' ? 150 : 0 };
        return { ok: true };
    });
    t.after(() => setPeerTransport(null));

    // Off: the other site's code is unknown here.
    await makeUser('pia', 0);
    assert.equal((await referrals.claimReferral('pia', 'ZEDZED22')).reason, '邀请码不存在或已更换');
    assert.equal(told.length, 0, 'not asked while cross-site invitations are off');

    // On: asked over there, bound here; the other site hears about it, then about the success.
    await referrals.setReferralConfig({ crossSite: true });
    const bound = await referrals.claimReferral('pia', 'zedzed22', { source: 'link' });
    assert.deepEqual([bound.ok, bound.link.inviterSite, bound.link.inviter], [true, 'modern', 'zed']);
    await until(() => told.some(call => call.path === '/sync' && call.payload.status === 'pending'), 'told about the binding');
    const piaBefore = await limit('pia');
    referrals.noteValidReply('pia');
    await until(async () => (await link('pia'))?.inviterRewardMiB === 150, 'the other site paid zed');
    assert.equal(await limit('pia'), piaBefore + 300, 'this site pays the new account');
    assert.equal((await referrals.getMyReferralData('pia')).invitedBy.name, 'Zed（新站）');
    assert.equal(await limit('zed').catch(() => 'none'), 'none', 'zed is not an account here');

    // Revoked here with the space taken back: both halves.
    await referrals.revokeReferral('pia', { reclaim: true, by: 'admin' });
    assert.equal(await limit('pia'), piaBefore);
    await until(() => told.some(call => call.path === '/sync' && call.payload.status === 'revoked' && call.payload.reclaim === true), 'told about the revocation');

    // Where the links go: this test site has no registration open, the other one has.
    const frankCode = await referrals.ensureCode('frank');
    const mine = await referrals.getMyReferralData('frank');
    assert.deepEqual(mine.targets.map(item => [item.site, item.label, item.remote, item.base, item.friendRewardMiB]), [['modern', '新站', true, 'http://peer.invalid/invite/', 150]]);

    // This site as the inviter's: the other site asks about frank's code, then tells about quin.
    assert.deepEqual(await referrals.answerPeerLookup({ code: frankCode }), { ok: true, site: 'legacy', inviter: 'frank', inviterName: 'frank' });
    await storage.setItem('user:frank', { ...await storage.getItem('user:frank'), oauthIdentities: { discord: '123456789012345678' } });
    assert.equal((await referrals.answerPeerLookup({ code: frankCode, identity: identityKey('123456789012345678') })).reason, '不能邀请自己在另一个站的账号');
    const frankBefore = await limit('frank');
    assert.deepEqual(await referrals.applyPeerSync({ inviteeSite: 'modern', invitee: 'quin', inviteeName: 'Quin', inviter: 'frank', code: frankCode, status: 'pending', boundAt: Date.now() }),
        { ok: true, inviterRewardMiB: 0, status: 'pending', flags: [] });
    const success = { inviteeSite: 'modern', invitee: 'quin', inviteeName: 'Quin', inviter: 'frank', code: frankCode, status: 'success', boundAt: Date.now(), successAt: Date.now(), inviteeRewardMiB: 150 };
    assert.equal((await referrals.applyPeerSync(success)).inviterRewardMiB, 500, 'paid by this site\'s rules');
    assert.equal((await referrals.applyPeerSync(success)).inviterRewardMiB, 500, 'told twice, paid once');
    assert.equal(await limit('frank'), frankBefore + 500);
    const frankView = await referrals.getMyReferralData('frank');
    assert.deepEqual(frankView.invitees.filter(item => item.name.startsWith('Quin')).map(item => [item.name, item.status, item.rewardMiB]), [['Quin（新站）', 'success', 500]]);
    assert.equal((await referrals.approveReferral('@modern:quin')).ok, false, 'decided over there');

    // Stopping frank here takes back what this site paid and tells the other site.
    await referrals.setInviterBlocked('frank', true, { revokeAll: true, reclaim: true, by: 'admin' });
    assert.equal(await limit('frank') <= frankBefore, true);
    await until(() => told.some(call => call.path === '/revoked' && call.payload.invitee === 'quin' && call.payload.inviter === 'frank' && call.payload.reclaim), 'told the other site');
    await referrals.setInviterBlocked('frank', false, { by: 'admin' });

    // The other site revokes one of its users' invitations here.
    await makeUser('rae', 0);
    await referrals.claimReferral('rae', 'ZEDZED22');
    assert.deepEqual(await referrals.applyPeerRevoke({ inviterSite: 'modern', inviter: 'zed', invitee: 'rae', reclaim: true }), { ok: true });
    assert.equal((await link('rae')).status, 'revoked');
    assert.equal((await referrals.applyPeerRevoke({ inviterSite: 'modern', inviter: 'someone', invitee: 'rae' })).ok, false);

    // Admin list: the other site's inviters are kept apart.
    const listed = await referrals.listReferrals({ inviter: 'modern:zed' });
    assert.deepEqual(listed.rows.map(row => row.invitee).sort(), ['pia', 'rae']);
    assert.deepEqual([listed.focus.remote, listed.focus.siteLabel], [true, '新站']);
    await referrals.setReferralConfig({ crossSite: false });
});

test('the cross-site endpoints answer only signed requests', async t => {
    await referrals.setReferralConfig({ crossSite: true });
    t.after(() => referrals.setReferralConfig({ crossSite: false }));
    const app = express();
    app.use(express.json());
    app.use('/api/referrals/peer', peerRouter);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api/referrals/peer`;
    const send = (path, payload, secret = 'test-secret-0123456789') => {
        const body = JSON.stringify(payload);
        return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-referral-auth': signPeerRequest(secret, Date.now(), `${path}\n${body}`) }, body })
            .then(async response => ({ status: response.status, data: await response.json() }));
    };
    const info = await send('/info', {});
    assert.deepEqual([info.status, info.data.site, info.data.crossSite, info.data.registrationOpen], [200, 'legacy', true, false]);
    assert.equal((await send('/info', {}, 'wrong-secret-0123456789')).status, 403);
    assert.equal((await send('/lookup', { code: 'NOPE2345' })).data.reason, '邀请码不存在或已更换');
});

test('admins let one person invite below the thresholds, or stop one who meets them', async () => {
    // The thresholds here: registered for 10 days (set through the API test above).
    await makeUser('sam', 1);
    await makeUser('tia', 0);
    const code = await referrals.ensureCode('sam');
    assert.equal((await referrals.getMyReferralData('sam')).eligible, false);
    assert.equal((await referrals.claimReferral('tia', code)).reason, '这个邀请人暂时还不能邀请别人');

    assert.deepEqual(await referrals.setInviterAccess('sam', 'allow', { by: 'admin' }), { ok: true, mode: 'allow', revoked: 0 });
    assert.equal((await referrals.getMyReferralData('sam')).eligible, true);
    assert.equal((await referrals.claimReferral('tia', code)).ok, true);
    const focus = (await referrals.listReferrals({ inviter: 'sam' })).focus;
    assert.deepEqual([focus.mode, focus.meetsThresholds, focus.eligible, focus.registeredDays, focus.total], ['allow', false, true, 1, 1]);
    assert.deepEqual((await referrals.listAccess()).filter(row => row.handle === 'sam').map(row => [row.mode, row.by]), [['allow', 'admin']]);

    // Back to the thresholds.
    await referrals.setInviterAccess('sam', 'default', { by: 'admin' });
    assert.equal((await referrals.getMyReferralData('sam')).eligible, false);
    assert.equal((await referrals.listAccess()).some(row => row.handle === 'sam'), false);

    // Someone who meets them, stopped.
    await referrals.setInviterAccess('frank', 'block', { by: 'admin' });
    const frank = (await referrals.listReferrals({ inviter: 'frank' })).focus;
    assert.deepEqual([frank.mode, frank.meetsThresholds, frank.eligible], ['block', true, false]);
    await referrals.setInviterAccess('frank', 'default', { by: 'admin' });
    assert.equal((await referrals.setInviterAccess('frank', 'whatever')).ok, false);
    assert.equal((await referrals.listReferrals({ inviter: 'nobody-here' })).focus.exists, false);
});

test('online time is rounded before it meets the threshold: 1.45 hours count as 2', async t => {
    const { roundOnlineHours } = await import('../src/user-invitations.js');
    const HOUR = 3_600_000;
    assert.deepEqual(roundOnlineHours(1.45 * HOUR), { tenths: 1.5, hours: 2 }, '1.45 → 1.5 → 2, despite 1.45 being 1.4499… in floating point');
    assert.deepEqual(roundOnlineHours(5_219_999), { tenths: 1.4, hours: 1 }, 'just under 1.45');
    assert.deepEqual(roundOnlineHours(1.5 * HOUR), { tenths: 1.5, hours: 2 });
    assert.deepEqual(roundOnlineHours(0.45 * HOUR), { tenths: 0.5, hours: 1 });
    assert.deepEqual(roundOnlineHours(0), { tenths: 0, hours: 0 });

    await setUserInvitationConfig({ minOnlineHours: 2 });
    t.after(() => setUserInvitationConfig({ minOnlineHours: 0 }));
    await makeUser('uma', 30);
    await makeUser('vic', 30);
    await storage.setItem('user-invitation:online-baseline:uma', { durationMs: 1.45 * HOUR });
    await storage.setItem('user-invitation:online-baseline:vic', { durationMs: 5_219_999 });
    assert.equal((await referrals.getMyReferralData('uma')).eligible, true, '1.45 hours: enough');
    assert.equal((await referrals.getMyReferralData('vic')).eligible, false, '1.44 hours: not');
    const focus = (await referrals.listReferrals({ inviter: 'uma' })).focus;
    assert.deepEqual([focus.onlineHours, focus.roundedHours, focus.meetsThresholds], [1.5, 2, true]);
});

test('a node managed by the Controller: links go to the Controller, which brings the code to the new account', async t => {
    assert.equal(referrals.inviteBase(), '', 'a site of its own: pages build <site>/invite/<code>');
    assert.match(referrals.renderInvitePage('abcd2345'), /location\.replace\("\/"\)/);
    process.env.SILLYTAVERN_STCONTROL_ENABLED = 'true';
    process.env.SILLYTAVERN_STCONTROL_CONTROLLERURL = 'https://controller.example/';
    t.after(() => {
        delete process.env.SILLYTAVERN_STCONTROL_ENABLED;
        delete process.env.SILLYTAVERN_STCONTROL_CONTROLLERURL;
    });
    assert.equal(referrals.inviteBase(), 'https://controller.example/?ref=');
    assert.equal((await referrals.answerPeerInfo()).inviteBase, 'https://controller.example/?ref=', 'the other site links here through the Controller too');
    const page = referrals.renderInvitePage('abcd2345');
    assert.match(page, /location\.replace\("https:\/\/controller\.example\/\?ref=ABCD2345"\)/, 'an old /invite link goes on to the Controller');
    assert.match(page, /st_pending_referral/);
    assert.doesNotMatch(referrals.renderInvitePage('<script>'), /<script>[^;]*<script>/, 'nothing of the address ends up in the page');

    // Sign-up on the Controller: the code arrives with the new account.
    await makeUser('wes', 0);
    const code = await referrals.ensureCode('alice');
    await referrals.bindFromLink('wes', code.toLowerCase());
    const bound = await link('wes');
    assert.deepEqual([bound.inviter, bound.source, bound.status], ['alice', 'link', 'pending']);
    await makeUser('xia', 0);
    await referrals.bindFromLink('xia', 'not a code');
    assert.equal(await link('xia'), undefined);
});

test('tracing: where things came from, kept for admins; raw addresses go after 90 days', async () => {
    const trace = await import('../src/referral-trace.js');
    assert.equal(trace.deviceFromCookies('a=1; st_did=abcdefghijklmnop1234; b=2'), 'abcdefghijklmnop1234');
    assert.equal(trace.deviceFromCookies('st_did=<bad>'), '');
    assert.equal(trace.maskIp('203.0.113.45'), '203.0.113.x');
    assert.equal(trace.maskIp('2001:db8:1234:5678::1'), '2001:db8:1234::/48');
    const ip = trace.describeIp('203.0.113.45');
    assert.equal(ip.ipHash.length, 32);
    assert.equal(ip.netHash, trace.describeIp('203.0.113.99').netHash, 'same network, same digest');
    assert.notEqual(ip.ipHash, trace.describeIp('203.0.113.99').ipHash);
    // Discord's own example: 175928847299117063 was created at 2016-04-30T11:18:25.796Z.
    assert.equal(Math.abs(trace.discordCreatedAt('175928847299117063') - Date.parse('2016-04-30T11:18:25.796Z')) < 10, true);

    const old = { at: Date.now() - 91 * DAY, ip: '203.0.113.45', ua: 'Firefox', net: '203.0.113.x', ipHash: 'h' };
    assert.equal(trace.scrubRaw(old), true);
    assert.deepEqual(Object.keys(old).sort(), ['at', 'ipHash', 'net']);
    assert.equal(trace.scrubRaw({ at: Date.now(), ip: '1.2.3.4' }), false);
});

test('tracing: suspicious invitations are marked (rewards still go out)', async () => {
    const trace = await import('../src/referral-trace.js');
    const at = (address, device) => ({ ...trace.describeIp(address), device, ua: 'Mozilla/5.0 Chrome/140' });
    await referrals.setReferralConfig({ requireValidReply: true, crossSite: false, claimWindowDays: 7 });
    await makeUser('yan', 60);
    const code = await referrals.ensureCode('yan');
    // Only people taking part are noted when they open the site.
    await makeUser('outsider', 60);
    await referrals.noteParticipant('outsider', at('198.51.100.1', 'outsiderdevice000001'));
    assert.deepEqual(await trace.readSeen('outsider'), []);
    await referrals.noteParticipant('yan', at('198.51.100.7', 'yandevice00000000001'));
    assert.equal((await trace.readSeen('yan')).length, 1);

    // A link opened before signing in, on the device that later binds.
    await referrals.noteInviteVisit('zoedevice00000000001', code, at('192.0.2.10', 'zoedevice00000000001'));
    for (const [handle, address, device] of [
        ['zoe', '198.51.100.7', 'yandevice00000000001'],   // yan's own device
        ['amy', '198.51.100.7', 'amydevice00000000001'],   // yan's IP
        ['ben', '198.51.100.200', 'bendevice00000000001'], // yan's network
        ['cal', '192.0.2.77', 'amydevice00000000001'],     // amy's device, another of yan's
        ['dan', '192.0.2.88', 'dandevice00000000001'],     // nothing in common: only the burst
    ]) {
        await makeUser(handle, 0);
        const result = await referrals.claimReferral(handle, code, { source: 'link', context: at(address, device) });
        assert.equal(result.ok, true, handle);
    }
    // zoe also opened the link on her own device first, and her Discord account is a week old.
    await storage.setItem('user:zoe', { ...await storage.getItem('user:zoe'), oauthIdentities: { discord: String(Math.floor((Date.now() - 7 * DAY - 1420070400000) * 4194304)) } });

    const listed = await referrals.listReferrals({ inviter: 'yan' });
    const flagsOf = handle => listed.rows.find(row => row.invitee === handle).flags.map(flag => flag.code).sort();
    assert.deepEqual(flagsOf('zoe'), ['burst', 'new-discord', 'same-device', 'sibling-ip'], 'amy used the same IP');
    assert.deepEqual(flagsOf('amy'), ['burst', 'same-ip', 'sibling-device', 'sibling-ip']);
    assert.deepEqual(flagsOf('ben'), ['burst', 'same-network']);
    assert.deepEqual(flagsOf('cal'), ['burst', 'sibling-device']);
    assert.deepEqual(flagsOf('dan'), ['burst']);
    assert.equal(listed.rows.find(row => row.invitee === 'zoe').risk, 'high');
    assert.equal(listed.rows.find(row => row.invitee === 'zoe').inviteeDiscordDays, 7);
    assert.equal(listed.focus.seen[0].ip, '198.51.100.7', 'the inviter\'s recent addresses, for the admin');

    // The admin can filter them, and search by address or device.
    const suspicious = await referrals.listReferrals({ status: 'suspicious', inviter: 'yan' });
    assert.deepEqual(suspicious.rows.map(row => row.invitee).sort(), ['amy', 'ben', 'cal', 'dan', 'zoe'], 'the burst alone is medium');
    assert.equal(suspicious.summary.suspicious >= 5, true);
    assert.deepEqual((await referrals.listReferrals({ query: '192.0.2.77' })).rows.map(row => row.invitee), ['cal']);
    assert.deepEqual((await referrals.listReferrals({ query: 'amydevice' })).rows.map(row => row.invitee).sort(), ['amy', 'cal']);

    // The moments: the link opened, bound, the first reply, success; rewards still go out.
    const before = await limit('zoe');
    referrals.noteValidReply('zoe', at('192.0.2.11', 'zoedevice00000000001'));
    const done = await settled('zoe');
    assert.deepEqual(done.events.map(event => event.type), ['bound', 'reply', 'success']);
    assert.equal(done.events[0].ip, '198.51.100.7');
    assert.equal(await limit('zoe'), before + 300, 'marked, still paid');
    await makeUser('eve', 0);
    await referrals.claimReferral('eve', code, { source: 'link', context: at('192.0.2.10', 'zoedevice00000000001') });
    const eve = await link('eve');
    assert.deepEqual(eve.events.map(event => [event.type, event.ip]), [['visit', '192.0.2.10'], ['bound', '192.0.2.10']], 'the earlier link visit on this device');
    assert.equal((await referrals.listReferrals({ inviter: 'yan' })).rows.find(row => row.invitee === 'eve').flags.some(flag => flag.code === 'sibling-device'), true, 'zoe used that device');

    // 90 days on: raw addresses are gone, digests still compare.
    await trace.sweepTraces(Date.now() + 91 * DAY);
    const seen = await trace.readSeen('yan');
    assert.equal(seen[0].ip, undefined);
    assert.equal(typeof seen[0].ipHash, 'string');
});


test('tracing across the two sites: only digests go over, the inviter\'s site compares them', async t => {
    const trace = await import('../src/referral-trace.js');
    const { sharedDigest } = await import('../src/referral-peer.js');
    const at = (address, device) => ({ ...trace.describeIp(address), device, ua: 'Mozilla/5.0 Firefox/140' });
    const told = [];
    setPeerTransport(async (path, payload) => {
        told.push({ path, payload });
        if (path === '/lookup') return { ok: true, site: 'modern', inviter: 'zed', inviterName: 'Zed' };
        if (path === '/sync') {
            const flags = payload.status === 'success' ? [{ code: 'same-ip', level: 'medium', text: '和邀请人用过同一个 IP（跨站）' }] : [];
            return { ok: true, inviterRewardMiB: payload.status === 'success' ? 150 : 0, flags };
        }
        return { ok: true, site: 'modern', enabled: true, crossSite: true, registrationOpen: true };
    });
    await referrals.setReferralConfig({ crossSite: true });
    t.after(async () => {
        setPeerTransport(null);
        await referrals.setReferralConfig({ crossSite: false });
    });

    // This site has the new account: what goes over, and what comes back.
    await makeUser('fay', 0);
    await referrals.claimReferral('fay', 'ZEDZED22', { source: 'link', context: at('203.0.113.9', 'faydevice00000000001') });
    referrals.noteValidReply('fay', at('203.0.113.9', 'faydevice00000000001'));
    await until(async () => (await link('fay'))?.remoteFlags?.length === 1, 'the flags from over there');
    const sync = told.filter(call => call.path === '/sync').at(-1).payload;
    assert.equal(sync.evidence.ips.length, 1);
    assert.equal(sync.evidence.ips[0], sharedDigest('ip', '203.0.113.9'));
    assert.equal(JSON.stringify(sync.evidence).includes('203.0.113.9'), false, 'no raw address among the digests');
    assert.equal(sync.events.some(event => event.net === '203.0.113.x'), true, 'the moments, for the admins over there');
    assert.equal(JSON.stringify(sync.events).includes('203.0.113.9'), false, 'raw addresses stay on this site');
    assert.equal(sync.events.some(event => 'ipHash' in event || 'ua' in event), false, 'so do digests and browsers');
    assert.equal((await referrals.listReferrals({ query: 'fay' })).rows[0].flags.some(flag => flag.code === 'same-ip'), true);

    // This site has the inviter: the other site's digests against the inviter's own addresses.
    await referrals.noteParticipant('yan', at('203.0.113.50', 'yandevice00000000002'), { force: true });
    const answer = await referrals.applyPeerSync({
        inviteeSite: 'modern', invitee: 'gus', inviteeName: 'Gus', inviter: 'yan', code: 'ABCD2345', status: 'pending', boundAt: Date.now(),
        evidence: { devices: [], ips: [sharedDigest('ip', '203.0.113.50')], nets: [] },
        flags: [{ code: 'new-discord', level: 'medium', text: '绑定时 Discord 号才注册 3 天' }],
        events: [{ type: 'bound', at: Date.now(), ip: '192.0.2.1', net: '192.0.2.x', ipHash: 'theirs' }],
    });
    assert.deepEqual(answer.flags.map(flag => flag.code), ['same-ip']);
    const mirror = await link('@modern:gus');
    assert.deepEqual(mirror.flags.map(flag => flag.code), ['same-ip', 'new-discord']);
    assert.deepEqual(mirror.events.map(event => [event.type, event.net, 'ip' in event, 'ipHash' in event]), [['bound', '192.0.2.x', false, false]]);
});

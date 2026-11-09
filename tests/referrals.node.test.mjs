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
    assert.deepEqual(mine.targets.map(item => [item.site, item.label, item.url, item.friendRewardMiB]), [['modern', '新站', 'http://peer.invalid', 150]]);

    // This site as the inviter's: the other site asks about frank's code, then tells about quin.
    assert.deepEqual(await referrals.answerPeerLookup({ code: frankCode }), { ok: true, site: 'legacy', inviter: 'frank', inviterName: 'frank' });
    await storage.setItem('user:frank', { ...await storage.getItem('user:frank'), oauthIdentities: { discord: '123456789012345678' } });
    assert.equal((await referrals.answerPeerLookup({ code: frankCode, identity: identityKey('123456789012345678') })).reason, '不能邀请自己在另一个站的账号');
    const frankBefore = await limit('frank');
    assert.deepEqual(await referrals.applyPeerSync({ inviteeSite: 'modern', invitee: 'quin', inviteeName: 'Quin', inviter: 'frank', code: frankCode, status: 'pending', boundAt: Date.now() }),
        { ok: true, inviterRewardMiB: 0, status: 'pending' });
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import storage from 'node-persist';

import {
    ADMIN_INVITATION_SOURCE,
    calculateUserInvitationQuota,
    DEFAULT_USER_INVITATION_CONFIG,
    getInvitationSource,
    mergeUserInvitationConfig,
    USER_INVITATION_SOURCE,
} from '../src/user-invitation-policy.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-user-invitations-'));
global.DATA_ROOT = testRoot;

let invitationCodes;
let userInvitations;
let systemMonitor;

async function clearStorage() {
    const keys = await storage.keys();
    await Promise.all(keys.map(key => storage.removeItem(key)));
}

before(async () => {
    await storage.init({
        dir: path.join(testRoot, '_storage'),
        ttl: false,
        expiredInterval: 0,
    });
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.resolve('config.yaml'));
    invitationCodes = await import('../src/invitation-codes.js');
    userInvitations = await import('../src/user-invitations.js');
    systemMonitor = (await import('../src/system-monitor.js')).default;
    await import('../src/endpoints/user-invitations.js');
    await import('../src/endpoints/system-load.js');
});

beforeEach(async () => {
    await clearStorage();
    systemMonitor.clearAllStats();
});

after(async () => {
    systemMonitor.destroy();
    if (typeof storage.stop === 'function') {
        storage.stop();
    }
    process.once('exit', () => fs.rmSync(testRoot, { recursive: true, force: true }));
});

test('configuration uses an allow-list and finite integer bounds', () => {
    const config = mergeUserInvitationConfig(DEFAULT_USER_INVITATION_CONFIG, {
        enabled: false,
        minRegisteredDays: 12.9,
        quotaPerPeriod: '3',
        periodDays: 'Infinity',
        maxTotalCodes: -50,
        injected: 'must-not-persist',
    });

    assert.deepEqual(config, {
        enabled: false,
        minRegisteredDays: 12,
        minOnlineHours: 72,
        quotaPerPeriod: 3,
        periodDays: 1,
        maxTotalCodes: 1,
    });
    assert.equal(Object.hasOwn(config, 'injected'), false);
});

test('quota requires consumption and returns a rolling-window countdown', () => {
    const now = 2_000_000_000_000;
    const createdAt = now - 60_000;
    const config = { ...DEFAULT_USER_INVITATION_CONFIG, periodDays: 1, quotaPerPeriod: 1 };

    const unused = calculateUserInvitationQuota([{ createdAt, used: false }], 1, config, now);
    assert.equal(unused.canIssue, false);
    assert.equal(unused.nextIssueAt, null);
    assert.match(unused.reason, /未使用/);

    const used = calculateUserInvitationQuota([{ createdAt, used: true }], 1, config, now);
    assert.equal(used.canIssue, false);
    assert.equal(used.nextIssueAt, createdAt + 86_400_000);

    const expired = calculateUserInvitationQuota(
        [{ createdAt: now - 86_400_001, used: true }],
        1,
        config,
        now,
    );
    assert.equal(expired.canIssue, true);
});

test('reserved namespace values survive scans and sources stay independent', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    await storage.setItem('invitation:user-system-config', { enabled: false });
    const adminCode = await invitationCodes.createInvitationCode('admin', 'permanent');
    const userCode = await invitationCodes.createInvitationCode('alice', 'permanent', {
        issuanceSource: USER_INVITATION_SOURCE,
    });

    assert.equal((await invitationCodes.getAllInvitationCodes()).length, 2);
    assert.deepEqual(await storage.getItem('invitation:user-system-config'), { enabled: false });
    assert.equal((await invitationCodes.getInvitationCodesBySource(ADMIN_INVITATION_SOURCE)).length, 1);
    assert.equal((await invitationCodes.getInvitationCodesBySource(USER_INVITATION_SOURCE)).length, 1);
    assert.equal(getInvitationSource(adminCode), ADMIN_INVITATION_SOURCE);
    assert.equal(getInvitationSource(userCode), USER_INVITATION_SOURCE);

    assert.equal(await invitationCodes.deleteInvitationCode(userCode.code, {
        issuanceSource: ADMIN_INVITATION_SOURCE,
    }), false);
    assert.equal((await invitationCodes.getAllInvitationCodes()).length, 2);
});

test('legacy configuration migrates without being deleted by invitation scans', async () => {
    await storage.setItem('invitation:user-system-config', {
        enabled: false,
        minRegisteredDays: 45,
    });

    const config = await userInvitations.getUserInvitationConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.minRegisteredDays, 45);
    assert.equal(await storage.getItem('invitation:user-system-config'), undefined);
    await invitationCodes.getAllInvitationCodes();
    assert.equal((await userInvitations.getUserInvitationConfig()).enabled, false);
});

test('legacy non-admin records migrate into the user system', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    await storage.setItem('user:alice', {
        handle: 'alice',
        admin: false,
        created: Date.now() - 40 * 86_400_000,
    });
    const invitation = await invitationCodes.createInvitationCode('alice', 'permanent');
    delete invitation.issuanceSource;
    await storage.setItem(`invitation:${invitation.code}`, invitation);

    await userInvitations.initializeUserInvitationSystem();
    const migrated = await storage.getItem(`invitation:${invitation.code}`);
    assert.equal(migrated.issuanceSource, USER_INVITATION_SOURCE);
    assert.equal((await userInvitations.getUserIssuedInvitations('alice')).length, 1);
});

test('used user invitations cannot be deleted from the audit trail', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    const invitation = await invitationCodes.createInvitationCode('alice', 'permanent', {
        issuanceSource: USER_INVITATION_SOURCE,
    });
    assert.equal((await invitationCodes.useInvitationCode(invitation.code, 'bob')).success, true);

    const result = await userInvitations.deleteUserInvitation(invitation.code);
    assert.equal(result.deleted, false);
    assert.match(result.reason, /已使用/);
    assert.equal((await userInvitations.getUserInvitationAdminData()).summary.totalUsed, 1);
});

test('global issuance lock enforces the user-system maximum across users', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    const created = Date.now() - 40 * 86_400_000;
    await storage.setItem('user:alice', { handle: 'alice', admin: false, created });
    await storage.setItem('user:bob', { handle: 'bob', admin: false, created });
    await userInvitations.setUserInvitationConfig({
        enabled: true,
        minRegisteredDays: 0,
        minOnlineHours: 0,
        quotaPerPeriod: 1,
        periodDays: 1,
        maxTotalCodes: 1,
    });
    await invitationCodes.createInvitationCode('admin', 'permanent');

    const results = await Promise.all([
        userInvitations.issueUserInvitation('alice'),
        userInvitations.issueUserInvitation('bob'),
    ]);
    assert.equal(results.filter(result => result.success).length, 1);
    assert.equal(results.filter(result => !result.success).length, 1);

    const adminData = await userInvitations.getUserInvitationAdminData();
    assert.equal(adminData.summary.totalIssued, 1);
    assert.equal(adminData.summary.totalIssuers, 1);
    assert.equal((await invitationCodes.getInvitationCodesBySource(ADMIN_INVITATION_SOURCE)).length, 1);
});

test('paused user issuance also blocks administrator accounts', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    await storage.setItem('user:admin', {
        handle: 'admin',
        admin: true,
        created: Date.now() - 365 * 86_400_000,
    });
    await userInvitations.setUserInvitationConfig({
        enabled: false,
        minRegisteredDays: 0,
        minOnlineHours: 0,
    });

    const result = await userInvitations.issueUserInvitation('admin');
    assert.equal(result.success, false);
    assert.match(result.reason, /暂未开放/);
    assert.equal((await userInvitations.getUserInvitationConfig()).enabled, false);
});

test('user panel data exposes issuance state but not hidden eligibility rules', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    await storage.setItem('user:alice', {
        handle: 'alice',
        admin: false,
        created: Date.now() - 40 * 86_400_000,
    });
    await userInvitations.setUserInvitationConfig({
        enabled: true,
        minRegisteredDays: 0,
        minOnlineHours: 0,
    });

    const data = await userInvitations.getMyInvitationData('alice');
    assert.equal(data.eligible, true);
    assert.equal(data.issuance.canIssue, true);
    assert.equal(Object.hasOwn(data, 'config'), false);
    assert.equal(Object.hasOwn(data, 'metrics'), false);
    assert.equal(Object.hasOwn(data, 'reasons'), false);
});

test('resetting monitor statistics preserves invitation eligibility duration', async t => {
    if (!invitationCodes.isInvitationCodesEnabled()) {
        return t.skip('enableInvitationCodes is disabled in this test configuration');
    }

    await storage.setItem('user:alice', {
        handle: 'alice',
        admin: false,
        created: Date.now() - 40 * 86_400_000,
    });
    await userInvitations.setUserInvitationConfig({
        enabled: true,
        minRegisteredDays: 0,
        minOnlineHours: 72,
    });
    systemMonitor.recordUserLogin('alice');
    const stats = systemMonitor.userLoadStats.get('alice');
    stats.onlineDuration = 72 * 3_600_000;
    stats.isOnline = false;
    stats.currentSessionStart = null;

    assert.equal((await userInvitations.isUserEligible('alice')).eligible, true);
    await userInvitations.resetUserStatsPreservingInvitationDuration('alice');
    assert.equal(systemMonitor.getUserLoadStats('alice'), null);
    assert.equal((await userInvitations.isUserEligible('alice')).eligible, true);
});

import express from 'express';
import storage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { getIpFromRequest, getRealIpFromHeader } from '../express-common.js';
import { getConfigValue } from '../util.js';
import { ensureUserDirectoriesExist, makeUserAccountPermanent, normalizeHandle, requireAdminMiddleware, toKey } from '../users.js';
import { getStcontrolControllerUrl, isStcontrolEnabled } from '../stcontrol.js';
import systemMonitor from '../system-monitor.js';
import { getPasskeySettings, getPasskeyStats, getRecentPasskeyLogins, recordPasskeyEvent, recordPasskeyLogin, savePasskeySettings } from '../passkey-settings.js';

/**
 * Passkeys (WebAuthn): a second way into an existing account, so people who
 * signed up with Discord can sign in without it. They are added from the
 * account settings (up to the administrator's limit) and kept on the user record.
 *
 * Login is username-less: the passkey carries the account handle as its user
 * ID, and the assertion is checked against the public key stored on that
 * account for that credential, so a forged user ID only ever names an account
 * whose keys the forger does not have.
 *
 * Switched on and tuned from the admin panel (see passkey-settings.js); always
 * off on a node whose sign-in is handled by the stcontrol Controller.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_NAME_LENGTH = 40;
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');

// Known authenticators, to name a new passkey after where it lives.
export const AUTHENTICATOR_NAMES = Object.freeze({
    'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 密码管理器',
    'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 钥匙串',
    'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 钥匙串',
    '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
    '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
    '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
    'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome（Mac）',
    'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
    'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
    '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
    '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
    'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
    '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
    'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
    'b5397666-4885-aa6b-cebf-e52262a439a2': 'Chromium 浏览器',
    '771b48fd-d3d4-4f74-9232-fc157ab0507a': 'Edge（Mac）',
});

const loginLimiter = new RateLimiterMemory({ points: 20, duration: 60 });

/** Serializes changes to one user's passkeys. */
const userLocks = new Map();
async function withUserLock(handle, task) {
    const previous = userLocks.get(handle) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    userLocks.set(handle, tail);
    try {
        return await run;
    } finally {
        if (userLocks.get(handle) === tail) userLocks.delete(handle);
    }
}

/** @returns {Promise<typeof import('@simplewebauthn/server')>} */
function loadWebAuthn() {
    return import('@simplewebauthn/server');
}

/**
 * @param {import('express').Request} request Request
 * @returns {{available: boolean, enabled: boolean, rpId: string, rpName: string, origins: string[], settings: ReturnType<typeof getPasskeySettings>}}
 */
export function getPasskeyConfig(request) {
    const settings = getPasskeySettings();
    const available = getConfigValue('enableUserAccounts', false, 'boolean') && !isStcontrolEnabled();
    const configuredOrigins = getConfigValue('passkeys.origins', []);
    const origins = Array.isArray(configuredOrigins) && configuredOrigins.length
        ? configuredOrigins.map(String)
        : [`${request.protocol}://${request.get('host')}`];
    return {
        available,
        enabled: available && settings.enabled,
        rpId: String(getConfigValue('passkeys.rpId', '') || request.hostname),
        rpName: settings.rpName || 'SillyTavern',
        origins,
        settings,
    };
}

function getIpAddress(request) {
    return PREFER_REAL_IP_HEADER ? getRealIpFromHeader(request) : getIpFromRequest(request);
}

function toBase64Url(bytes) {
    return Buffer.from(bytes).toString('base64url');
}

/**
 * One pending ceremony per browser session, kept in the signed session cookie
 * so it survives a hot reload. Taking it clears it: each challenge is used once.
 */
function rememberChallenge(request, kind, challenge, handle = null) {
    request.session.passkeyChallenge = { kind, challenge, handle, expiresAt: Date.now() + CHALLENGE_TTL_MS };
}

function takeChallenge(request, kind, handle = null) {
    const pending = request.session?.passkeyChallenge;
    if (request.session) delete request.session.passkeyChallenge;
    if (!pending || pending.kind !== kind || typeof pending.challenge !== 'string' || !(pending.expiresAt > Date.now())) {
        return null;
    }
    if (kind === 'register' && pending.handle !== handle) {
        return null;
    }
    return pending.challenge;
}

/** @returns {object[]} The user's passkeys, valid entries only */
function getPasskeys(user) {
    return Array.isArray(user?.passkeys)
        ? user.passkeys.filter(passkey => passkey && typeof passkey.id === 'string' && typeof passkey.publicKey === 'string')
        : [];
}

function describePasskey(passkey) {
    return {
        id: passkey.id,
        name: passkey.name || '通行密钥',
        createdAt: passkey.createdAt ?? null,
        lastUsedAt: passkey.lastUsedAt ?? null,
        synced: passkey.deviceType === 'multiDevice',
    };
}

function cleanName(name) {
    return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

function sendDisabled(response) {
    return response.status(404).json({ error: '通行密钥未开启', code: 'passkeys_disabled' });
}

function limitMessage(max) {
    return `最多只能添加 ${max} 个通行密钥，请先删除不用的`;
}

/**
 * Applies a change to one user's passkeys under that user's lock.
 * @param {string} handle User handle
 * @param {(passkeys: object[]) => object[]|null} change New list, or null when nothing applies
 * @returns {Promise<object[]|null>} The new list, or null when the user or passkey was not found
 */
async function changePasskeys(handle, change) {
    return withUserLock(handle, async () => {
        const user = await storage.getItem(toKey(handle));
        if (!user) return null;
        const next = change(getPasskeys(user));
        if (!next) return null;
        user.passkeys = next;
        await storage.setItem(toKey(handle), user);
        return next;
    });
}

// ---------------------------------------------------------------- Controller-managed nodes

const CONTROLLER_PASSKEYS_TTL_MS = 60_000;
const CONTROLLER_PASSKEYS_RETRY_MS = 15_000;
/** @type {{until: number, value: {enabled: boolean, url: string}|null, pending: Promise<{enabled: boolean, url: string}|null>|null}} */
let controllerPasskeys = { until: 0, value: null, pending: null };

/**
 * On a node managed by the stcontrol Controller, sign-in and therefore passkeys
 * belong to the Controller. Reports whether it has them switched on and where
 * users manage them; cached briefly so pages never wait on the Controller.
 * @returns {Promise<{enabled: boolean, url: string}|null>}
 */
export async function getControllerPasskeys() {
    const base = getStcontrolControllerUrl();
    if (!base) return null;
    if (Date.now() < controllerPasskeys.until) return controllerPasskeys.value;
    controllerPasskeys.pending ??= (async () => {
        const url = `${base}/account#passkeys`;
        try {
            const response = await fetch(`${base}/api/auth/passkey/config`, { signal: AbortSignal.timeout(3000) });
            const data = response.ok ? await response.json() : null;
            const value = { enabled: Boolean(data?.enabled), url };
            controllerPasskeys = { until: Date.now() + CONTROLLER_PASSKEYS_TTL_MS, value, pending: null };
            return value;
        } catch {
            const value = { enabled: false, url };
            controllerPasskeys = { until: Date.now() + CONTROLLER_PASSKEYS_RETRY_MS, value, pending: null };
            return value;
        }
    })();
    return controllerPasskeys.pending;
}

/** Forgets the Controller's passkey state (tests, configuration reloads). */
export function clearControllerPasskeysCache() {
    controllerPasskeys = { until: 0, value: null, pending: null };
}

// ---------------------------------------------------------------- sign-in (public)

export const publicRouter = express.Router();

publicRouter.get('/config', async (request, response) => {
    const config = getPasskeyConfig(request);
    if (!config.enabled) {
        const managedBy = isStcontrolEnabled() ? await getControllerPasskeys() : null;
        return response.json(managedBy?.enabled
            ? { enabled: false, rpId: null, managedBy }
            : { enabled: false, rpId: null });
    }
    const { settings } = config;
    return response.json({
        enabled: true,
        rpId: config.rpId,
        max: settings.maxPerUser,
        allowRegistration: settings.allowRegistration,
        showOnLoginPage: settings.showOnLoginPage,
        showInSettings: settings.showInSettings,
        loginPrompt: settings.loginPrompt,
        loginButtonText: settings.loginButtonText,
        loginHintText: settings.loginHintText,
        managerDescription: settings.managerDescription,
    });
});

publicRouter.post('/login/options', async (request, response) => {
    const config = getPasskeyConfig(request);
    if (!config.enabled) return sendDisabled(response);
    try {
        await loginLimiter.consume(getIpAddress(request));
        const { generateAuthenticationOptions } = await loadWebAuthn();
        const options = await generateAuthenticationOptions({
            rpID: config.rpId,
            userVerification: config.settings.userVerification,
            timeout: 120_000,
        });
        rememberChallenge(request, 'login', options.challenge);
        return response.json(options);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return response.status(429).json({ error: '尝试次数过多，请稍后再试', code: 'rate_limited' });
        }
        console.error('Passkey login options failed:', error);
        return response.status(500).json({ error: '通行密钥暂时不可用，请稍后再试' });
    }
});

publicRouter.post('/login/verify', async (request, response) => {
    const config = getPasskeyConfig(request);
    if (!config.enabled) return sendDisabled(response);
    const ip = getIpAddress(request);
    try {
        await loginLimiter.consume(ip);
        const credential = request.body?.response;
        const expectedChallenge = takeChallenge(request, 'login');
        if (!expectedChallenge) {
            return response.status(400).json({ error: '验证已过期，请再试一次', code: 'challenge_expired' });
        }
        if (!credential || typeof credential.id !== 'string' || typeof credential.response?.userHandle !== 'string') {
            return response.status(400).json({ error: '通行密钥数据无效，请再试一次', code: 'invalid_response' });
        }

        const handle = normalizeHandle(Buffer.from(credential.response.userHandle, 'base64url').toString('utf8'));
        const user = handle ? await storage.getItem(toKey(handle)) : null;
        const passkey = getPasskeys(user).find(item => item.id === credential.id);
        if (!user || !passkey) {
            recordPasskeyEvent('failures');
            // Only name an account that exists; the handle here is whatever the request claimed.
            recordPasskeyLogin({ ok: false, reason: 'unknown_credential', handle: user?.handle, name: user?.name });
            return response.status(404).json({
                error: '这个通行密钥已不能使用（可能已在账号中删除）。请用其他方式登录后重新添加。',
                code: 'unknown_credential',
                credentialId: credential.id,
                rpId: config.rpId,
            });
        }
        if (!user.enabled) {
            return response.status(403).json({ error: '该账号已被禁用', code: 'user_disabled' });
        }

        const { verifyAuthenticationResponse } = await loadWebAuthn();
        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: credential,
                expectedChallenge,
                expectedOrigin: config.origins,
                expectedRPID: config.rpId,
                credential: {
                    id: passkey.id,
                    publicKey: Buffer.from(passkey.publicKey, 'base64url'),
                    counter: Number(passkey.counter) || 0,
                    transports: Array.isArray(passkey.transports) ? passkey.transports : undefined,
                },
                requireUserVerification: config.settings.userVerification === 'required',
            });
        } catch (error) {
            console.warn('Passkey login rejected for', handle, '-', error.message);
            verification = null;
        }
        if (!verification?.verified) {
            recordPasskeyEvent('failures');
            recordPasskeyLogin({ ok: false, reason: 'verification_failed', handle: user.handle, name: user.name, passkeyName: passkey.name });
            const message = config.settings.userVerification === 'required'
                ? '通行密钥验证失败：本站要求验证指纹、面容或锁屏密码，请再试一次'
                : '通行密钥验证失败，请再试一次';
            return response.status(403).json({ error: message, code: 'verification_failed' });
        }

        await changePasskeys(handle, passkeys => {
            const stored = passkeys.find(item => item.id === passkey.id);
            if (!stored) return null;
            stored.counter = verification.authenticationInfo.newCounter;
            stored.lastUsedAt = Date.now();
            stored.backedUp = verification.authenticationInfo.credentialBackedUp;
            return passkeys;
        });

        // The same steps as a password login once the user is known.
        await makeUserAccountPermanent(user);
        await ensureUserDirectoriesExist(user.handle);
        if (!request.session) {
            return response.status(500).json({ error: 'Session not available' });
        }
        await loginLimiter.delete(ip);
        request.session.handle = user.handle;
        request.session.userId = user.id || user.handle;
        request.session.authenticated = true;
        systemMonitor.recordUserLogin(user.handle, { userName: user.name });
        systemMonitor.updateUserActivity(user.handle, { userName: user.name, isHeartbeat: false });
        recordPasskeyEvent('logins');
        recordPasskeyLogin({ ok: true, handle: user.handle, name: user.name, passkeyName: passkey.name });
        console.info('Passkey login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return response.status(429).json({ error: '尝试次数过多，请稍后再试', code: 'rate_limited' });
        }
        console.error('Passkey login failed:', error);
        return response.status(500).json({ error: '登录失败，请稍后再试' });
    }
});

// ---------------------------------------------------------------- administration

export const adminRouter = express.Router();
adminRouter.use(requireAdminMiddleware);

/**
 * Users who have passkeys, with theirs, newest activity first.
 * @returns {Promise<object[]>}
 */
async function listPasskeyUsers() {
    const values = await storage.values();
    const users = [];
    for (const user of values) {
        if (!user || typeof user !== 'object' || typeof user.handle !== 'string') continue;
        const passkeys = getPasskeys(user);
        if (!passkeys.length) continue;
        const described = passkeys.map(passkey => ({
            ...describePasskey(passkey),
            provider: AUTHENTICATOR_NAMES[passkey.aaguid] || null,
        }));
        users.push({
            handle: user.handle,
            name: user.name || user.handle,
            enabled: user.enabled !== false,
            admin: Boolean(user.admin),
            passkeys: described,
            lastUsedAt: Math.max(0, ...described.map(passkey => passkey.lastUsedAt || 0)) || null,
            firstAddedAt: Math.min(...described.map(passkey => passkey.createdAt || Date.now())),
        });
    }
    users.sort((a, b) => (b.lastUsedAt || b.firstAddedAt || 0) - (a.lastUsedAt || a.firstAddedAt || 0));
    return users;
}

adminRouter.get('/overview', async (request, response) => {
    try {
        const config = getPasskeyConfig(request);
        const users = await listPasskeyUsers();
        const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const all = users.flatMap(user => user.passkeys);
        const providers = {};
        for (const passkey of all) {
            const provider = passkey.provider || '其他 / 未识别';
            providers[provider] = (providers[provider] || 0) + 1;
        }
        return response.json({
            settings: config.settings,
            status: {
                available: config.available,
                enabled: config.enabled,
                stcontrol: isStcontrolEnabled(),
                accounts: getConfigValue('enableUserAccounts', false, 'boolean'),
                rpId: config.rpId,
                origins: config.origins,
                originsFromConfig: Array.isArray(getConfigValue('passkeys.origins', [])) && getConfigValue('passkeys.origins', []).length > 0,
                rpIdFromConfig: Boolean(getConfigValue('passkeys.rpId', '')),
            },
            summary: {
                users: users.length,
                passkeys: all.length,
                activeUsers7d: users.filter(user => (user.lastUsedAt || 0) >= week).length,
                added7d: all.filter(passkey => (passkey.createdAt || 0) >= week).length,
                synced: all.filter(passkey => passkey.synced).length,
                providers: Object.entries(providers).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
            },
            stats: getPasskeyStats(7),
            recentLogins: getRecentPasskeyLogins(),
            users,
        });
    } catch (error) {
        console.error('Passkey overview failed:', error);
        return response.status(500).json({ error: '读取失败，请稍后再试' });
    }
});

adminRouter.post('/settings', (request, response) => {
    try {
        const settings = savePasskeySettings(request.body?.settings);
        console.info('Passkey settings saved by', request.user?.profile?.handle, JSON.stringify(settings));
        return response.json({ settings });
    } catch (error) {
        console.error('Saving passkey settings failed:', error);
        return response.status(500).json({ error: '保存失败，请稍后再试' });
    }
});

adminRouter.post('/delete', async (request, response) => {
    const handle = normalizeHandle(String(request.body?.handle ?? ''));
    const id = String(request.body?.id ?? '');
    const all = request.body?.all === true;
    if (!handle || (!all && !id)) {
        return response.status(400).json({ error: '参数不完整', code: 'invalid_request' });
    }
    try {
        const result = await changePasskeys(handle, passkeys => {
            if (all) return passkeys.length ? [] : null;
            const next = passkeys.filter(passkey => passkey.id !== id);
            return next.length === passkeys.length ? null : next;
        });
        if (!result) {
            return response.status(404).json({ error: '找不到这个通行密钥，请刷新后再试', code: 'not_found' });
        }
        console.info('Admin', request.user?.profile?.handle, all ? 'removed all passkeys of' : 'removed a passkey of', handle);
        return response.json({ passkeys: result.map(describePasskey) });
    } catch (error) {
        console.error('Admin passkey delete failed:', error);
        return response.status(500).json({ error: '删除失败，请稍后再试' });
    }
});

// ---------------------------------------------------------------- management (signed in)

export const router = express.Router();

router.use((request, response, next) => {
    if (!getPasskeyConfig(request).enabled) return sendDisabled(response);
    if (!request.user?.profile?.handle) return response.sendStatus(403);
    return next();
});

router.get('/list', async (request, response) => {
    const { settings } = getPasskeyConfig(request);
    const user = await storage.getItem(toKey(request.user.profile.handle));
    return response.json({ passkeys: getPasskeys(user).map(describePasskey), max: settings.maxPerUser, allowRegistration: settings.allowRegistration });
});

router.post('/register/options', async (request, response) => {
    const config = getPasskeyConfig(request);
    const { settings } = config;
    const handle = request.user.profile.handle;
    if (!settings.allowRegistration) {
        return response.status(403).json({ error: '管理员暂时关闭了添加通行密钥，已添加的仍可登录', code: 'registration_disabled' });
    }
    try {
        const user = await storage.getItem(toKey(handle));
        if (!user) return response.sendStatus(404);
        const passkeys = getPasskeys(user);
        if (passkeys.length >= settings.maxPerUser) {
            return response.status(409).json({ error: limitMessage(settings.maxPerUser), code: 'limit_reached' });
        }
        const userId = Buffer.from(handle, 'utf8');
        if (userId.length > 64) {
            return response.status(400).json({ error: '这个账号的用户名太长，无法添加通行密钥', code: 'handle_too_long' });
        }
        const { generateRegistrationOptions } = await loadWebAuthn();
        const displayName = String(user.name || handle).slice(0, 64);
        const options = await generateRegistrationOptions({
            rpName: config.rpName,
            rpID: config.rpId,
            userID: userId,
            userName: displayName,
            userDisplayName: displayName,
            attestationType: 'none',
            excludeCredentials: passkeys.map(passkey => ({ id: passkey.id, transports: passkey.transports })),
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: settings.userVerification },
            timeout: 120_000,
        });
        rememberChallenge(request, 'register', options.challenge, handle);
        return response.json(options);
    } catch (error) {
        console.error('Passkey registration options failed:', error);
        return response.status(500).json({ error: '通行密钥暂时不可用，请稍后再试' });
    }
});

router.post('/register/verify', async (request, response) => {
    const config = getPasskeyConfig(request);
    const { settings } = config;
    const handle = request.user.profile.handle;
    try {
        const expectedChallenge = takeChallenge(request, 'register', handle);
        if (!expectedChallenge) {
            return response.status(400).json({ error: '操作已过期，请重新添加', code: 'challenge_expired' });
        }
        if (!settings.allowRegistration) {
            return response.status(403).json({ error: '管理员暂时关闭了添加通行密钥，已添加的仍可登录', code: 'registration_disabled' });
        }
        const credential = request.body?.response;
        if (!credential || typeof credential.id !== 'string') {
            return response.status(400).json({ error: '通行密钥数据无效，请重新添加', code: 'invalid_response' });
        }
        const { verifyRegistrationResponse } = await loadWebAuthn();
        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: credential,
                expectedChallenge,
                expectedOrigin: config.origins,
                expectedRPID: config.rpId,
                requireUserVerification: settings.userVerification === 'required',
            });
        } catch (error) {
            console.warn('Passkey registration rejected for', handle, '-', error.message);
            verification = null;
        }
        if (!verification?.verified) {
            const message = settings.userVerification === 'required'
                ? '添加失败：本站要求验证指纹、面容或锁屏密码，请重新添加'
                : '通行密钥验证失败，请重新添加';
            return response.status(400).json({ error: message, code: 'verification_failed' });
        }

        const info = verification.registrationInfo;
        const name = cleanName(AUTHENTICATOR_NAMES[info.aaguid] || request.body?.name) || '通行密钥';
        let refusal = null;
        let added = null;
        const result = await changePasskeys(handle, passkeys => {
            if (passkeys.some(passkey => passkey.id === info.credential.id)) {
                refusal = { status: 409, body: { error: '这个通行密钥已经添加过了', code: 'already_added' } };
                return null;
            }
            if (passkeys.length >= settings.maxPerUser) {
                refusal = { status: 409, body: { error: limitMessage(settings.maxPerUser), code: 'limit_reached' } };
                return null;
            }
            added = {
                id: info.credential.id,
                publicKey: toBase64Url(info.credential.publicKey),
                counter: info.credential.counter,
                transports: Array.isArray(info.credential.transports) ? info.credential.transports : [],
                deviceType: info.credentialDeviceType,
                backedUp: info.credentialBackedUp,
                aaguid: info.aaguid,
                name,
                createdAt: Date.now(),
                lastUsedAt: null,
            };
            return [...passkeys, added];
        });
        if (refusal) {
            return response.status(refusal.status).json(refusal.body);
        }
        if (!result || !added) {
            return response.sendStatus(404);
        }
        recordPasskeyEvent('registrations');
        console.info('Passkey added for', handle, `(${result.length}/${settings.maxPerUser})`);
        return response.json({ passkey: describePasskey(added), count: result.length, max: settings.maxPerUser });
    } catch (error) {
        console.error('Passkey registration failed:', error);
        return response.status(500).json({ error: '添加失败，请稍后再试' });
    }
});

router.post('/rename', async (request, response) => {
    const name = cleanName(request.body?.name);
    const id = String(request.body?.id ?? '');
    if (!name) {
        return response.status(400).json({ error: '名称不能为空', code: 'invalid_name' });
    }
    try {
        const result = await changePasskeys(request.user.profile.handle, passkeys => {
            const index = passkeys.findIndex(passkey => passkey.id === id);
            if (index < 0) return null;
            passkeys[index] = { ...passkeys[index], name };
            return passkeys;
        });
        if (!result) {
            return response.status(404).json({ error: '找不到这个通行密钥，请刷新后再试', code: 'not_found' });
        }
        return response.json({ passkeys: result.map(describePasskey), max: getPasskeySettings().maxPerUser });
    } catch (error) {
        console.error('Passkey rename failed:', error);
        return response.status(500).json({ error: '保存失败，请稍后再试' });
    }
});

router.post('/delete', async (request, response) => {
    const id = String(request.body?.id ?? '');
    try {
        const result = await changePasskeys(request.user.profile.handle, passkeys => {
            const next = passkeys.filter(passkey => passkey.id !== id);
            return next.length === passkeys.length ? null : next;
        });
        if (!result) {
            return response.status(404).json({ error: '找不到这个通行密钥，请刷新后再试', code: 'not_found' });
        }
        return response.json({ passkeys: result.map(describePasskey), max: getPasskeySettings().maxPerUser });
    } catch (error) {
        console.error('Passkey delete failed:', error);
        return response.status(500).json({ error: '删除失败，请稍后再试' });
    }
});

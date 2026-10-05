import express from 'express';
import storage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { getIpFromRequest, getRealIpFromHeader } from '../express-common.js';
import { getConfigValue } from '../util.js';
import { ensureUserDirectoriesExist, makeUserAccountPermanent, normalizeHandle, toKey } from '../users.js';
import { isStcontrolEnabled } from '../stcontrol.js';
import systemMonitor from '../system-monitor.js';

/**
 * Passkeys (WebAuthn): a second way into an existing account, so people who
 * signed up with Discord can sign in without it. They are added from the
 * account settings (up to MAX_PASSKEYS) and kept on the user record.
 *
 * Login is username-less: the passkey carries the account handle as its user
 * ID, and the assertion is checked against the public key stored on that
 * account for that credential, so a forged user ID only ever names an account
 * whose keys the forger does not have.
 *
 * Off unless `passkeys.enabled` is set, and always off on a node whose sign-in
 * is handled by the stcontrol Controller.
 */

export const MAX_PASSKEYS = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_NAME_LENGTH = 40;
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');

// Known authenticators, to name a new passkey after where it lives.
const AUTHENTICATOR_NAMES = {
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
};

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
 * @returns {{enabled: boolean, rpId: string, rpName: string, origins: string[]}}
 */
export function getPasskeyConfig(request) {
    const enabled = getConfigValue('passkeys.enabled', false, 'boolean')
        && getConfigValue('enableUserAccounts', false, 'boolean')
        && !isStcontrolEnabled();
    const configuredOrigins = getConfigValue('passkeys.origins', []);
    const origins = Array.isArray(configuredOrigins) && configuredOrigins.length
        ? configuredOrigins.map(String)
        : [`${request.protocol}://${request.get('host')}`];
    return {
        enabled,
        rpId: String(getConfigValue('passkeys.rpId', '') || request.hostname),
        rpName: String(getConfigValue('passkeys.rpName', '') || 'SillyTavern'),
        origins,
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

// ---------------------------------------------------------------- sign-in (public)

export const publicRouter = express.Router();

publicRouter.get('/config', (request, response) => {
    const config = getPasskeyConfig(request);
    return response.json({ enabled: config.enabled, rpId: config.enabled ? config.rpId : null, max: MAX_PASSKEYS });
});

publicRouter.post('/login/options', async (request, response) => {
    const config = getPasskeyConfig(request);
    if (!config.enabled) return sendDisabled(response);
    try {
        await loginLimiter.consume(getIpAddress(request));
        const { generateAuthenticationOptions } = await loadWebAuthn();
        const options = await generateAuthenticationOptions({
            rpID: config.rpId,
            userVerification: 'preferred',
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
                requireUserVerification: false,
            });
        } catch (error) {
            console.warn('Passkey login rejected for', handle, '-', error.message);
            return response.status(403).json({ error: '通行密钥验证失败，请再试一次', code: 'verification_failed' });
        }
        if (!verification.verified) {
            return response.status(403).json({ error: '通行密钥验证失败，请再试一次', code: 'verification_failed' });
        }

        await withUserLock(handle, async () => {
            const fresh = await storage.getItem(toKey(handle));
            const stored = getPasskeys(fresh).find(item => item.id === passkey.id);
            if (!fresh || !stored) return;
            stored.counter = verification.authenticationInfo.newCounter;
            stored.lastUsedAt = Date.now();
            stored.backedUp = verification.authenticationInfo.credentialBackedUp;
            await storage.setItem(toKey(handle), fresh);
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

// ---------------------------------------------------------------- management (signed in)

export const router = express.Router();

router.use((request, response, next) => {
    if (!getPasskeyConfig(request).enabled) return sendDisabled(response);
    if (!request.user?.profile?.handle) return response.sendStatus(403);
    return next();
});

router.get('/list', async (request, response) => {
    const user = await storage.getItem(toKey(request.user.profile.handle));
    return response.json({ passkeys: getPasskeys(user).map(describePasskey), max: MAX_PASSKEYS });
});

router.post('/register/options', async (request, response) => {
    const config = getPasskeyConfig(request);
    const handle = request.user.profile.handle;
    try {
        const user = await storage.getItem(toKey(handle));
        if (!user) return response.sendStatus(404);
        const passkeys = getPasskeys(user);
        if (passkeys.length >= MAX_PASSKEYS) {
            return response.status(409).json({ error: `最多只能添加 ${MAX_PASSKEYS} 个通行密钥，请先删除不用的`, code: 'limit_reached' });
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
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
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
    const handle = request.user.profile.handle;
    try {
        const expectedChallenge = takeChallenge(request, 'register', handle);
        if (!expectedChallenge) {
            return response.status(400).json({ error: '操作已过期，请重新添加', code: 'challenge_expired' });
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
                requireUserVerification: false,
            });
        } catch (error) {
            console.warn('Passkey registration rejected for', handle, '-', error.message);
            return response.status(400).json({ error: '通行密钥验证失败，请重新添加', code: 'verification_failed' });
        }
        if (!verification.verified) {
            return response.status(400).json({ error: '通行密钥验证失败，请重新添加', code: 'verification_failed' });
        }

        const info = verification.registrationInfo;
        const name = cleanName(AUTHENTICATOR_NAMES[info.aaguid] || request.body?.name) || '通行密钥';
        const result = await withUserLock(handle, async () => {
            const user = await storage.getItem(toKey(handle));
            if (!user) return { status: 404 };
            const passkeys = getPasskeys(user);
            if (passkeys.some(passkey => passkey.id === info.credential.id)) {
                return { status: 409, body: { error: '这个通行密钥已经添加过了', code: 'already_added' } };
            }
            if (passkeys.length >= MAX_PASSKEYS) {
                return { status: 409, body: { error: `最多只能添加 ${MAX_PASSKEYS} 个通行密钥，请先删除不用的`, code: 'limit_reached' } };
            }
            const passkey = {
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
            user.passkeys = [...passkeys, passkey];
            await storage.setItem(toKey(handle), user);
            return { status: 200, body: { passkey: describePasskey(passkey), count: user.passkeys.length, max: MAX_PASSKEYS } };
        });
        if (result.status !== 200) {
            return result.body ? response.status(result.status).json(result.body) : response.sendStatus(result.status);
        }
        console.info('Passkey added for', handle, `(${result.body.count}/${MAX_PASSKEYS})`);
        return response.json(result.body);
    } catch (error) {
        console.error('Passkey registration failed:', error);
        return response.status(500).json({ error: '添加失败，请稍后再试' });
    }
});

/**
 * Applies a change to one of the user's passkeys.
 * @param {import('express').Request} request Request with body.id
 * @param {import('express').Response} response Response
 * @param {(passkeys: object[], index: number) => object[]} change Returns the new list
 */
async function updatePasskey(request, response, change) {
    const handle = request.user.profile.handle;
    const id = String(request.body?.id ?? '');
    const result = await withUserLock(handle, async () => {
        const user = await storage.getItem(toKey(handle));
        const passkeys = getPasskeys(user);
        const index = passkeys.findIndex(passkey => passkey.id === id);
        if (!user || index < 0) return null;
        user.passkeys = change(passkeys, index);
        await storage.setItem(toKey(handle), user);
        return user.passkeys;
    });
    if (!result) {
        return response.status(404).json({ error: '找不到这个通行密钥，请刷新后再试', code: 'not_found' });
    }
    return response.json({ passkeys: result.map(describePasskey), max: MAX_PASSKEYS });
}

router.post('/rename', async (request, response) => {
    const name = cleanName(request.body?.name);
    if (!name) {
        return response.status(400).json({ error: '名称不能为空', code: 'invalid_name' });
    }
    try {
        return await updatePasskey(request, response, (passkeys, index) => {
            passkeys[index] = { ...passkeys[index], name };
            return passkeys;
        });
    } catch (error) {
        console.error('Passkey rename failed:', error);
        return response.status(500).json({ error: '保存失败，请稍后再试' });
    }
});

router.post('/delete', async (request, response) => {
    try {
        return await updatePasskey(request, response, (passkeys, index) => passkeys.filter((_, i) => i !== index));
    } catch (error) {
        console.error('Passkey delete failed:', error);
        return response.status(500).json({ error: '删除失败，请稍后再试' });
    }
});


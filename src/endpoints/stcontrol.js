import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import fetch from 'node-fetch';
import storage from 'node-persist';

import { applyDefaultTemplateToUser } from '../default-template.js';
import { useInvitationCode } from '../invitation-codes.js';
import { getRegistrationMethodConfig } from '../registration-policy.js';
import {
    STCONTROL_CAPABILITIES,
    STCONTROL_MODES,
    applyStcontrolMode,
    encodeStcontrolRequestBody,
    getStcontrolControllerUrl,
    getStcontrolModeStatus,
    getStcontrolPendingSyncUsers,
    getStcontrolSessionTelemetry,
    getUserWriteGate,
    isStcontrolEnabled,
    markUserSynchronized,
    registerStcontrolSession,
    requireStcontrolAgent,
    runIdempotentStcontrolOperation,
    setUserWriteGate,
    signStcontrolRequest,
    stcontrolInventoryRevision,
} from '../stcontrol.js';
import systemMonitor from '../system-monitor.js';
import {
    ensurePublicDirectoriesExist,
    getAllUserHandles,
    getPasswordHash,
    getUserDirectories,
    normalizeHandle,
    toKey,
} from '../users.js';
import { getConfigValue, getVersion } from '../util.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INVENTORY_USERS = 10_000;
const MAX_INVENTORY_PAGE_USERS = 250;
const INVENTORY_LOAD_BATCH = 100;
const MAX_HANDOFF_CODE_LENGTH = 512;
const MAX_CONTROLLER_RESPONSE_BYTES = 64 * 1024;
const QUIESCE_TIMEOUT_MS = 15_000;
const ALLOWED_OAUTH_PROVIDERS = new Set(['discord', 'linuxdo']);

export const router = express.Router();

router.use('/api/stcontrol/internal', requireStcontrolAgent);

router.post('/api/stcontrol/internal/health', async (_request, response) => {
    const version = await getVersion();
    return response.json({
        ok: true,
        protocol_version: 1,
        tavern_version: version.pkgVersion || 'unknown',
        capabilities: STCONTROL_CAPABILITIES,
        integration_fingerprint: integrationFingerprint(version.pkgVersion || 'unknown'),
    });
});

router.post('/api/stcontrol/internal/registration-policy', (_request, response) => {
    const policy = currentRegistrationPolicy();
    return response.json({ ok: true, mode: policy.mode, version: policy.version });
});

router.post('/api/stcontrol/internal/control-mode', async (request, response) => {
    try {
        return response.json(await applyStcontrolMode(request.body));
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/sessions', (_request, response) => {
    return response.json({
        ok: true,
        users: getStcontrolSessionTelemetry(),
        pending_users: getStcontrolPendingSyncUsers(),
    });
});

router.post('/api/stcontrol/internal/control/sync-complete', async (request, response) => {
    try {
        const input = request.body || {};
        requireUUID(input.operation_id, 'invalid_operation_id');
        const handle = requireHandle(input.handle);
        requireUUID(input.marker, 'invalid_sync_marker');
        const result = await runIdempotentStcontrolOperation(
            'independent-sync-complete', input.operation_id, { handle, marker: input.marker },
            () => markUserSynchronized(handle, input.marker),
        );
        return response.json(result);
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/users/provision', async (request, response) => {
    try {
        const input = validateAccountRequest(request.body, true);
        const result = await runIdempotentStcontrolOperation('provision', input.operation_id, input, async () => {
            const key = toKey(input.handle);
            const existing = await storage.getItem(key);
            if (existing) {
                if (!matchesProvisionedAccount(existing, input)) {
                    throw new AdapterRequestError(409, 'user_already_exists');
                }
                await initializeUserDirectories(existing);
                return { ok: true, handle: existing.handle, local_user_id: existing.handle, replayed: true };
            }

            const policy = currentRegistrationPolicy();
            if (input.policy_version !== policy.version || policy.mode === 'closed') {
                throw new AdapterRequestError(409, 'registration_policy_changed');
            }
            if (policy.mode === 'invitation_required') {
                const used = await useInvitationCode(input.invitation_code, input.handle, null, {
                    required: true,
                    claimId: input.registration_id,
                });
                if (!used.success) throw new AdapterRequestError(403, 'invalid_invitation_code');
            }
            const newUser = makeUserRecord(input, {
                stcontrolRegistrationId: input.registration_id,
                stcontrolAccountVersion: 1,
            });
            await storage.setItem(key, newUser);
            try {
                await initializeUserDirectories(newUser);
            } catch (error) {
                await storage.removeItem(key);
                throw error;
            }
            return { ok: true, handle: newUser.handle, local_user_id: newUser.handle };
        });
        return response.json(result);
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/users/restore', async (request, response) => {
    try {
        const input = validateAccountRequest(request.body, false);
        if (!UUID_PATTERN.test(input.workflow_id || '') || !Number.isSafeInteger(input.global_user_id) || input.global_user_id <= 0 ||
            !Number.isSafeInteger(input.account_version) || input.account_version <= 0) {
            throw new AdapterRequestError(400, 'invalid_restore_request');
        }
        const result = await runIdempotentStcontrolOperation('restore', input.operation_id, input, async () => {
            const key = toKey(input.handle);
            const existing = await storage.getItem(key);
            if (existing && Number(existing.stcontrolGlobalUserId) !== input.global_user_id) {
                throw new AdapterRequestError(409, 'local_account_conflict');
            }
            if (existing && Number(existing.stcontrolAccountVersion || 0) > input.account_version) {
                throw new AdapterRequestError(409, 'account_version_rollback');
            }
            const user = {
                ...(existing || makeUserRecord(input)),
                name: input.name,
                enabled: true,
                expiresAt: null,
                password: input.password_hash || '',
                salt: input.password_salt || '',
                oauthProvider: input.oauth_provider || undefined,
                oauthUserId: input.oauth_subject || undefined,
                stcontrolGlobalUserId: input.global_user_id,
                stcontrolAccountVersion: input.account_version,
            };
            await storage.setItem(key, user);
            if (!existing) await initializeUserDirectories(user);
            return { ok: true, handle: user.handle, local_user_id: user.handle };
        });
        return response.json(result);
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/users/password', async (request, response) => {
    try {
        const input = request.body || {};
        requireUUID(input.operation_id, 'invalid_operation_id');
        const handle = requireHandle(input.handle);
        if (!isHashMaterial(input.password_hash, input.password_salt) || !Number.isSafeInteger(input.version) || input.version <= 0) {
            throw new AdapterRequestError(400, 'invalid_password_material');
        }
        const normalized = { ...input, handle };
        const result = await runIdempotentStcontrolOperation('password', input.operation_id, normalized, async () => {
            const key = toKey(handle);
            const user = await storage.getItem(key);
            if (!user) throw new AdapterRequestError(404, 'user_not_found');
            if (Number(user.stcontrolPasswordVersion || 0) > input.version) {
                throw new AdapterRequestError(409, 'password_version_rollback');
            }
            user.password = input.password_hash;
            user.salt = input.password_salt;
            user.stcontrolPasswordVersion = input.version;
            await storage.setItem(key, user);
            return { ok: true };
        });
        return response.json(result);
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/users/verify', async (request, response) => {
    try {
        const input = request.body || {};
        requireUUID(input.operation_id, 'invalid_operation_id');
        const handle = requireHandle(input.handle);
        if (typeof input.password !== 'string' || input.password.length === 0 || input.password.length > 256) {
            throw new AdapterRequestError(400, 'invalid_password');
        }
        const normalized = { ...input, handle };
        const result = await runIdempotentStcontrolOperation('local-user-verify', input.operation_id, normalized, async () => {
            const user = await storage.getItem(toKey(handle));
            const verified = Boolean(user?.enabled && user.password && user.salt &&
                user.password === getPasswordHash(input.password, user.salt));
            return {
                handle,
                local_user_id: verified ? String(user.id || handle) : undefined,
                verified,
            };
        });
        return response.json(result);
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/users/scan', async (request, response) => {
    try {
        const input = validateInventoryPageRequest(request.body);
        const accounts = await loadInventoryAccounts();
        if (accounts.length > MAX_INVENTORY_USERS) throw new AdapterRequestError(409, 'inventory_capacity_exceeded');
        const revision = inventoryRevision(accounts);
        if (input.inventory_revision && !safeTextEqual(input.inventory_revision, revision)) {
            throw new AdapterRequestError(409, 'inventory_changed');
        }
        if (input.cursor > accounts.length) throw new AdapterRequestError(409, 'inventory_changed');
        const end = Math.min(input.cursor + input.limit, accounts.length);
        const users = [];
        for (const account of accounts.slice(input.cursor, end)) {
            const inventory = await inventoryDirectory(getUserDirectories(account.handle).root);
            users.push({
                local_user_id: account.localUserId,
                handle: account.handle,
                size_bytes: inventory.size,
                directory_fingerprint: inventory.digest,
                has_password: account.hasPassword,
                oauth_identities: account.oauthIdentities,
                is_admin: account.isAdmin,
            });
        }
        const hasMore = end < accounts.length;
        return response.json({
            ok: true,
            users,
            cursor: input.cursor,
            next_cursor: hasMore ? end : 0,
            total_users: accounts.length,
            inventory_revision: revision,
            has_more: hasMore,
        });
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/admin/verify', async (request, response) => {
    try {
        const input = request.body || {};
        requireUUID(input.operation_id, 'invalid_operation_id');
        const handle = requireHandle(input.handle);
        if (typeof input.password !== 'string' || input.password.length > 256) {
            throw new AdapterRequestError(400, 'invalid_password');
        }
        const normalized = { ...input, handle };
        const result = await runIdempotentStcontrolOperation('admin-verify', input.operation_id, normalized, async () => {
            const user = await storage.getItem(toKey(handle));
            const verified = Boolean(user?.admin && user.enabled && user.password && user.salt &&
                user.password === getPasswordHash(input.password, user.salt));
            if (!verified) return { handle, is_admin: false };
            const permissionVersion = await ensurePermissionVersion(user);
            return { handle, local_user_id: String(user.id || handle), is_admin: true, permission_version: permissionVersion };
        });
        return response.json(result);
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/admin/check', async (request, response) => {
    try {
        const handle = requireHandle(request.body?.handle);
        const user = await storage.getItem(toKey(handle));
        if (!user?.admin || !user.enabled) return response.json({ handle, is_admin: false });
        const permissionVersion = await ensurePermissionVersion(user);
        return response.json({ handle, local_user_id: String(user.id || handle), is_admin: true, permission_version: permissionVersion });
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/snapshots/quiesce', async (request, response) => {
    try {
        const input = validateSnapshotRequest(request.body);
        const current = getUserWriteGate(input.handle);
        if (current && (current.workflowId !== input.workflow_id || current.snapshotId !== input.snapshot_id)) {
            throw new AdapterRequestError(409, 'user_already_quiescing');
        }
        const gate = current || {
            workflowId: input.workflow_id,
            snapshotId: input.snapshot_id,
            activityEpoch: input.activity_epoch,
            freezeToken: crypto.randomBytes(32).toString('base64url'),
            createdAt: Date.now(),
        };
        await setUserWriteGate(input.handle, gate);
        const deadline = Date.now() + QUIESCE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            const active = getStcontrolSessionTelemetry().filter(user => user.handle === input.handle);
            const inFlight = active.reduce((total, user) => total + user.in_flight_reads + user.in_flight_writes, 0);
            if (inFlight === 0) {
                return response.json({ ok: true, drained: true, freeze_token: gate.freezeToken });
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        await setUserWriteGate(input.handle, null);
        throw new AdapterRequestError(409, 'write_drain_timeout');
    } catch (error) {
        return adapterError(response, error);
    }
});

router.post('/api/stcontrol/internal/snapshots/release', async (request, response) => {
    try {
        const input = validateSnapshotRequest(request.body);
        if (typeof input.freeze_token !== 'string' || input.freeze_token.length < 32 || input.freeze_token.length > 128) {
            throw new AdapterRequestError(400, 'invalid_freeze_token');
        }
        const gate = getUserWriteGate(input.handle);
        if (!gate || gate.workflowId !== input.workflow_id || gate.snapshotId !== input.snapshot_id ||
            gate.activityEpoch !== input.activity_epoch || !safeTextEqual(gate.freezeToken, input.freeze_token)) {
            throw new AdapterRequestError(409, 'snapshot_gate_mismatch');
        }
        await setUserWriteGate(input.handle, null);
        return response.json({ ok: true });
    } catch (error) {
        return adapterError(response, error);
    }
});

/**
 * CSRF-safe public handoff target. The existing application exempts POST
 * /api/users/me, so the controller adds only a non-secret kind query while the
 * opaque one-use credential remains in the request body.
 */
export async function stcontrolHandoffHandler(request, response) {
    setNoStore(response);
    if (!isStcontrolEnabled() || !['user', 'admin'].includes(String(request.query.stcontrol_handoff))) {
        return response.sendStatus(404);
    }
    const kind = String(request.query.stcontrol_handoff);
    const code = String(request.body?.stcontrol_code || '');
    if (!code || code.length > MAX_HANDOFF_CODE_LENGTH || !request.session) return response.sendStatus(400);
    try {
        const mode = getStcontrolModeStatus();
        if (mode.mode !== STCONTROL_MODES.MANAGED) throw new AdapterRequestError(409, 'node_not_managed');
        const claims = await redeemControllerHandoff(kind, code);
        if (!claims?.ok || typeof claims.handle !== 'string' ||
            !Number.isSafeInteger(claims.controller_generation) || claims.controller_generation < mode.controllerGeneration) {
            throw new AdapterRequestError(403, 'invalid_handoff_claims');
        }
        const handle = requireHandle(claims.handle);
        const user = await storage.getItem(toKey(handle));
        if (!user?.enabled) throw new AdapterRequestError(403, 'user_unavailable');
        if (kind === 'admin') {
            const permissionVersion = Number(user.stcontrolPermissionVersion || 1);
            if (!Number.isSafeInteger(claims.admin_id) || claims.admin_id <= 0 || !user.admin || claims.permission_version !== permissionVersion) {
                throw new AdapterRequestError(403, 'administrator_permission_changed');
            }
            request.session.stcontrolAdmin = {
                adminId: claims.admin_id,
                permissionVersion: claims.permission_version,
                controllerGeneration: claims.controller_generation,
            };
        } else if (!UUID_PATTERN.test(claims.session_id || '') || !Number.isSafeInteger(claims.user_id) || claims.user_id <= 0 ||
            !Number.isSafeInteger(claims.activity_epoch) || claims.activity_epoch <= 0) {
            throw new AdapterRequestError(403, 'invalid_handoff_claims');
        } else {
            if (user.stcontrolGlobalUserId && Number(user.stcontrolGlobalUserId) !== claims.user_id) {
                throw new AdapterRequestError(409, 'global_user_binding_changed');
            }
            if (!user.stcontrolGlobalUserId) {
                user.stcontrolGlobalUserId = claims.user_id;
                await storage.setItem(toKey(handle), user);
            }
        }
        request.session.handle = user.handle;
        request.session.userId = user.id || user.handle;
        if (kind === 'user') await registerStcontrolSession(request, claims, STCONTROL_MODES.MANAGED);
        systemMonitor.recordUserLogin(user.handle, { userName: user.name });
        systemMonitor.updateUserActivity(user.handle, { userName: user.name, isHeartbeat: false });
        return response.redirect(303, kind === 'admin' ? '/?stcontrol_admin=1' : '/');
    } catch (error) {
        console.warn('stcontrol handoff rejected:', error instanceof AdapterRequestError ? error.code : 'controller_unavailable');
        return response.status(error instanceof AdapterRequestError ? error.status : 503).send('登录交接无效、已使用或暂不可用');
    }
}

class AdapterRequestError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

function adapterError(response, error) {
    const status = error instanceof AdapterRequestError ? error.status : error instanceof TypeError ? 400 : 409;
    const code = error instanceof AdapterRequestError ? error.code : 'adapter_request_rejected';
    if (!(error instanceof AdapterRequestError) && !(error instanceof TypeError)) {
        console.warn('stcontrol adapter operation rejected:', error?.message || 'unknown error');
    }
    return response.status(status).json({ error: code, code });
}

function currentRegistrationPolicy() {
    const config = getRegistrationMethodConfig('password');
    const mode = !config.enabled ? 'closed' : config.requireInvitationCode ? 'invitation_required' : 'open';
    const digest = crypto.createHash('sha256').update(JSON.stringify({ mode })).digest();
    const version = digest.readUInt32BE(0) || 1;
    return { mode, version };
}

function requireUUID(value, code) {
    if (!UUID_PATTERN.test(value || '')) throw new AdapterRequestError(400, code);
}

function requireHandle(value) {
    if (typeof value !== 'string' || value.length > 128) throw new AdapterRequestError(400, 'invalid_handle');
    const handle = normalizeHandle(value);
    if (!handle || handle !== value.toLowerCase()) throw new AdapterRequestError(400, 'invalid_handle');
    return handle;
}

function isHashMaterial(hash, salt) {
    return typeof hash === 'string' && typeof salt === 'string' && hash.length > 0 && hash.length <= 512 && salt.length > 0 && salt.length <= 256;
}

function validateAccountRequest(raw, provision) {
    const input = raw && typeof raw === 'object' ? { ...raw } : {};
    requireUUID(input.operation_id, 'invalid_operation_id');
    if (provision) requireUUID(input.registration_id, 'invalid_registration_id');
    input.handle = requireHandle(input.handle);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 128) {
        throw new AdapterRequestError(400, 'invalid_name');
    }
    input.name = input.name.trim();
    const hasPassword = Boolean(input.password_hash || input.password_salt);
    if (hasPassword && !isHashMaterial(input.password_hash, input.password_salt)) {
        throw new AdapterRequestError(400, 'invalid_password_material');
    }
    const hasOAuth = Boolean(input.oauth_provider || input.oauth_subject);
    if (hasOAuth && (!ALLOWED_OAUTH_PROVIDERS.has(input.oauth_provider) || typeof input.oauth_subject !== 'string' ||
        !input.oauth_subject || input.oauth_subject.length > 512)) {
        throw new AdapterRequestError(400, 'invalid_oauth_identity');
    }
    if (!hasPassword && !hasOAuth) throw new AdapterRequestError(400, 'missing_identity');
    if (provision && (!Number.isSafeInteger(input.policy_version) || input.policy_version <= 0 ||
        typeof input.invitation_code !== 'string' && input.invitation_code !== undefined)) {
        throw new AdapterRequestError(400, 'invalid_registration_request');
    }
    return input;
}

function makeUserRecord(input, extra = {}) {
    return {
        handle: input.handle,
        name: input.name,
        created: Date.now(),
        password: input.password_hash || '',
        salt: input.password_salt || '',
        oauthProvider: input.oauth_provider || undefined,
        oauthUserId: input.oauth_subject || undefined,
        admin: false,
        enabled: true,
        expiresAt: null,
        ...extra,
    };
}

function matchesProvisionedAccount(user, input) {
    return user.stcontrolRegistrationId === input.registration_id &&
        user.handle === input.handle &&
        user.name === input.name &&
        String(user.password || '') === String(input.password_hash || '') &&
        String(user.salt || '') === String(input.password_salt || '') &&
        String(user.oauthProvider || '') === String(input.oauth_provider || '') &&
        String(user.oauthUserId || '') === String(input.oauth_subject || '');
}

async function initializeUserDirectories(user) {
    await ensurePublicDirectoriesExist();
    const directories = getUserDirectories(user.handle);
    await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
    applyDefaultTemplateToUser(directories, { userName: user.name });
}

async function ensurePermissionVersion(user) {
    const current = Number(user.stcontrolPermissionVersion);
    if (Number.isSafeInteger(current) && current > 0) return current;
    user.stcontrolPermissionVersion = 1;
    await storage.setItem(toKey(user.handle), user);
    return 1;
}

function validateSnapshotRequest(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    requireUUID(input.workflow_id, 'invalid_workflow_id');
    requireUUID(input.snapshot_id, 'invalid_snapshot_id');
    input.handle = requireHandle(input.handle);
    if (!Number.isSafeInteger(input.activity_epoch) || input.activity_epoch < 0) {
        throw new AdapterRequestError(400, 'invalid_activity_epoch');
    }
    return input;
}

function safeTextEqual(left, right) {
    const leftBytes = Buffer.from(String(left));
    const rightBytes = Buffer.from(String(right));
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function validateInventoryPageRequest(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const cursor = input.cursor === undefined ? 0 : input.cursor;
    const limit = input.limit === undefined ? MAX_INVENTORY_PAGE_USERS : input.limit;
    const revision = input.inventory_revision === undefined ? '' : input.inventory_revision;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_INVENTORY_USERS ||
        !Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_INVENTORY_PAGE_USERS ||
        typeof revision !== 'string' || (revision && !/^[0-9a-f]{64}$/.test(revision)) ||
        (cursor > 0 && !revision)) {
        throw new AdapterRequestError(400, 'invalid_inventory_page');
    }
    return { cursor, limit, inventory_revision: revision };
}

async function loadInventoryAccounts() {
    const handles = (await getAllUserHandles()).filter(handle => handle !== 'default-user');
    if (handles.length > MAX_INVENTORY_USERS) throw new AdapterRequestError(409, 'inventory_capacity_exceeded');
    const accounts = [];
    for (let index = 0; index < handles.length; index += INVENTORY_LOAD_BATCH) {
        const batch = await Promise.all(handles.slice(index, index + INVENTORY_LOAD_BATCH).map(async (handle) => {
            const user = await storage.getItem(toKey(handle));
            if (!user) return null;
            if (!handle || handle.length > 128 || normalizeHandle(handle) !== handle) {
                throw new AdapterRequestError(409, 'inventory_invalid_handle');
            }
            const localUserId = String(user.id || handle);
            if (!localUserId || localUserId.length > 256 || localUserId.trim() !== localUserId || /[\x00-\x1f\x7f]/.test(localUserId)) {
                throw new AdapterRequestError(409, 'inventory_invalid_local_user_id');
            }
            const oauthIdentities = [];
            if (ALLOWED_OAUTH_PROVIDERS.has(user.oauthProvider) && typeof user.oauthUserId === 'string' && user.oauthUserId) {
                if (user.oauthUserId.length > 512 || user.oauthUserId.trim() !== user.oauthUserId || /[\x00-\x1f\x7f]/.test(user.oauthUserId)) {
                    throw new AdapterRequestError(409, 'inventory_invalid_oauth_subject');
                }
                oauthIdentities.push({ provider: user.oauthProvider, subject: user.oauthUserId });
            }
            return {
                localUserId,
                handle,
                hasPassword: Boolean(user.password && user.salt),
                oauthIdentities,
                isAdmin: Boolean(user.admin),
            };
        }));
        accounts.push(...batch.filter(Boolean));
    }
    accounts.sort((left, right) => compareInventoryText(left.localUserId, right.localUserId) ||
        compareInventoryText(left.handle, right.handle));
    for (let index = 1; index < accounts.length; index++) {
        if (accounts[index - 1].localUserId === accounts[index].localUserId) {
            throw new AdapterRequestError(409, 'inventory_duplicate_local_user_id');
        }
    }
    return accounts;
}

function compareInventoryText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function inventoryRevision(accounts) {
    return stcontrolInventoryRevision(JSON.stringify(accounts));
}

async function inventoryDirectory(root) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    if (!fs.existsSync(root)) return { size, digest: hash.digest('hex') };
    async function walk(directory, prefix = '') {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            const relative = path.posix.join(prefix, entry.name);
            const stat = await fs.promises.lstat(absolute);
            if (stat.isSymbolicLink()) throw new AdapterRequestError(409, 'inventory_symlink_rejected');
            if (stat.isDirectory()) {
                hash.update(`d\0${relative}\0`);
                await walk(absolute, relative);
                continue;
            }
            if (!stat.isFile()) throw new AdapterRequestError(409, 'inventory_special_file_rejected');
            size += stat.size;
            hash.update(`f\0${relative}\0${stat.size}\0`);
            await new Promise((resolve, reject) => {
                const stream = fs.createReadStream(absolute);
                stream.on('data', chunk => hash.update(chunk));
                stream.once('error', reject);
                stream.once('end', resolve);
            });
            hash.update('\0');
        }
    }
    await walk(root);
    return { size, digest: hash.digest('hex') };
}

async function redeemControllerHandoff(kind, code) {
    const base = new URL(getStcontrolControllerUrl());
    if (base.username || base.password || base.search || base.hash ||
        (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
        throw new AdapterRequestError(503, 'invalid_controller_url');
    }
    const body = { code };
    const payload = encodeStcontrolRequestBody(body);
    const requestPath = kind === 'admin' ? '/api/tickets/redeem-admin' : '/api/tickets/redeem';
    const target = new URL(requestPath, `${base.toString().replace(/\/+$/, '')}/`);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const psk = String(process.env.STCONTROL_AGENT_PSK || getConfigValue('stcontrol.agentPsk', '', 'string'));
    const nodeId = Number(getConfigValue('stcontrol.nodeId', 0, 'number'));
    if (!psk || !Number.isSafeInteger(nodeId) || nodeId <= 0) throw new AdapterRequestError(503, 'node_identity_unavailable');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        const result = await fetch(target, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Agent-Id': String(nodeId),
                'X-Timestamp': timestamp,
                'X-Nonce': nonce,
                'X-Signature': signStcontrolRequest(psk, 'POST', requestPath, timestamp, nonce, body),
            },
            body: payload,
            redirect: 'manual',
            signal: controller.signal,
        });
        if (!result.ok || result.status >= 300) throw new AdapterRequestError(result.status === 403 ? 403 : 503, 'handoff_redeem_failed');
        const contentLength = Number(result.headers.get('content-length') || 0);
        if (contentLength > MAX_CONTROLLER_RESPONSE_BYTES) throw new AdapterRequestError(503, 'controller_response_too_large');
        const text = await result.text();
        if (Buffer.byteLength(text) > MAX_CONTROLLER_RESPONSE_BYTES) throw new AdapterRequestError(503, 'controller_response_too_large');
        return JSON.parse(text);
    } finally {
        clearTimeout(timeout);
    }
}

function setNoStore(response) {
    response.set({
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
    });
}

function integrationFingerprint(version) {
    const roots = [
        path.resolve('plugins'),
        path.resolve('public', 'scripts', 'extensions', 'third-party'),
    ];
    const components = [];
    for (const root of roots) {
        try {
            const names = fs.readdirSync(root, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
                .map(entry => entry.name)
                .sort();
            components.push([path.basename(root), names]);
        } catch (error) {
            if (error?.code !== 'ENOENT') components.push([path.basename(root), 'unreadable']);
        }
    }
    return crypto.createHash('sha256').update(JSON.stringify({
        adapter: 1,
        version,
        capabilities: STCONTROL_CAPABILITIES,
        components,
    })).digest('hex');
}

import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { getConfigValue } from './util.js';
import { getLocalDateKey } from './storage-quota.js';
import { canPersistSharedState, onActivate, onDrain } from './process-lifecycle.js';

/**
 * Passkey rules and wording, set from the admin panel (`_global/passkey-settings.json`),
 * plus a small per-day count of passkey sign-ins and additions and the last
 * RECENT_LOGINS sign-in attempts (`_global/passkey-stats.json`, last STATS_DAYS days).
 *
 * Until an administrator saves the settings once, `passkeys.enabled` and
 * `passkeys.rpName` from config.yaml decide; the domain (`rpId`) and allowed
 * origins always come from config.yaml, since changing them strands every
 * existing passkey.
 */

const STORAGE_DIRECTORY = '_global';
const SETTINGS_FILE = 'passkey-settings.json';
const STATS_FILE = 'passkey-stats.json';
const STATS_DAYS = 30;
const STATS_WRITE_DELAY_MS = 5000;
const RECENT_LOGINS = 100;

export const MAX_PASSKEYS_LIMIT = 50;
export const LOGIN_PROMPT_MODES = Object.freeze(['off', 'once', 'weekly']);
export const USER_VERIFICATION_MODES = Object.freeze(['preferred', 'required']);

const TEXT_LIMITS = Object.freeze({ rpName: 40, loginButtonText: 20, loginHintText: 80, managerDescription: 120 });

export const PASSKEY_SETTING_DEFAULTS = Object.freeze({
    enabled: false,
    allowRegistration: true,
    maxPerUser: 10,
    userVerification: 'preferred',
    showOnLoginPage: true,
    showInSettings: true,
    loginPrompt: 'off',
    rpName: '',
    loginButtonText: '通行密钥登录',
    loginHintText: '指纹 / 面容一键登录，需先在「用户设置 → 通行密钥」里添加',
    managerDescription: '用指纹、面容或设备锁屏密码一键登录，不用再打开 Discord。',
});

/** @type {object|null} */
let settingsCache = null;
/**
 * @typedef {object} PasskeyLoginEntry
 * @property {number} at Time (ms)
 * @property {boolean} ok Whether the sign-in succeeded
 * @property {string} [handle] Account, when it exists
 * @property {string} [name] Account display name
 * @property {string} [passkeyName] Passkey used
 * @property {string} [reason] Why it failed
 */
/** @type {{days: Record<string, {logins: number, registrations: number, failures: number}>, recent: PasskeyLoginEntry[]}|null} */
let statsCache = null;
let statsTimer = null;

// Hot reload: pick up what the previous server saved.
onActivate(() => {
    settingsCache = null;
    statsCache = null;
});
onDrain(() => flushStats());

function storagePath(file) {
    return path.join(globalThis.DATA_ROOT, STORAGE_DIRECTORY, file);
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(storagePath(file), 'utf8'));
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            console.warn(`Could not read ${file}, using defaults:`, error.message);
        }
        return null;
    }
}

function writeJsonSync(file, value) {
    if (!canPersistSharedState()) return;
    fs.mkdirSync(path.dirname(storagePath(file)), { recursive: true });
    writeFileAtomic.sync(storagePath(file), JSON.stringify(value, null, 2), 'utf8');
}

function cleanText(value, limit) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Validates settings, keeping the fallback for anything missing or invalid.
 * @param {unknown} raw Settings to check
 * @param {object} [fallback] Values used for missing or invalid fields
 * @returns {typeof PASSKEY_SETTING_DEFAULTS}
 */
export function normalizePasskeySettings(raw, fallback = PASSKEY_SETTING_DEFAULTS) {
    const value = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    const bool = key => typeof value[key] === 'boolean' ? value[key] : fallback[key];
    const max = Number(value.maxPerUser);
    const settings = {
        enabled: bool('enabled'),
        allowRegistration: bool('allowRegistration'),
        maxPerUser: Number.isInteger(max) && max >= 1 && max <= MAX_PASSKEYS_LIMIT ? max : fallback.maxPerUser,
        userVerification: USER_VERIFICATION_MODES.includes(String(value.userVerification)) ? String(value.userVerification) : fallback.userVerification,
        showOnLoginPage: bool('showOnLoginPage'),
        showInSettings: bool('showInSettings'),
        loginPrompt: LOGIN_PROMPT_MODES.includes(String(value.loginPrompt)) ? String(value.loginPrompt) : fallback.loginPrompt,
    };
    for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
        settings[key] = typeof value[key] === 'string' ? cleanText(value[key], limit) : fallback[key];
    }
    // A button or a dialog without words would be useless; the login hint may be left out.
    for (const key of ['loginButtonText', 'managerDescription']) {
        if (!settings[key]) settings[key] = PASSKEY_SETTING_DEFAULTS[key];
    }
    return /** @type {typeof PASSKEY_SETTING_DEFAULTS} */ (settings);
}

function getConfigDefaults() {
    return {
        ...PASSKEY_SETTING_DEFAULTS,
        enabled: getConfigValue('passkeys.enabled', false, 'boolean'),
        rpName: cleanText(getConfigValue('passkeys.rpName', ''), TEXT_LIMITS.rpName),
    };
}

/** @returns {typeof PASSKEY_SETTING_DEFAULTS & {saved: boolean}} Current settings */
export function getPasskeySettings() {
    if (!settingsCache) {
        const stored = readJson(SETTINGS_FILE);
        settingsCache = { ...normalizePasskeySettings(stored, getConfigDefaults()), saved: Boolean(stored) };
    }
    return settingsCache;
}

/**
 * Saves settings from the admin panel.
 * @param {unknown} raw New settings
 * @returns {typeof PASSKEY_SETTING_DEFAULTS & {saved: boolean}}
 */
export function savePasskeySettings(raw) {
    const settings = normalizePasskeySettings(raw, getPasskeySettings());
    writeJsonSync(SETTINGS_FILE, settings);
    settingsCache = { ...settings, saved: true };
    return settingsCache;
}

function loadStats() {
    if (!statsCache) {
        const stored = readJson(STATS_FILE);
        statsCache = {
            days: stored?.days && typeof stored.days === 'object' ? stored.days : {},
            recent: Array.isArray(stored?.recent) ? stored.recent.slice(-RECENT_LOGINS) : [],
        };
    }
    return statsCache;
}

function flushStats() {
    if (statsTimer) {
        clearTimeout(statsTimer);
        statsTimer = null;
    }
    if (!statsCache) return;
    try {
        writeJsonSync(STATS_FILE, statsCache);
    } catch (error) {
        console.warn('Could not save passkey stats:', error.message);
    }
}

/**
 * Counts one passkey event for today.
 * @param {'logins'|'registrations'|'failures'} kind Event
 */
export function recordPasskeyEvent(kind) {
    const stats = loadStats();
    const today = getLocalDateKey();
    const day = stats.days[today] ??= { logins: 0, registrations: 0, failures: 0 };
    day[kind] = (Number(day[kind]) || 0) + 1;
    const keep = Object.keys(stats.days).sort().slice(-STATS_DAYS);
    for (const key of Object.keys(stats.days)) {
        if (!keep.includes(key)) delete stats.days[key];
    }
    statsTimer ??= setTimeout(flushStats, STATS_WRITE_DELAY_MS);
    statsTimer.unref?.();
}

/**
 * Remembers one sign-in attempt for the admin panel (newest RECENT_LOGINS kept).
 * @param {{ok: boolean, handle?: string, name?: string, passkeyName?: string, reason?: string}} entry Attempt
 */
export function recordPasskeyLogin(entry) {
    const stats = loadStats();
    const clean = (value, max) => typeof value === 'string' && value ? value.slice(0, max) : undefined;
    stats.recent.push({
        at: Date.now(),
        ok: Boolean(entry.ok),
        handle: clean(entry.handle, 64),
        name: clean(entry.name, 64),
        passkeyName: clean(entry.passkeyName, 64),
        reason: clean(entry.reason, 32),
    });
    if (stats.recent.length > RECENT_LOGINS) stats.recent.splice(0, stats.recent.length - RECENT_LOGINS);
    statsTimer ??= setTimeout(flushStats, STATS_WRITE_DELAY_MS);
    statsTimer.unref?.();
}

/**
 * @returns {PasskeyLoginEntry[]} Recent sign-in attempts, newest first
 */
export function getRecentPasskeyLogins() {
    return [...loadStats().recent].reverse();
}

/**
 * @param {number} [days] Days to report, most recent last
 * @returns {{today: object, total: object, days: {date: string, logins: number, registrations: number, failures: number}[]}}
 */
export function getPasskeyStats(days = 7) {
    const stats = loadStats();
    const list = [];
    const date = new Date();
    for (let i = days - 1; i >= 0; i--) {
        const key = getLocalDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - i));
        const day = stats.days[key] ?? {};
        list.push({ date: key, logins: Number(day.logins) || 0, registrations: Number(day.registrations) || 0, failures: Number(day.failures) || 0 });
    }
    const total = list.reduce((sum, day) => ({
        logins: sum.logins + day.logins,
        registrations: sum.registrations + day.registrations,
        failures: sum.failures + day.failures,
    }), { logins: 0, registrations: 0, failures: 0 });
    return { today: list[list.length - 1], total, days: list };
}

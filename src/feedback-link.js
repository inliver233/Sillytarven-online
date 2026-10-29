import { createHmac } from 'node:crypto';

import { getConfigValue } from './util.js';

/** A signed link stays valid this long; the page fetches a fresh one well before. */
export const FEEDBACK_LINK_HOURS = 24;

/**
 * Signs link parameters the way the feedback questionnaire (Quesuwa) checks them: every
 * parameter except `sig`, sorted by name, form-encoded, HMAC-SHA256, base64url.
 * @param {string} secret Shared link secret
 * @param {URLSearchParams} params Link parameters
 * @returns {string}
 */
export function signFeedbackParams(secret, params) {
    const entries = [...params].filter(([key]) => key !== 'sig');
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHmac('sha256', secret).update(new URLSearchParams(entries).toString()).digest('base64url');
}

/**
 * @returns {{ secret: string, origin: string, site: string }} Empty secret or origin means unsigned links
 */
export function getFeedbackLinkConfig() {
    const secret = String(getConfigValue('feedback.linkSecret', '') || '');
    const site = String(getConfigValue('feedback.site', '') || '').trim();
    let origin = '';
    try {
        origin = new URL(String(getConfigValue('feedback.formOrigin', '') || '')).origin;
    } catch {
        origin = '';
    }
    return { secret, origin, site };
}

/**
 * Link parameters that prove which account opened the feedback form.
 * @param {string} handle Signed-in user
 * @param {number} [now] Current time in milliseconds
 * @returns {{ origin: string, params: Record<string, string>, expiresAt: number } | null}
 */
export function createFeedbackLink(handle, now = Date.now()) {
    const { secret, origin, site } = getFeedbackLinkConfig();
    if (!secret || !origin || !handle) {
        return null;
    }
    const expiresAt = Math.floor(now / 1000) + FEEDBACK_LINK_HOURS * 3600;
    const params = new URLSearchParams();
    if (site) {
        params.set('site', site);
    }
    params.set('user', handle);
    params.set('exp', String(expiresAt));
    params.set('sig', signFeedbackParams(secret, params));
    return { origin, params: Object.fromEntries(params), expiresAt: expiresAt * 1000 };
}

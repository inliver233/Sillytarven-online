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
 * `feedback.formUrl` is the questionnaire's address; the older `feedback.formOrigin` (origin only)
 * still signs announcement links but gives the menu nothing to open.
 * @returns {{ secret: string, origin: string, formUrl: string, site: string }} Empty secret means unsigned links
 */
export function getFeedbackLinkConfig() {
    const secret = String(getConfigValue('feedback.linkSecret', '') || '');
    const site = String(getConfigValue('feedback.site', '') || '').trim();
    for (const [key, isFormUrl] of [['feedback.formUrl', true], ['feedback.formOrigin', false]]) {
        try {
            const url = new URL(String(getConfigValue(key, '') || ''));
            if (url.protocol === 'https:' || url.protocol === 'http:') {
                const formUrl = isFormUrl && url.pathname !== '/' ? url.origin + url.pathname : '';
                return { secret, origin: url.origin, formUrl, site };
            }
        } catch {
            // Not a URL; try the next setting.
        }
    }
    return { secret, origin: '', formUrl: '', site };
}

/**
 * The feedback form link for a signed-in user: signed parameters that prove which account opened
 * it (when a secret is set) and the full address the menu opens (when formUrl is set).
 * @param {string} handle Signed-in user
 * @param {number} [now] Current time in milliseconds
 * @returns {{ origin: string, params: Record<string, string> | null, expiresAt: number, url: string } | null}
 */
export function createFeedbackLink(handle, now = Date.now()) {
    const { secret, origin, formUrl, site } = getFeedbackLinkConfig();
    if (!origin || !handle || (!secret && !formUrl)) {
        return null;
    }
    const params = new URLSearchParams();
    if (site) {
        params.set('site', site);
    }
    params.set('user', handle);
    if (!secret) {
        return { origin, params: null, expiresAt: 0, url: `${formUrl}?${params}` };
    }
    const expiresAt = Math.floor(now / 1000) + FEEDBACK_LINK_HOURS * 3600;
    params.set('exp', String(expiresAt));
    params.set('sig', signFeedbackParams(secret, params));
    return { origin, params: Object.fromEntries(params), expiresAt: expiresAt * 1000, url: formUrl ? `${formUrl}?${params}` : '' };
}

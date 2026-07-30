export const USER_INVITATION_SOURCE = 'user';
export const ADMIN_INVITATION_SOURCE = 'admin';

export const DEFAULT_USER_INVITATION_CONFIG = Object.freeze({
    enabled: true,
    minRegisteredDays: 30,
    minOnlineHours: 72,
    quotaPerPeriod: 1,
    periodDays: 1,
    maxTotalCodes: 800,
});

const CONFIG_NUMBER_LIMITS = Object.freeze({
    minRegisteredDays: { min: 0, max: 36_500 },
    minOnlineHours: { min: 0, max: 1_000_000 },
    quotaPerPeriod: { min: 1, max: 100_000 },
    periodDays: { min: 1, max: 36_500 },
    maxTotalCodes: { min: 1, max: 100_000 },
});

/**
 * Treat invitations created before source metadata was introduced as legacy
 * administrator invitations. The migration in user-invitations.js upgrades
 * invitations that can be proven to have been issued by a non-admin user.
 * @param {object} invitation Invitation record
 * @returns {'user' | 'admin'} Normalized source
 */
export function getInvitationSource(invitation) {
    return invitation?.issuanceSource === USER_INVITATION_SOURCE
        ? USER_INVITATION_SOURCE
        : ADMIN_INVITATION_SOURCE;
}

/**
 * @param {object} invitation Invitation record
 * @returns {boolean} Whether this belongs to the user issuance system
 */
export function isUserIssuedInvitation(invitation) {
    return getInvitationSource(invitation) === USER_INVITATION_SOURCE;
}

/**
 * Merge an administrator-supplied partial config using a strict allow-list.
 * @param {object} current Current config
 * @param {object} partial Requested changes
 * @returns {typeof DEFAULT_USER_INVITATION_CONFIG} Sanitized config
 */
export function mergeUserInvitationConfig(current, partial) {
    const merged = {
        ...DEFAULT_USER_INVITATION_CONFIG,
        ...(current && typeof current === 'object' ? current : {}),
    };
    const requested = partial && typeof partial === 'object' ? partial : {};

    if (typeof requested.enabled === 'boolean') {
        merged.enabled = requested.enabled;
    } else {
        merged.enabled = Boolean(merged.enabled);
    }

    for (const [field, limits] of Object.entries(CONFIG_NUMBER_LIMITS)) {
        const requestedValue = Object.hasOwn(requested, field) ? requested[field] : merged[field];
        const numericValue = Number(requestedValue);
        const currentValue = Number(merged[field]);
        const fallback = Number.isFinite(currentValue)
            ? Math.trunc(currentValue)
            : DEFAULT_USER_INVITATION_CONFIG[field];
        const finiteValue = Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
        merged[field] = Math.min(limits.max, Math.max(limits.min, finiteValue));
    }

    return Object.fromEntries(Object.keys(DEFAULT_USER_INVITATION_CONFIG).map(key => [key, merged[key]]));
}

/**
 * Calculate user issuance quota using a rolling N-day window.
 * @param {object[]} issuedByUser Invitations issued by the current user
 * @param {number} totalUserSystemCodes Total invitations in the user system
 * @param {typeof DEFAULT_USER_INVITATION_CONFIG} config Active config
 * @param {number} [now=Date.now()] Current timestamp
 * @returns {{canIssue: boolean, reason: string | null, nextIssueAt: number | null, periodIssued: number, unusedPending: number}}
 */
export function calculateUserInvitationQuota(issuedByUser, totalUserSystemCodes, config, now = Date.now()) {
    const periodMs = config.periodDays * 86_400_000;
    const cutoff = now - periodMs;
    const periodCodes = issuedByUser
        .filter(code => Number.isFinite(code.createdAt) && code.createdAt > cutoff)
        .sort((a, b) => a.createdAt - b.createdAt);
    const unusedPending = issuedByUser.filter(code => !code.used).length;

    // This is intentionally unconditional: a user must get the previous code
    // consumed before another code can be generated.
    if (unusedPending > 0) {
        return {
            canIssue: false,
            reason: '您还有未使用的邀请码，待其被使用后方可生成新的',
            nextIssueAt: null,
            periodIssued: periodCodes.length,
            unusedPending,
        };
    }

    if (periodCodes.length >= config.quotaPerPeriod) {
        const blockingIndex = periodCodes.length - config.quotaPerPeriod;
        return {
            canIssue: false,
            reason: '当前周期可生成数量已达上限',
            nextIssueAt: periodCodes[blockingIndex].createdAt + periodMs,
            periodIssued: periodCodes.length,
            unusedPending,
        };
    }

    if (totalUserSystemCodes >= config.maxTotalCodes) {
        return {
            canIssue: false,
            reason: '用户邀请码总量已达上限，请联系管理员',
            nextIssueAt: null,
            periodIssued: periodCodes.length,
            unusedPending,
        };
    }

    return {
        canIssue: true,
        reason: null,
        nextIssueAt: null,
        periodIssued: periodCodes.length,
        unusedPending,
    };
}

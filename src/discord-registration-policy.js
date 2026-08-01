import fetch from 'node-fetch';

import { getConfigValue } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MINIMUM_DAYS = 14;
const MAX_MINIMUM_DAYS = 36_500;

function normalizeMinimumDays(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return DEFAULT_MINIMUM_DAYS;
    }
    return Math.min(MAX_MINIMUM_DAYS, Math.max(0, Math.trunc(numericValue)));
}

function getGuildLabel(config) {
    return config.guildName
        ? `Discord 服务器“${config.guildName}”`
        : '指定 Discord 服务器';
}

/**
 * Read the optional Discord guild-membership rule for new registrations.
 * @returns {{enabled: boolean, guildId: string, guildName: string, minimumDays: number}}
 */
export function getDiscordGuildMembershipConfig() {
    return {
        enabled: getConfigValue('registration.discord.guildMembership.enabled', false, 'boolean'),
        guildId: String(getConfigValue('registration.discord.guildMembership.guildId', '') || '').trim(),
        guildName: String(getConfigValue('registration.discord.guildMembership.guildName', '') || '').trim(),
        minimumDays: normalizeMinimumDays(getConfigValue(
            'registration.discord.guildMembership.minimumDays',
            DEFAULT_MINIMUM_DAYS,
            'number',
        )),
    };
}

/**
 * Evaluate Discord's joined_at value against the configured minimum duration.
 * @param {object} member Discord guild member response
 * @param {{enabled: boolean, guildId: string, guildName: string, minimumDays: number}} config Active rule
 * @param {number} [now=Date.now()] Current timestamp
 * @returns {{eligible: boolean, reason: string, message?: string, joinedAt?: string, membershipDays?: number, remainingDays?: number, eligibleAt?: string}}
 */
export function evaluateDiscordGuildMembership(member, config, now = Date.now()) {
    if (!config.enabled) {
        return { eligible: true, reason: 'not_required' };
    }

    const guildLabel = getGuildLabel(config);
    if (!/^\d+$/.test(config.guildId)) {
        return {
            eligible: false,
            reason: 'invalid_configuration',
            message: 'Discord 服务器成员验证配置不完整，请联系管理员',
        };
    }

    const joinedAtMs = Date.parse(member?.joined_at);
    if (!Number.isFinite(joinedAtMs) || joinedAtMs > now) {
        return {
            eligible: false,
            reason: 'joined_at_unavailable',
            message: `无法获取您加入 ${guildLabel} 的时间，请联系管理员`,
        };
    }

    const minimumDays = normalizeMinimumDays(config.minimumDays);
    const eligibleAtMs = joinedAtMs + minimumDays * DAY_MS;
    const membershipDays = Math.floor((now - joinedAtMs) / DAY_MS);
    if (now < eligibleAtMs) {
        const remainingDays = Math.ceil((eligibleAtMs - now) / DAY_MS);
        return {
            eligible: false,
            reason: 'membership_too_new',
            message: `您加入 ${guildLabel} 已 ${membershipDays} 天，还需 ${remainingDays} 天才能注册`,
            joinedAt: new Date(joinedAtMs).toISOString(),
            membershipDays,
            remainingDays,
            eligibleAt: new Date(eligibleAtMs).toISOString(),
        };
    }

    return {
        eligible: true,
        reason: 'eligible',
        joinedAt: new Date(joinedAtMs).toISOString(),
        membershipDays,
        remainingDays: 0,
        eligibleAt: new Date(eligibleAtMs).toISOString(),
    };
}

/**
 * Fetch and evaluate the current user's membership in the configured guild.
 * The access token is used only for this request and is never persisted.
 * @param {string} accessToken Discord OAuth user access token
 * @param {{enabled: boolean, guildId: string, guildName: string, minimumDays: number}} config Active rule
 * @param {typeof fetch} [fetchImpl=fetch] Fetch implementation
 * @param {number} [now=Date.now()] Current timestamp
 * @returns {Promise<ReturnType<typeof evaluateDiscordGuildMembership>>}
 */
export async function fetchDiscordGuildMembershipEligibility(
    accessToken,
    config,
    fetchImpl = fetch,
    now = Date.now(),
) {
    if (!config.enabled) {
        return { eligible: true, reason: 'not_required' };
    }

    if (!/^\d+$/.test(config.guildId)) {
        return evaluateDiscordGuildMembership(null, config, now);
    }

    try {
        const response = await fetchImpl(
            `https://discord.com/api/v10/users/@me/guilds/${encodeURIComponent(config.guildId)}/member`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                },
            },
        );

        if (response.status === 404) {
            return {
                eligible: false,
                reason: 'not_a_member',
                message: `请先加入 ${getGuildLabel(config)}，并在加入满 ${config.minimumDays} 天后再注册`,
            };
        }
        if (response.status === 401 || response.status === 403) {
            return {
                eligible: false,
                reason: 'authorization_failed',
                message: '无法读取您的 Discord 服务器成员信息，请重新授权后再试',
            };
        }
        if (!response.ok) {
            return {
                eligible: false,
                reason: 'discord_api_error',
                message: 'Discord 服务器成员验证失败，请稍后重试',
            };
        }

        return evaluateDiscordGuildMembership(await response.json(), config, now);
    } catch (error) {
        console.error('Discord guild membership verification failed:', error?.message || error);
        return {
            eligible: false,
            reason: 'discord_api_error',
            message: 'Discord 服务器成员验证失败，请稍后重试',
        };
    }
}

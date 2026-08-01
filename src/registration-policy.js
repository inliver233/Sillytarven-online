import { getConfigValue } from './util.js';

export const REGISTRATION_METHODS = Object.freeze(['password', 'github', 'discord', 'linuxdo']);

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }

    return fallback;
}

/**
 * Resolve registration settings using the legacy invitation-code switch as
 * the fallback for per-method invitation requirements.
 * @param {object} registrationConfig Raw registration configuration
 * @param {boolean} globalInvitationCodesEnabled Legacy global setting
 * @returns {Record<'password' | 'github' | 'discord' | 'linuxdo', {enabled: boolean, requireInvitationCode: boolean}>}
 */
export function resolveRegistrationConfig(registrationConfig, globalInvitationCodesEnabled = false) {
    const rawConfig = registrationConfig && typeof registrationConfig === 'object'
        ? registrationConfig
        : {};
    const inheritedInvitationRequirement = normalizeBoolean(globalInvitationCodesEnabled, false);

    return Object.fromEntries(REGISTRATION_METHODS.map(method => {
        const methodConfig = rawConfig[method] && typeof rawConfig[method] === 'object'
            ? rawConfig[method]
            : {};
        const configuredInvitationRequirement = methodConfig.requireInvitationCode;
        const requireInvitationCode = configuredInvitationRequirement === null || configuredInvitationRequirement === undefined || configuredInvitationRequirement === ''
            ? inheritedInvitationRequirement
            : normalizeBoolean(configuredInvitationRequirement, inheritedInvitationRequirement);

        return [method, {
            enabled: normalizeBoolean(methodConfig.enabled, true),
            requireInvitationCode,
        }];
    }));
}

/**
 * Get the effective registration configuration.
 * @returns {ReturnType<typeof resolveRegistrationConfig>}
 */
export function getRegistrationConfig() {
    const globalInvitationCodesEnabled = getConfigValue('enableInvitationCodes', false, 'boolean');
    const registrationConfig = Object.fromEntries(REGISTRATION_METHODS.map(method => [method, {
        enabled: getConfigValue(`registration.${method}.enabled`, true, null),
        requireInvitationCode: getConfigValue(`registration.${method}.requireInvitationCode`, null, null),
    }]));
    return resolveRegistrationConfig(registrationConfig, globalInvitationCodesEnabled);
}

/**
 * Get one validated registration method configuration.
 * @param {'password' | 'github' | 'discord' | 'linuxdo'} method Registration method
 * @param {ReturnType<typeof resolveRegistrationConfig>} [registrationConfig] Effective configuration override
 * @returns {{enabled: boolean, requireInvitationCode: boolean}}
 */
export function getRegistrationMethodConfig(method, registrationConfig = getRegistrationConfig()) {
    if (!REGISTRATION_METHODS.includes(method)) {
        throw new TypeError(`Unsupported registration method: ${method}`);
    }

    return registrationConfig[method];
}

/**
 * Invitation-code storage and administration must remain available whenever
 * the legacy switch or any registration method requires a code.
 * @param {ReturnType<typeof resolveRegistrationConfig>} [registrationConfig] Effective registration configuration
 * @param {boolean} [globalInvitationCodesEnabled] Legacy global setting
 * @returns {boolean}
 */
export function isInvitationCodeSystemEnabled(
    registrationConfig = getRegistrationConfig(),
    globalInvitationCodesEnabled = getConfigValue('enableInvitationCodes', false, 'boolean'),
) {
    return normalizeBoolean(globalInvitationCodesEnabled, false) ||
        Object.values(registrationConfig).some(config => config.requireInvitationCode);
}

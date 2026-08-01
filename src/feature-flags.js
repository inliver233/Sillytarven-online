import { getConfigValue } from './util.js';

export const MIGRATION_FEATURE_FLAGS = Object.freeze({
    macros2: 'featureFlags.macros2',
    reasoningTools: 'featureFlags.reasoningTools',
    extensionLifecycle: 'featureFlags.extensionLifecycle',
    swipePicker: 'featureFlags.swipePicker',
    worldInfoRelink: 'featureFlags.worldInfoRelink',
});

/**
 * Returns the public, boolean-only projection of migration feature flags.
 * @param {(key: string, defaultValue: boolean, type: string) => unknown} readConfig Config value reader
 * @returns {{macros2: boolean, reasoningTools: boolean, extensionLifecycle: boolean, swipePicker: boolean, worldInfoRelink: boolean}}
 */
export function getPublicMigrationFeatureFlags(readConfig = getConfigValue) {
    return /** @type {any} */ (Object.fromEntries(Object.entries(MIGRATION_FEATURE_FLAGS).map(([name, key]) => [
        name,
        readConfig(key, false, 'boolean') === true,
    ])));
}

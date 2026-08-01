let macros2Enabled = false;
let loadPromise = null;

/**
 * Loads the instance-level Macros 2.0 kill switch. Failures keep the engine disabled.
 * @param {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} fetchImpl
 * @returns {Promise<boolean>}
 */
export function loadMacros2FeatureGate(fetchImpl = fetch) {
    loadPromise ??= fetchImpl('/api/public-config/feature-flags')
        .then(response => response.ok ? response.json() : null)
        .then(flags => {
            macros2Enabled = flags?.macros2 === true;
            return macros2Enabled;
        })
        .catch(error => {
            console.warn('Could not load the Macros 2.0 feature gate; using the legacy macro engine.', error);
            macros2Enabled = false;
            return false;
        });

    return loadPromise;
}

/**
 * Returns whether Macros 2.0 is enabled for this instance and user.
 * @param {boolean} userSetting Saved experimental_macro_engine preference
 * @returns {boolean}
 */
export function isMacros2Enabled(userSetting) {
    return macros2Enabled && userSetting === true;
}

/**
 * Returns the instance-level flag without consulting user settings.
 * @returns {boolean}
 */
export function isMacros2Available() {
    return macros2Enabled;
}

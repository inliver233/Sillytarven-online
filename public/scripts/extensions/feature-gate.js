let extensionLifecycleEnabled = false;
let loadPromise = null;

/**
 * Loads the instance-level extension lifecycle gate. Failures preserve legacy loading.
 * @param {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} fetchImpl Fetch implementation
 * @returns {Promise<boolean>} Whether lifecycle loading is enabled
 */
export function loadExtensionLifecycleFeatureGate(fetchImpl = fetch) {
    loadPromise ??= fetchImpl('/api/public-config/extension-lifecycle')
        .then(response => response.ok ? response.json() : null)
        .then(config => {
            extensionLifecycleEnabled = config?.enabled === true;
            return extensionLifecycleEnabled;
        })
        .catch(error => {
            console.warn('Could not load the extension lifecycle feature gate; using legacy extension loading.', error);
            extensionLifecycleEnabled = false;
            return false;
        });

    return loadPromise;
}

/**
 * @returns {boolean} Whether client-managed extension lifecycle loading is enabled
 */
export function isExtensionLifecycleEnabled() {
    return extensionLifecycleEnabled;
}

/**
 * Resets cached state for isolated tests.
 */
export function resetExtensionLifecycleFeatureGateForTests() {
    extensionLifecycleEnabled = false;
    loadPromise = null;
}

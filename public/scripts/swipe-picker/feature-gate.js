let swipePickerEnabled = false;
let loadPromise = null;

/**
 * Loads the public Swipe Picker kill switch. Failures keep the feature disabled.
 * @param {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} fetchImpl
 * @returns {Promise<boolean>}
 */
export function loadSwipePickerFeatureGate(fetchImpl = fetch) {
    loadPromise ??= fetchImpl('/api/public-config/feature-flags')
        .then(response => response.ok ? response.json() : null)
        .then(flags => {
            swipePickerEnabled = flags?.swipePicker === true;
            return swipePickerEnabled;
        })
        .catch(error => {
            console.warn('Could not load the Swipe Picker feature gate; keeping the picker disabled.', error);
            swipePickerEnabled = false;
            return false;
        });

    return loadPromise;
}

/**
 * Returns the loaded instance-level Swipe Picker flag.
 * @returns {boolean}
 */
export function isSwipePickerAvailable() {
    return swipePickerEnabled;
}

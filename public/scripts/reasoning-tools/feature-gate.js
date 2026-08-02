let reasoningToolsEnabled = false;
let recurseHardLimit = 50;
let loadPromise = null;

const MIN_RECURSE_LIMIT = 1;
const MAX_RECURSE_LIMIT = 50;

/**
 * Loads the instance-level Reasoning and Tool Calling feature gate.
 * Failures preserve legacy behavior.
 * @param {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} fetchImpl
 * @returns {Promise<boolean>}
 */
export function loadReasoningToolsFeatureGate(fetchImpl = fetch) {
    loadPromise ??= fetchImpl('/api/public-config/reasoning-tools')
        .then(response => response.ok ? response.json() : null)
        .then(config => {
            reasoningToolsEnabled = config?.enabled === true;
            recurseHardLimit = normalizeRecurseLimit(config?.recurseHardLimit, MAX_RECURSE_LIMIT);
            document.querySelectorAll('[data-feature="reasoningTools"]').forEach(element => {
                element.classList.toggle('displayNone', !reasoningToolsEnabled);
            });
            return reasoningToolsEnabled;
        })
        .catch(error => {
            console.warn('Could not load the Reasoning and Tool Calling feature gate; using legacy behavior.', error);
            reasoningToolsEnabled = false;
            return false;
        });

    return loadPromise;
}

/**
 * @returns {boolean} Whether modern reasoning/tool behavior is enabled.
 */
export function isReasoningToolsEnabled() {
    return reasoningToolsEnabled;
}

/**
 * @returns {number} Validated instance recursion hard cap.
 */
export function getToolRecurseHardLimit() {
    return recurseHardLimit;
}

/**
 * Validates a recurse limit without mutating persisted settings.
 * @param {unknown} value Candidate value
 * @param {number} fallback Fallback value
 * @returns {number}
 */
export function normalizeRecurseLimit(value, fallback = 5) {
    const number = Number(value);
    return Number.isInteger(number) && number >= MIN_RECURSE_LIMIT && number <= MAX_RECURSE_LIMIT
        ? number
        : fallback;
}

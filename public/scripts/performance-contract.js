/**
 * Consecutive slices of the first page load, in order: each one is the time since
 * the previous one, so together they add up to the whole startup.
 */
export const STARTUP_STEPS = Object.freeze([
    'boot', 'csrf', 'ui-init', 'client-version', 'secrets', 'locales', 'core-init', 'presets',
    'settings-fetch', 'settings-parse', 'settings-apply',
    'extensions-discover', 'extensions-update', 'extensions-activate', 'settings-finish',
    'ui-config', 'avatars', 'characters', 'backgrounds', 'tokenizers', 'personas', 'autocomplete',
    'ui-panels', 'scrapers', 'ui-final', 'hide-loader', 'app-ready',
]);

const STARTUP_STEP_COUNTERS = Object.freeze({
    'extensions-discover': Object.freeze(['extensions']),
    'extensions-activate': Object.freeze(['activated', 'third_party']),
});

export const CLIENT_PERFORMANCE_COUNTERS = Object.freeze({
    ...Object.fromEntries(STARTUP_STEPS.map(step => [`startup-step-${step}`, STARTUP_STEP_COUNTERS[step] ?? Object.freeze([])])),
    'startup-first-ui': Object.freeze([]),
    'startup-settings-ready': Object.freeze([]),
    'startup-characters-ready': Object.freeze([]),
    'startup-chat-input-ready': Object.freeze([]),
    'ui-long-task': Object.freeze([]),
    'chat-load-more-frame': Object.freeze(['frames', 'messages', 'yields']),
    'chat-initial-render': Object.freeze(['messages', 'frames', 'yields']),
    'chat-hydration': Object.freeze(['messages', 'cancelled']),
    'welcome-recent-chat-transition': Object.freeze(['cancelled']),
    'welcome-show-more-transition': Object.freeze(['items', 'cancelled']),
    'regex-chat-refresh': Object.freeze(['requests', 'merged']),
    'prompt-token-dry-run': Object.freeze(['requests', 'merged']),
    'settings-save-serialize': Object.freeze(['characters', 'noop']),
});

export const CLIENT_PERFORMANCE_OPERATIONS = Object.freeze(Object.keys(CLIENT_PERFORMANCE_COUNTERS));
export const MAX_CLIENT_PERFORMANCE_BATCH = 20;
export const MAX_CLIENT_PERFORMANCE_COUNTERS = 4;
export const MAX_CLIENT_PERFORMANCE_COUNTER_NAME_LENGTH = 32;
export const MAX_CLIENT_PERFORMANCE_COUNTER_BYTES = 256;

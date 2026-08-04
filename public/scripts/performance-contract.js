export const CLIENT_PERFORMANCE_COUNTERS = Object.freeze({
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

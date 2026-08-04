const CLIENT_TELEMETRY_JSON_PATH = /^\/api\/performance\/client\/?$/;
const SETTINGS_SAVE_JSON_PATH = /^\/api\/settings\/save\/?$/;
const EXTENSION_STORAGE_WRITE_JSON_PATH = /^\/api\/extensions\/[^/]+\/storage\/[^/]+\/?$/;

/** Returns whether a request must use the telemetry endpoint's 64 KiB JSON parser. */
export function isClientTelemetryJsonPath(requestPath) {
    return typeof requestPath === 'string' && CLIENT_TELEMETRY_JSON_PATH.test(requestPath);
}

/** Returns whether a request must bypass the legacy 500 MiB global JSON parser. */
export function isBoundedJsonPath(requestPath) {
    return typeof requestPath === 'string'
        && (CLIENT_TELEMETRY_JSON_PATH.test(requestPath)
            || SETTINGS_SAVE_JSON_PATH.test(requestPath)
            || EXTENSION_STORAGE_WRITE_JSON_PATH.test(requestPath));
}

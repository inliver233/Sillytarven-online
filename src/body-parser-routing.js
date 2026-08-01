const CLIENT_TELEMETRY_JSON_PATH = /^\/api\/performance\/client\/?$/;

/** Returns whether a request must use the telemetry endpoint's 64 KiB JSON parser. */
export function isClientTelemetryJsonPath(requestPath) {
    return typeof requestPath === 'string' && CLIENT_TELEMETRY_JSON_PATH.test(requestPath);
}

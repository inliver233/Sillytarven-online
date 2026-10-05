/**
 * The /v/<version> prefix the app's modules were loaded under through the import
 * map in index.html (see src/asset-version.js), or '' when the page loads them by
 * their plain URLs (no import map support, or versioned assets disabled).
 */
const VERSION_PREFIX = /^\/v\/[0-9a-f]+(?=\/)/.exec(new URL(import.meta.url).pathname)?.[0] ?? '';

/**
 * URL of an extension's JavaScript module as the import map resolves it. A module
 * loaded by <script src> or a preload hint does not go through the import map, so
 * it must use this URL to be the same instance that other modules import.
 * @param {string} name Extension name (`memory`, `third-party/foo`)
 * @param {string} file File inside the extension folder
 * @returns {string} Module URL
 */
export function getExtensionModuleUrl(name, file) {
    const url = `/scripts/extensions/${name}/${file}`;
    return VERSION_PREFIX && !name.startsWith('third-party/') ? VERSION_PREFIX + url : url;
}

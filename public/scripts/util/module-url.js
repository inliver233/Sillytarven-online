const MODULE_URL = new URL(import.meta.url);
const VERSION_PATH = /^.*?\/v\/[0-9a-f]{6,64}(?=\/)/.exec(MODULE_URL.pathname)?.[0];

/**
 * Popular third-party extensions that the import map sends to the CDN mirror at their commit
 * (set by the page's import map script, see src/asset-version.js): name -> mirror base.
 * @type {Record<string, string>}
 */
const THIRD_PARTY_MIRRORS = globalThis.__stAssetCdn?.thirdParty ?? {};

/**
 * The /v/<version> prefix the app's modules were loaded under through the import
 * map in index.html (see src/asset-version.js), or '' when the page loads them by
 * their plain URLs (no import map support, or versioned assets disabled). When the
 * modules come from a CDN mirror, the prefix is the mirror's full address.
 */
const VERSION_PREFIX = VERSION_PATH
    ? (MODULE_URL.origin === globalThis.location?.origin ? '' : MODULE_URL.origin) + VERSION_PATH
    : '';

/**
 * URL of an extension's file as the import map resolves it (a popular third-party
 * extension may be on the CDN mirror). A module loaded by <script src> or a preload hint
 * does not go through the import map, so it must use this URL to be the same instance
 * that other modules import.
 * @param {string} name Extension name (`memory`, `third-party/foo`)
 * @param {string} file File inside the extension folder
 * @returns {string} Module URL
 */
export function getExtensionModuleUrl(name, file) {
    return getVersionedAssetUrl(`/scripts/extensions/${name}/${file}`);
}

/**
 * URL of a built-in file under /scripts/ (template, manifest, locale, style) under the page's
 * asset version. The plain URL may be served from a CDN cache filled before a deploy:
 * an old extension manifest next to new scripts left built-in extensions inactive.
 * Third-party extensions are not part of the asset version: a popular one on the CDN mirror
 * gets its mirror URL (its files at its commit), any other keeps the plain URL.
 * @param {string} url File URL, with or without the leading slash
 * @returns {string} Versioned URL, or the given URL when it is not a built-in file
 */
export function getVersionedAssetUrl(url) {
    const path = url.startsWith('/') ? url : `/${url}`;
    const thirdParty = /^\/scripts\/extensions\/third-party\/([^/]+)\//.exec(path)?.[1];
    if (thirdParty) {
        const mirror = THIRD_PARTY_MIRRORS[thirdParty];
        return mirror ? mirror + path : url;
    }
    return VERSION_PREFIX && path.startsWith('/scripts/') ? VERSION_PREFIX + path : url;
}

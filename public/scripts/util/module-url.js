/**
 * Versioned URL of each of the app's files by its plain path ("/scripts/x.js" ->
 * "/v/s/scripts/x.js?v=1a2b3c4d", or the same on the CDN mirror), set by the page's
 * import map script (see src/asset-version.js). Empty when the page loads the plain
 * URLs (no import map support, or versioned assets disabled).
 * @type {Record<string, string>}
 */
const ASSET_URLS = globalThis.__stAssets?.urls ?? {};

/**
 * Popular third-party extensions that the import map sends to the CDN mirror at their commit
 * (set by the page's import map script, see src/asset-version.js): name -> mirror base.
 * @type {Record<string, string>}
 */
const THIRD_PARTY_MIRRORS = globalThis.__stAssetCdn?.thirdParty ?? {};

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
 * URL of an extension's stylesheet, the same for the preload hint and the <link> that applies it.
 * Built-in styles carry their version as a query on this server (a path prefix would break the
 * relative font and image URLs inside them); a third-party one may be on the CDN mirror.
 * @param {string} name Extension name
 * @param {string} file Stylesheet inside the extension folder
 * @returns {string} Stylesheet URL
 */
export function getExtensionStyleUrl(name, file) {
    const url = `/scripts/extensions/${name}/${file}`;
    if (name.startsWith('third-party')) {
        return getVersionedAssetUrl(url);
    }
    const version = /[?&]v=([0-9a-f]+)$/.exec(ASSET_URLS[url] ?? '')?.[1];
    return version ? `${url}?v=${version}` : url;
}

/**
 * URL of a built-in file (template, manifest, locale, style, module) at its version. The plain
 * URL may be served from a CDN cache filled before a deploy: an old extension manifest next to
 * new scripts left built-in extensions inactive.
 * Third-party extensions are not versioned with the app: a popular one on the CDN mirror
 * gets its mirror URL (its files at its commit), any other keeps the plain URL.
 * @param {string} url File URL, with or without the leading slash
 * @returns {string} Versioned URL, or the given URL when it is not a versioned file
 */
export function getVersionedAssetUrl(url) {
    const path = url.startsWith('/') ? url : `/${url}`;
    const thirdParty = /^\/scripts\/extensions\/third-party\/([^/]+)\//.exec(path)?.[1];
    if (thirdParty) {
        const mirror = THIRD_PARTY_MIRRORS[thirdParty];
        return mirror ? mirror + path : url;
    }
    return ASSET_URLS[path] ?? url;
}

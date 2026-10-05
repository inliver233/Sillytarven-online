import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Long-lived caching for the app's own modules.
 *
 * Source files are not content-hashed, so they are served with a five-minute
 * freshness window, and every visit after that re-asks for ~300 files one
 * import level at a time. Instead, each deploy gets a version (a digest of the
 * names, sizes and modification times of the files below), and index.html maps
 * module URLs under /v/<version>/ with an import map. Those URLs never change
 * content, so the browser keeps them until the next deploy.
 *
 * - All module loads go through the import map, so every module still has a
 *   single URL (and a single instance) whether it is imported relatively, by
 *   an absolute path, or by a third-party extension.
 * - Third-party extensions are left out: users update them without a deploy.
 * - A browser without import maps loads the plain URLs, as before.
 */

/** URL prefixes (relative to the public folder) served under /v/<version>/. */
const VERSIONED_FILES = ['/script.js', '/lib.js'];
const VERSIONED_FOLDERS = ['/scripts/', '/lib/'];
const UNVERSIONED_FOLDER = '/scripts/extensions/third-party/';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * @param {string} directory Folder to walk
 * @param {(relative: string) => boolean} skip Folders to leave out
 * @param {string[]} out Collected "relative path:size:mtime" entries
 * @param {string} base Folder the relative paths start from
 */
function collectStamps(directory, skip, out, base) {
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        const relative = path.relative(base, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
            if (!skip(relative)) collectStamps(full, skip, out, base);
        } else if (entry.isFile()) {
            const stats = fs.statSync(full);
            out.push(`${relative}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
        }
    }
}

/**
 * Digest of everything served under /v/<version>/.
 * @param {string} publicDirectory The public folder
 * @param {string|null} libFile The compiled lib.js
 * @returns {string} Version
 */
export function computeAssetVersion(publicDirectory, libFile) {
    const stamps = [];
    const skip = relative => relative === 'scripts/extensions/third-party';
    collectStamps(path.join(publicDirectory, 'scripts'), skip, stamps, publicDirectory);
    collectStamps(path.join(publicDirectory, 'lib'), skip, stamps, publicDirectory);
    for (const file of [path.join(publicDirectory, 'script.js'), libFile]) {
        try {
            if (file) {
                const stats = fs.statSync(file);
                stamps.push(`${path.basename(file)}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
            }
        } catch {
            // A missing file is part of the version too.
        }
    }
    stamps.sort();
    return crypto.createHash('sha256').update(stamps.join('\n')).digest('hex').slice(0, 12);
}

/**
 * @param {string} urlPath Path of a file in the public folder (starts with "/")
 * @returns {boolean} Whether it may be served under /v/<version>/
 */
export function isVersionedPath(urlPath) {
    if (urlPath.startsWith(UNVERSIONED_FOLDER) || urlPath.split('/').includes('..')) {
        return false;
    }
    return VERSIONED_FILES.includes(urlPath) || VERSIONED_FOLDERS.some(folder => urlPath.startsWith(folder));
}

const MODULE_SCRIPT_PATTERN = /<script type="module" src="([^"]+)"><\/script>/g;

/**
 * Adds the import map to index.html and loads its module scripts through it.
 * Returns null when the page does not have the expected shape, so the caller
 * serves it unchanged.
 * @param {string} html index.html
 * @param {{version: string}} options Version
 * @returns {string|null} Page
 */
export function transformAppHtml(html, { version }) {
    if (!/^[0-9a-f]{6,64}$/.test(version) || !html.includes('</head>') || html.includes('type="importmap"')) {
        return null;
    }
    // A module loaded by <script src> does not go through the import map, so it
    // would get a second instance next to the mapped one. Import them instead.
    const page = html.replace(MODULE_SCRIPT_PATTERN, (_, src) => `<script type="module">import ${JSON.stringify(new URL(src, 'http://app/').pathname)};</script>`);
    if (/<script\b(?=[^>]*\btype\s*=\s*["']?module\b)(?=[^>]*\bsrc\s*=)[^>]*>/i.test(page)) {
        return null;
    }
    const prefix = `/v/${version}`;
    const imports = Object.fromEntries([
        ...VERSIONED_FILES.map(file => [file, `${prefix}${file}`]),
        ...VERSIONED_FOLDERS.map(folder => [folder, `${prefix}${folder}`]),
        [UNVERSIONED_FOLDER, UNVERSIONED_FOLDER],
    ]);
    return page.replace('</head>', `    <script type="importmap">${JSON.stringify({ imports })}</script>\n</head>`);
}

/**
 * Serves /v/<version>/<path> as <path>, with a long-lived cache for the current
 * version. A request for another version (a tab opened before a deploy) gets the
 * current file without caching, as the plain URL would.
 * @param {() => string|null} getVersion Current version
 * @returns {import('express').RequestHandler}
 */
export function createVersionedAssetsMiddleware(getVersion) {
    return (request, response, next) => {
        if (!request.path.startsWith('/v/') || (request.method !== 'GET' && request.method !== 'HEAD')) {
            return next();
        }
        const match = /^\/v\/([0-9a-f]{6,64})(\/.*)$/.exec(request.path);
        if (!match || !isVersionedPath(match[2])) {
            return response.sendStatus(404);
        }
        response.locals.versionedAsset = true;
        response.locals.versionedAssetCacheControl = match[1] === getVersion() ? IMMUTABLE_CACHE_CONTROL : 'no-store';
        const query = request.url.indexOf('?');
        request.url = match[2] + (query >= 0 ? request.url.slice(query) : '');
        return next();
    };
}

/**
 * @param {import('express').Response} response Response
 * @returns {string|null} Cache-Control for a versioned asset, or null for a plain request
 */
export function getVersionedAssetCacheControl(response) {
    return response.locals?.versionedAsset ? response.locals.versionedAssetCacheControl : null;
}

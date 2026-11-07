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
    collectStamps(path.join(publicDirectory, 'css'), skip, stamps, publicDirectory);
    for (const file of [path.join(publicDirectory, 'script.js'), path.join(publicDirectory, 'style.css'), libFile]) {
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
 * @param {{version: string, cdn?: {baseUrl: string, timeZones: string[]}|null}} options Version,
 * and a CDN mirror of /v/ for pages opened in the given time zones (see getAssetCdnScript)
 * @returns {string|null} Page
 */
export function transformAppHtml(html, { version, cdn = null }) {
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
    // Stylesheets get the version as a query: a path prefix would break the relative font and
    // image URLs inside them, while a query only changes the cache key, so a deploy reaches
    // browsers and the CDN at once instead of after their max-age.
    const styled = page.replace(/<link\b[^>]*>/gi, (tag) => {
        if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) return tag;
        return tag.replace(/\bhref\s*=\s*(["'])([^"']+)\1/i, (attribute, quote, href) => {
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/v\/|#)/i.test(href)) return attribute;
            return `href=${quote}${href}${href.includes('?') ? '&' : '?'}v=${version}${quote}`;
        });
    });
    const imports = Object.fromEntries([
        ...VERSIONED_FILES.map(file => [file, `${prefix}${file}`]),
        ...VERSIONED_FOLDERS.map(folder => [folder, `${prefix}${folder}`]),
        [UNVERSIONED_FOLDER, UNVERSIONED_FOLDER],
    ]);
    const importMap = cdn
        ? getAssetCdnScript(imports, cdn)
        : `<script type="importmap">${JSON.stringify({ imports })}</script>`;
    // A function, so "$'" or "$&" in the script is not read as a replacement pattern.
    return styled.replace('</head>', () => `    ${importMap}\n</head>`);
}

/**
 * Checks the configured CDN mirror address.
 * @param {unknown} value Base URL, e.g. https://static.example.cn or https://cdn.example.cn/st
 * @returns {string|null} The address without a trailing slash, or null when it is not usable
 */
export function normalizeAssetCdnBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) return null;
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return null;
    }
}

/**
 * The import map for a page that may load the app's modules from a CDN mirror of /v/
 * (e.g. a domain whose DNS sends mainland China to a local CDN and everyone else to
 * Cloudflare). The page is the same for every visitor, so a cache in front of it cannot
 * mix up visitors. With time zones listed, only browsers in them use the mirror; with
 * none, every browser does. Absolute imports inside mirrored modules resolve against the mirror, so they are
 * mapped too. If a module cannot be loaded from the mirror (down, or no CORS), the page tries
 * it once more and then loads everything from this server for half an hour (see fail()).
 * localStorage "st-asset-cdn" = "on" / "off" overrides the choice.
 * @param {Record<string, string>} imports Import map entries for this server
 * @param {{baseUrl: string, timeZones: string[]}} cdn Mirror address, and the time zones that use it (empty = all)
 * @returns {string} Inline script that adds the import map
 */
function getAssetCdnScript(imports, cdn) {
    const origin = new URL(cdn.baseUrl).origin;
    // thirdParty is filled in per user when the page is sent (popular extensions, see extension-cdn.js).
    const options = JSON.stringify({ imports, cdn: cdn.baseUrl, origin, zones: cdn.timeZones, thirdParty: [] }).replace(/</g, '\\u003c');
    return `<script>(function (o) {
        var KEY = 'st-asset-cdn-failed', PAUSE = 30 * 60e3, use = false, map = document.createElement('script'), mapped = {};
        var failure = { at: 0, count: 0 };
        try {
            var choice = localStorage.getItem('st-asset-cdn');
            var saved = JSON.parse(localStorage.getItem(KEY) || 'null');
            // A bare timestamp is the old format: a confirmed failure.
            if (typeof saved === 'number') failure = { at: saved, count: 2 };
            else if (saved) failure = { at: Number(saved.at) || 0, count: Number(saved.count) || 0 };
            var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            var inZone = o.zones.length === 0 || o.zones.indexOf(zone) !== -1;
            var paused = failure.count >= 2 && Date.now() - failure.at < PAUSE;
            use = choice === 'on' || (choice !== 'off' && inZone && !paused);
        } catch (e) { use = false; }
        Object.keys(o.imports).forEach(function (key) {
            var versioned = o.imports[key].indexOf('/v/') === 0;
            mapped[key] = use && versioned ? o.cdn + o.imports[key] : o.imports[key];
            // A module from the mirror resolves an absolute import ("/scripts/x.js") against the mirror.
            if (use) mapped[o.origin + key] = versioned ? o.cdn + o.imports[key] : location.origin + o.imports[key];
        });
        if (use) {
            // Popular third-party extensions at their commit on the mirror. Inside one, a relative
            // import ("../../../extensions.js") resolves under its mirror folder and is sent on to
            // the app's own module, to another mirrored extension, or to this server.
            var thirdParty = {}, prefix = '/scripts/extensions/third-party/';
            (o.thirdParty || []).forEach(function (ext) { thirdParty[ext.name] = o.cdn + '/v/e/' + ext.sha; });
            Object.keys(thirdParty).forEach(function (name) {
                mapped[prefix + name + '/'] = thirdParty[name] + prefix + name + '/';
                mapped[o.origin + prefix + name + '/'] = thirdParty[name] + prefix + name + '/';
            });
            Object.keys(thirdParty).forEach(function (name) {
                var base = thirdParty[name];
                Object.keys(o.imports).forEach(function (key) {
                    if (key.charAt(0) === '/') mapped[base + key] = mapped[key];
                });
                Object.keys(thirdParty).forEach(function (other) {
                    mapped[base + prefix + other + '/'] = mapped[prefix + other + '/'];
                });
            });
            window.__stAssetCdn = { thirdParty: thirdParty };
            // A worker must come from the page's own origin. One created from a mirrored module
            // ("new URL('./x.worker.js', import.meta.url)") gets the same file from this server.
            var toLocal = function (url) {
                var href = String(url && url.href ? url.href : url);
                if (href.indexOf(o.cdn + '/') !== 0) return url;
                var rest = href.slice(o.cdn.length), own = new RegExp('^/v/e/[0-9a-f]{40}(/.*)$').exec(rest);
                return location.origin + (own ? own[1] : rest);
            };
            ['Worker', 'SharedWorker'].forEach(function (name) {
                var Native = window[name];
                if (typeof Native !== 'function') return;
                var Local = function (url, options) { return new Native(toLocal(url), options); };
                Local.prototype = Native.prototype;
                window[name] = Local;
            });
            // The app's modules failing before it starts: reload and try the mirror once more, then
            // (a second failure within a minute) load from this server for half an hour. A module
            // failing later only pauses the mirror from the next page on. The last failure is kept
            // for diagnosis.
            var fail = function (beforeStart, what) {
                var now = Date.now();
                var count = beforeStart ? (now - failure.at < 60e3 ? failure.count + 1 : 1) : 2;
                try {
                    localStorage.setItem(KEY, JSON.stringify({ at: now, count: count, what: String(what || '').slice(0, 300) }));
                } catch (e) { return; }
                console.warn('Could not load the app from the CDN mirror' + (count >= 2 ? '; using this server for a while.' : '; trying again.'), what);
                if (beforeStart && !window.SillyTavern) location.reload();
            };
            addEventListener('error', function (event) {
                var target = event.target;
                if (target && target.tagName === 'SCRIPT' && (!target.src || target.src.indexOf(o.cdn) === 0)) fail(true, target.src || 'app modules');
            }, true);
            addEventListener('unhandledrejection', function (event) {
                var reason = event.reason && (event.reason.message || String(event.reason));
                if (typeof reason === 'string' && reason.indexOf(o.cdn) !== -1) fail(false, reason);
            });
        }
        map.type = 'importmap';
        map.textContent = JSON.stringify({ imports: mapped });
        document.currentScript.after(map);
    })(${options});</script>`;
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
        // Public files that a CDN mirror may serve to the app's page from another origin:
        // a cross-origin module or fetch needs CORS, which the mirror keeps from this response.
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Long-lived caching for the app's own files.
 *
 * Source files are not content-hashed, so they are served with a five-minute
 * freshness window, and every visit after that re-asks for ~300 modules one
 * import level at a time. Instead, each file gets its own version (from its
 * size and modification time), and the page loads it as
 * /v/s/<path>?v=<version> through an import map. That URL never changes
 * content, so the browser keeps the file, and the compiled code V8 caches for
 * it, until a deploy changes that file; the files a deploy leaves alone keep
 * their URLs and stay cached.
 *
 * - The path stays the plain one under /v/s/, so a relative import inside a
 *   module ("./utils.js") resolves to a /v/s/ URL that the import map sends on
 *   to that file's version. The page builds the map from the list of versions.
 * - All module loads go through the import map, so every module still has a
 *   single URL (and a single instance) whether it is imported relatively, by
 *   an absolute path, or by a third-party extension.
 * - Third-party extensions are left out: users update them without a deploy.
 * - A browser without import maps loads the plain URLs, as before.
 */

/** URL prefixes (relative to the public folder) served under /v/. */
const VERSIONED_FILES = ['/script.js', '/lib.js'];
const VERSIONED_FOLDERS = ['/scripts/', '/lib/', '/locales/'];
const UNVERSIONED_FOLDER = '/scripts/extensions/third-party/';
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** The page addresses these by version: modules, templates, manifests, locales, extension styles. */
const ADDRESSED_FILE_PATTERN = /\.(?:m?js|html|json|css)$/;
const MODULE_FILE_PATTERN = /\.m?js$/;
const FILE_VERSION_PATTERN = /^[0-9a-f]{8}$/;
/** Entry modules of index.html; their static imports are what the page needs before it starts. */
const ENTRY_MODULES = ['lib/structured-clone/monkey-patch.js', 'lib/swiped-events.js', 'lib/eventemitter.js', 'scripts/i18n.js', 'script.js'];

/**
 * @param {number} size File size
 * @param {number} mtimeMs Modification time
 * @returns {string} The file's version: a changed or rewritten (even reverted) file gets a new one
 */
function getFileVersion(size, mtimeMs) {
    return crypto.createHash('sha256').update(`${size}:${Math.trunc(mtimeMs)}`).digest('hex').slice(0, 8);
}

/**
 * @param {string} directory Folder to walk
 * @param {(relative: string) => boolean} skip Folders to leave out
 * @param {Map<string, string>} out Relative path -> file version
 * @param {string} base Folder the relative paths start from
 */
function collectVersions(directory, skip, out, base) {
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
            if (!skip(relative)) collectVersions(full, skip, out, base);
        } else if (entry.isFile()) {
            const stats = fs.statSync(full);
            out.set(relative, getFileVersion(stats.size, stats.mtimeMs));
        }
    }
}

/**
 * @typedef {object} AssetManifest
 * @property {string} version Digest of everything below, for caching the page
 * @property {Record<string, string>} files Version of each file the page addresses by version
 * (path relative to the public folder, without the leading slash)
 * @property {Record<string, string>} styles Version of each stylesheet the page links
 */

/**
 * Versions of the files served under /v/ and of the page's stylesheets.
 * @param {string} publicDirectory The public folder
 * @param {string|null} libFile The compiled lib.js
 * @returns {AssetManifest}
 */
export function computeAssetManifest(publicDirectory, libFile) {
    const served = new Map();
    const skip = relative => relative === 'scripts/extensions/third-party';
    for (const folder of ['scripts', 'lib', 'locales']) {
        collectVersions(path.join(publicDirectory, folder), skip, served, publicDirectory);
    }
    const styles = new Map();
    collectVersions(path.join(publicDirectory, 'css'), skip, styles, publicDirectory);
    collectVersions(path.join(publicDirectory, 'webfonts'), skip, styles, publicDirectory);
    for (const [name, file, into] of [['script.js', path.join(publicDirectory, 'script.js'), served], ['lib.js', libFile, served], ['style.css', path.join(publicDirectory, 'style.css'), styles]]) {
        try {
            if (file) {
                const stats = fs.statSync(file);
                into.set(name, getFileVersion(stats.size, stats.mtimeMs));
            }
        } catch {
            // A missing file is simply not versioned.
        }
    }
    const files = Object.fromEntries([...served].filter(([name]) => ADDRESSED_FILE_PATTERN.test(name)).sort(([a], [b]) => a < b ? -1 : 1));
    const styleVersions = Object.fromEntries([...styles].filter(([name]) => name.endsWith('.css')).sort(([a], [b]) => a < b ? -1 : 1));
    const digest = crypto.createHash('sha256');
    for (const [name, version] of [...served, ...styles].sort(([a], [b]) => a < b ? -1 : 1)) digest.update(`${name}:${version}\n`);
    return { version: digest.digest('hex').slice(0, 12), files, styles: styleVersions };
}

// Static `import ... from './x.js'`, `import '/x.js'` and `export ... from '../x.js'`.
// Dynamic import() is lazy by design and left alone.
const STATIC_IMPORT_PATTERN = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])((?:\.{1,2})?\/[^'"\n]+?)\1/g;
/** @type {Map<string, {version: string, imports: string[]}>} */
const importCache = new Map();

/**
 * The app's modules that the page imports before it starts (the static imports of its entry
 * modules, directly or not). Requested together at once, they do not wait for each other one
 * import level at a time.
 * @param {string} publicDirectory The public folder
 * @param {string|null} libFile The compiled lib.js
 * @param {AssetManifest} manifest Current versions
 * @returns {string[]} Paths relative to the public folder
 */
export function getStartupModules(publicDirectory, libFile, manifest) {
    const seen = new Set();
    const queue = ENTRY_MODULES.filter(name => manifest.files[name]);
    while (queue.length) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        seen.add(name);
        let cached = importCache.get(name);
        if (cached?.version !== manifest.files[name]) {
            let source = '';
            try {
                source = fs.readFileSync(name === 'lib.js' ? String(libFile) : path.join(publicDirectory, ...name.split('/')), 'utf8');
            } catch {
                // Gone since the manifest was made: nothing to follow.
            }
            const imports = new Set();
            for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
                const target = new URL(match[2], `http://app/${name}`).pathname.slice(1);
                if (MODULE_FILE_PATTERN.test(target)) imports.add(target);
            }
            cached = { version: manifest.files[name], imports: [...imports] };
            importCache.set(name, cached);
        }
        for (const target of cached.imports) {
            if (manifest.files[target] && !seen.has(target)) queue.push(target);
        }
    }
    return [...seen];
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
 * Puts a snippet at the start of the page's head (right after its charset), before the
 * stylesheets: an inline script after them waits until they have all loaded.
 * @param {string} html Page
 * @param {string} snippet Markup to insert
 * @returns {string} Page
 */
export function insertAtHeadStart(html, snippet) {
    const head = /<head\b[^>]*>/i.exec(html);
    const charset = /<meta\s+charset\s*=[^>]*>/i.exec(html);
    const headEnd = html.indexOf('</head>');
    const at = charset && charset.index < headEnd ? charset.index + charset[0].length : head ? head.index + head[0].length : headEnd;
    if (at < 0) return html;
    return `${html.slice(0, at)}\n    ${snippet}${html.slice(at)}`;
}

/**
 * Adds the import map to index.html and loads its module scripts through it.
 * Returns null when the page does not have the expected shape, so the caller
 * serves it unchanged.
 * @param {string} html index.html
 * @param {{manifest: AssetManifest, preload?: string[], cdn?: {baseUrl: string, timeZones: string[]}|null}} options
 * File versions, the modules to request up front (see getStartupModules), and a CDN mirror
 * of /v/ for pages opened in the given time zones (see getAssetScript)
 * @returns {string|null} Page
 */
export function transformAppHtml(html, { manifest, preload = [], cdn = null }) {
    if (!manifest || !/^[0-9a-f]{6,64}$/.test(manifest.version) || !html.includes('</head>') || html.includes('type="importmap"') || html.includes('__stAssets')) {
        return null;
    }
    // A module loaded by <script src> does not go through the import map, so it
    // would get a second instance next to the mapped one. Import them instead.
    const page = html.replace(MODULE_SCRIPT_PATTERN, (_, src) => `<script type="module">import ${JSON.stringify(new URL(src, 'http://app/').pathname)};</script>`);
    if (/<script\b(?=[^>]*\btype\s*=\s*["']?module\b)(?=[^>]*\bsrc\s*=)[^>]*>/i.test(page)) {
        return null;
    }
    // Stylesheets (and their preload hints, so both are one request) get their version as a
    // query: a path prefix would break the relative font and image URLs inside them, while a
    // query only changes the cache key, so a deploy reaches browsers and the CDN at once
    // instead of after their max-age.
    const styled = page.replace(/<link\b[^>]*>/gi, (tag) => {
        const stylesheet = /\brel\s*=\s*["']?stylesheet\b/i.test(tag);
        const stylePreload = /\brel\s*=\s*["']?preload\b/i.test(tag) && /\bas\s*=\s*["']?style\b/i.test(tag);
        if (!stylesheet && !stylePreload) return tag;
        return tag.replace(/\bhref\s*=\s*(["'])([^"']+)\1/i, (attribute, quote, href) => {
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/v\/|#)/i.test(href)) return attribute;
            const version = manifest.styles?.[new URL(href, 'http://app/').pathname.slice(1)] ?? manifest.version;
            return `href=${quote}${href}${href.includes('?') ? '&' : '?'}v=${version}${quote}`;
        });
    });
    // Classic scripts (jQuery and friends) the same way: they hold up the page while it parses.
    const scripted = styled.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi, (tag, quote, src) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/v\/)/i.test(src) || src.includes('?')) return tag;
        const version = manifest.files[new URL(src, 'http://app/').pathname.slice(1)];
        return version ? tag.replace(`${quote}${src}${quote}`, () => `${quote}${src}?v=${version}${quote}`) : tag;
    });
    return insertAtHeadStart(scripted, getAssetScript(manifest, preload, cdn));
}

/**
 * Cache-Control for a file requested by its plain URL with a version query (stylesheets and
 * classic scripts in the page, built-in extension styles): kept for good when it is the file's
 * current version, since that URL then never changes content.
 * @param {AssetManifest} manifest Current versions
 * @param {string} relativePath File path relative to the public folder (POSIX)
 * @param {unknown} version The "v" query of the request
 * @returns {string|null} Cache-Control, or null to keep the usual one
 */
export function getQueryVersionCacheControl(manifest, relativePath, version) {
    if (typeof version !== 'string' || !FILE_VERSION_PATTERN.test(version)) return null;
    return version === (manifest.styles[relativePath] ?? manifest.files[relativePath]) ? IMMUTABLE_CACHE_CONTROL : null;
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
 * The import map, built in the browser from the file versions: each module is mapped under
 * every URL it can be imported by (plain absolute path, relative import inside a versioned
 * module, the same from the mirror), so it keeps a single instance. Then the modules the page
 * starts with are requested together, instead of one import level at a time.
 *
 * With a CDN mirror of /v/ (e.g. a domain whose DNS sends mainland China to a local CDN and
 * everyone else to Cloudflare), the page is the same for every visitor, so a cache in front of
 * it cannot mix up visitors. With time zones listed, only browsers in them use the mirror; with
 * none, every browser does. If a module cannot be loaded from the mirror (down, or no CORS),
 * the page tries it once more and then loads everything from this server for half an hour
 * (see fail()). localStorage "st-asset-cdn" = "on" / "off" overrides the choice.
 * @param {AssetManifest} manifest File versions
 * @param {string[]} preload Modules to request up front
 * @param {{baseUrl: string, timeZones: string[]}|null} cdn Mirror address, and the time zones that use it (empty = all)
 * @returns {string} Inline script that adds the import map
 */
function getAssetScript(manifest, preload, cdn) {
    // thirdParty is filled in per user when the page is sent (popular extensions, see extension-cdn.js).
    const options = JSON.stringify({
        files: manifest.files,
        preload: preload.filter(name => manifest.files[name]),
        cdn: cdn?.baseUrl ?? '',
        origin: cdn ? new URL(cdn.baseUrl).origin : '',
        zones: cdn?.timeZones ?? [],
        thirdParty: [],
    }).replace(/</g, '\\u003c');
    return `<script>(function (o) {
        // Without import maps every module keeps its plain URL, so nothing may use the versioned ones.
        if (!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap'))) {
            window.__stAssets = { urls: {} };
            return;
        }
        var KEY = 'st-asset-cdn-failed', PAUSE = 30 * 60e3, THIRD = '/scripts/extensions/third-party/', use = false;
        var failure = { at: 0, count: 0 };
        if (o.cdn) {
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
        }
        var base = use ? o.cdn : '', urls = {}, mapped = {}, modules = [];
        Object.keys(o.files).forEach(function (path) {
            urls['/' + path] = base + '/v/s/' + path + '?v=' + o.files[path];
            if (/\\.m?js$/.test(path)) modules.push(path);
        });
        // Every URL a module can be imported by leads to the same versioned URL.
        var mapAll = function (prefix) {
            modules.forEach(function (path) { mapped[prefix + path] = urls['/' + path]; });
        };
        mapAll('/');
        mapAll('/v/s/');
        mapped[THIRD] = THIRD;
        if (use) {
            // A module from the mirror resolves a relative import under the mirror's /v/s/, and an
            // absolute one ("/scripts/x.js") against the mirror's root.
            mapAll(o.cdn + '/v/s/');
            mapAll(o.origin + '/');
            mapped[o.origin + THIRD] = location.origin + THIRD;
            // Popular third-party extensions at their commit on the mirror. Inside one, a relative
            // import ("../../../extensions.js") resolves under its mirror folder and is sent on to
            // the app's own module, to another mirrored extension, or to this server.
            var thirdParty = {};
            (o.thirdParty || []).forEach(function (ext) { thirdParty[ext.name] = o.cdn + '/v/e/' + ext.sha; });
            Object.keys(thirdParty).forEach(function (name) {
                mapped[THIRD + name + '/'] = thirdParty[name] + THIRD + name + '/';
                mapped[o.origin + THIRD + name + '/'] = thirdParty[name] + THIRD + name + '/';
            });
            Object.keys(thirdParty).forEach(function (name) {
                var mirror = thirdParty[name];
                mapAll(mirror + '/');
                mapped[mirror + THIRD] = location.origin + THIRD;
                Object.keys(thirdParty).forEach(function (other) {
                    mapped[mirror + THIRD + other + '/'] = mapped[THIRD + other + '/'];
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
        // Versioned URL of each file by its plain path, for templates, styles and the like (see module-url.js).
        window.__stAssets = { urls: urls };
        var map = document.createElement('script'), last = map;
        map.type = 'importmap';
        map.textContent = JSON.stringify({ imports: mapped });
        document.currentScript.after(map);
        o.preload.forEach(function (path) {
            var link = document.createElement('link');
            link.rel = 'modulepreload';
            link.href = urls['/' + path];
            last.after(link);
            last = link;
        });
    })(${options});</script>`;
}

/**
 * Serves /v/s/<path>?v=<version> as <path>, with a long-lived cache when the version is the
 * file's current one. Another version (a tab opened before a deploy), or the old
 * /v/<version>/<path> form, gets the current file without caching, as the plain URL would.
 * A /v/s/ URL without a version (a file a module finds next to itself through
 * import.meta.url) is sent to the plain URL: a CDN keeps whatever is under /v/ for a year.
 * @param {() => AssetManifest} getManifest Current versions
 * @returns {import('express').RequestHandler}
 */
export function createVersionedAssetsMiddleware(getManifest) {
    return (request, response, next) => {
        if (!request.path.startsWith('/v/') || (request.method !== 'GET' && request.method !== 'HEAD')) {
            return next();
        }
        const stable = /^\/v\/s(\/.*)$/.exec(request.path);
        const legacy = stable ? null : /^\/v\/[0-9a-f]{6,64}(\/.*)$/.exec(request.path);
        const file = stable?.[1] ?? legacy?.[1];
        if (!file || !isVersionedPath(file)) {
            return response.sendStatus(404);
        }
        const query = request.url.indexOf('?');
        const search = query >= 0 ? request.url.slice(query) : '';
        const wanted = new URLSearchParams(search).get('v');
        if (stable && !wanted) {
            // Through the CDN the Host is the site's own (the CDN's origin sets it), so this
            // leaves the CDN for the site.
            const host = String(request.headers?.host ?? '');
            response.setHeader('Cache-Control', 'no-store');
            return response.redirect(302, /^[\w.-]+(?::\d+)?$/.test(host) ? `//${host}${file}` : file);
        }
        const current = getManifest().files[file.slice(1)];
        response.locals.versionedAsset = true;
        response.locals.versionedAssetCacheControl = stable && FILE_VERSION_PATTERN.test(wanted) && wanted === current ? IMMUTABLE_CACHE_CONTROL : 'no-store';
        // Public files that a CDN mirror may serve to the app's page from another origin:
        // a cross-origin module or fetch needs CORS, which the mirror keeps from this response.
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        request.url = file + search;
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

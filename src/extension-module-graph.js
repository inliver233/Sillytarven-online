import fs from 'node:fs';
import path from 'node:path';

import { PUBLIC_DIRECTORIES } from './constants.js';

/**
 * The JavaScript files an extension's entry module imports, directly or not,
 * from its own folder. Extensions are activated one by one, and a module's
 * imports are only requested once it loads, so each level of imports costs a
 * network round trip in turn. Knowing the files up front lets the client
 * request them all at once while the activation order stays the same.
 */

const MAX_FILES_PER_EXTENSION = 150;
const MAX_PARSED_FILE_BYTES = 8 * 1024 * 1024;
const RESULT_TTL_MS = 30_000;
const MAX_CACHED_FILES = 5000;
const MAX_CACHED_RESULTS = 2000;

// Static `import ... from './x.js'`, `import './x.js'` and `export ... from './x.js'`,
// also minified. Dynamic import() is lazy by design and left alone. A false
// match costs at most one unneeded preload of a file that exists.
const RELATIVE_IMPORT_PATTERN = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?(['"])(\.{1,2}\/[^'"\n]+?)\1/g;

/** @type {Map<string, {mtimeMs: number, size: number, specifiers: string[]}>} */
const fileCache = new Map();
/** @type {Map<string, {at: number, files: string[]}>} */
const resultCache = new Map();

/**
 * @param {string} source Module source
 * @returns {string[]} Relative specifiers of its static imports
 */
export function findRelativeImports(source) {
    const specifiers = new Set();
    for (const match of String(source).matchAll(RELATIVE_IMPORT_PATTERN)) {
        specifiers.add(match[2]);
    }
    return [...specifiers];
}

function remember(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) {
        map.delete(map.keys().next().value);
    }
}

/**
 * Finds a file of the extension the way the static routes serve it: the first root that has it.
 * @param {string[]} roots Extension folders, in lookup order
 * @param {string} relativePath Path inside the extension (POSIX)
 * @returns {Promise<{file: string, stats: fs.Stats}|null>}
 */
async function resolveExtensionFile(roots, relativePath) {
    for (const root of roots) {
        const file = path.resolve(root, ...relativePath.split('/'));
        if (!file.startsWith(path.resolve(root) + path.sep)) {
            continue;
        }
        try {
            const stats = await fs.promises.stat(file);
            if (stats.isFile()) {
                return { file, stats };
            }
        } catch {
            // Try the next root.
        }
    }
    return null;
}

async function readImports(file, stats) {
    const cached = fileCache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        return cached.specifiers;
    }
    const specifiers = stats.size > MAX_PARSED_FILE_BYTES
        ? []
        : findRelativeImports(await fs.promises.readFile(file, 'utf8'));
    remember(fileCache, file, { mtimeMs: stats.mtimeMs, size: stats.size, specifiers }, MAX_CACHED_FILES);
    return specifiers;
}

/**
 * @param {string} from Importing module, relative to the extension folder
 * @param {string} specifier Relative import specifier
 * @returns {string|null} Imported module relative to the extension folder, or null outside it
 */
function resolveSpecifier(from, specifier) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier.split(/[?#]/, 1)[0]));
    if (target.startsWith('../') || target === '..' || path.posix.isAbsolute(target) || !/\.m?js$/i.test(target)) {
        return null;
    }
    return target;
}

/**
 * @param {string} name Extension name as discovered (`memory`, `third-party/foo`)
 * @param {string} userExtensionsDirectory The user's extensions folder
 * @returns {string[]|null} Folders to look in, or null for an invalid name
 */
function getExtensionRoots(name, userExtensionsDirectory) {
    const thirdParty = /^third-party\/([^/\\]+)$/.exec(name);
    if (thirdParty) {
        const folder = thirdParty[1];
        if (folder === '.' || folder === '..') return null;
        return [path.join(userExtensionsDirectory, folder), path.join(PUBLIC_DIRECTORIES.globalExtensions, folder)];
    }
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..' || name === 'third-party') {
        return null;
    }
    return [path.join(PUBLIC_DIRECTORIES.extensions, name)];
}

/**
 * @param {string[]} roots Extension folders
 * @returns {Promise<string[]>} Files imported by the entry module (entry excluded)
 */
async function collectExtensionModules(roots) {
    const manifestFile = await resolveExtensionFile(roots, 'manifest.json');
    if (!manifestFile) return [];
    let entry;
    try {
        entry = JSON.parse(await fs.promises.readFile(manifestFile.file, 'utf8'))?.js;
    } catch {
        return [];
    }
    if (typeof entry !== 'string' || !entry.trim()) return [];
    entry = path.posix.normalize(entry.trim().replace(/\\/g, '/').replace(/^\.\//, ''));
    if (entry.startsWith('../') || path.posix.isAbsolute(entry)) return [];

    const files = [];
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length && files.length < MAX_FILES_PER_EXTENSION) {
        const current = queue.shift();
        const resolved = await resolveExtensionFile(roots, current);
        if (!resolved) continue;
        if (current !== entry) files.push(current);
        for (const specifier of await readImports(resolved.file, resolved.stats)) {
            const target = resolveSpecifier(current, specifier);
            if (target && !seen.has(target)) {
                seen.add(target);
                queue.push(target);
            }
        }
    }
    return files;
}

/**
 * @param {string[]} names Extension names
 * @param {string} userExtensionsDirectory The user's extensions folder
 * @returns {Promise<Record<string, string[]>>} Imported files per extension, relative to its folder
 */
export async function getExtensionModuleGraph(names, userExtensionsDirectory) {
    const now = Date.now();
    const unique = [...new Set(names.filter(name => typeof name === 'string'))].slice(0, 300);
    const entries = await Promise.all(unique.map(async name => {
        const roots = getExtensionRoots(name, userExtensionsDirectory);
        if (!roots) return [name, []];
        const key = roots.join('\0');
        const cached = resultCache.get(key);
        if (cached && now - cached.at < RESULT_TTL_MS) {
            return [name, cached.files];
        }
        const files = await collectExtensionModules(roots);
        remember(resultCache, key, { at: now, files }, MAX_CACHED_RESULTS);
        return [name, files];
    }));
    return Object.fromEntries(entries.filter(([, files]) => files.length > 0));
}

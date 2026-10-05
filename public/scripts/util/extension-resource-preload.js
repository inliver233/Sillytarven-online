import { getExtensionModuleUrl } from './module-url.js';

const DEFAULT_MAX_PRELOADS = 64;
const DEFAULT_MAX_MODULE_PRELOADS = 400;
export const EXTENSION_RESOURCE_PRELOAD_MIGRATION_VERSION = 1;

/**
 * Enables resource preloading once for settings created before it became the default.
 * The migration marker preserves later user opt-outs.
 *
 * @param {object} powerUserSettings Saved power user settings.
 * @returns {boolean} Whether the settings were migrated.
 */
export function migrateExtensionResourcePreloadSettings(powerUserSettings) {
    if (!powerUserSettings || typeof powerUserSettings !== 'object' || Array.isArray(powerUserSettings)) {
        return false;
    }

    const migrationVersion = Number(powerUserSettings.extension_resource_preload_migration_version) || 0;
    if (migrationVersion >= EXTENSION_RESOURCE_PRELOAD_MIGRATION_VERSION) {
        return false;
    }

    powerUserSettings.extension_resource_preload = true;
    powerUserSettings.extension_resource_preload_migration_version = EXTENSION_RESOURCE_PRELOAD_MIGRATION_VERSION;
    return true;
}

function createDisposer(links) {
    let disposed = false;
    const dispose = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const link of links.splice(0)) {
            try {
                link?.remove?.();
            } catch {
                // Resource hints are disposable and must not affect extension activation.
            }
        }
    };
    return { dispose, isDisposed: () => disposed };
}

/**
 * Add passive preload hints for extension JavaScript and styles without executing either resource.
 * @param {Record<string, object>} manifests Extension manifests keyed by extension name
 * @param {object} [options] Preload options
 * @param {string[]|Set<string>} [options.excludedExtensions] Extensions that must not be preloaded
 * @param {string[]|Set<string>} [options.eligibleExtensions] Extensions that passed activation eligibility
 * @param {number} [options.maxPreloads] Maximum number of resource hints to add
 * @param {number} [options.maxModulePreloads] Maximum number of imported-module hints added by preloadModules()
 * @param {Document} [options.documentRef] Document used to create resource hints
 * @returns {{count: number, dispose: () => void, preloadModules: (moduleGraph: Record<string, string[]>|null) => number}}
 *   Preload count, idempotent cleanup callback, and a way to add the modules each extension imports
 */
export function preloadExtensionResources(manifests, {
    excludedExtensions = [],
    eligibleExtensions = null,
    maxPreloads = DEFAULT_MAX_PRELOADS,
    maxModulePreloads = DEFAULT_MAX_MODULE_PRELOADS,
    documentRef = globalThis.document,
} = {}) {
    if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) {
        throw new TypeError('Extension manifests must be an object.');
    }
    if (!Array.isArray(excludedExtensions) && !(excludedExtensions instanceof Set)) {
        throw new TypeError('Excluded extensions must be an array or Set.');
    }
    if (eligibleExtensions !== null && !Array.isArray(eligibleExtensions) && !(eligibleExtensions instanceof Set)) {
        throw new TypeError('Eligible extensions must be an array or Set.');
    }

    const requestedLimit = Number(maxPreloads);
    if (!Number.isFinite(requestedLimit) || requestedLimit < 0) {
        throw new TypeError('maxPreloads must be a non-negative finite number.');
    }
    if (typeof documentRef?.createElement !== 'function' || typeof documentRef?.head?.appendChild !== 'function') {
        throw new TypeError('A document with a writable head is required.');
    }

    const excluded = new Set(excludedExtensions);
    const eligible = eligibleExtensions === null ? null : new Set(eligibleExtensions);
    const limit = Math.floor(requestedLimit);
    const moduleLimit = Math.max(0, Math.floor(Number(maxModulePreloads) || 0));
    const links = [];
    const { dispose, isDisposed } = createDisposer(links);
    /** Extensions whose resources may be preloaded, in loading order. */
    const included = [];
    const preloaded = new Set();

    try {
        const entries = Object.entries(manifests).sort(([leftName, left], [rightName, right]) => {
            const order = parseInt(left?.loading_order) - parseInt(right?.loading_order);
            return order || String(left?.display_name || leftName).localeCompare(String(right?.display_name || rightName));
        });
        for (const [name, manifest] of entries) {
            if (excluded.has(name)
                || (eligible && !eligible.has(name))
                || !manifest
                || typeof manifest !== 'object'
                || Array.isArray(manifest)) {
                continue;
            }
            included.push(name);
            if (links.length >= limit) {
                continue;
            }

            const resources = [
                { file: manifest.js, rel: 'modulepreload' },
                { file: manifest.css, rel: 'preload', as: 'style' },
            ];
            for (const resource of resources) {
                if (links.length >= limit) {
                    break;
                }
                if (typeof resource.file !== 'string' || resource.file.trim().length === 0) {
                    continue;
                }

                const link = documentRef.createElement('link');
                link.rel = resource.rel;
                if (resource.as) {
                    link.as = resource.as;
                }
                // Module hints must use the URL activation will load (versioned or not).
                const href = resource.rel === 'modulepreload'
                    ? getExtensionModuleUrl(name, resource.file)
                    : `/scripts/extensions/${name}/${resource.file}`;
                link.href = href;
                documentRef.head.appendChild(link);
                links.push(link);
                preloaded.add(href);
            }
        }
    } catch (error) {
        dispose();
        throw error;
    }

    let modulePreloads = 0;
    /**
     * Adds hints for the modules each extension imports from its folder. Without
     * them the browser discovers those imports one level at a time, and only when
     * the extension's turn to activate comes. Hints never execute anything.
     * @param {Record<string, string[]>|null} moduleGraph Imported files per extension, relative to its folder
     * @returns {number} Hints added
     */
    const preloadModules = (moduleGraph) => {
        if (isDisposed() || !moduleGraph || typeof moduleGraph !== 'object' || Array.isArray(moduleGraph)) {
            return 0;
        }
        let added = 0;
        try {
            for (const name of included) {
                const files = moduleGraph[name];
                if (!Array.isArray(files)) {
                    continue;
                }
                for (const file of files) {
                    if (modulePreloads >= moduleLimit) {
                        return added;
                    }
                    if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').includes('..')) {
                        continue;
                    }
                    const href = getExtensionModuleUrl(name, file);
                    if (preloaded.has(href)) {
                        continue;
                    }
                    const link = documentRef.createElement('link');
                    link.rel = 'modulepreload';
                    link.href = href;
                    documentRef.head.appendChild(link);
                    links.push(link);
                    preloaded.add(href);
                    modulePreloads++;
                    added++;
                }
            }
        } catch {
            // Hints only: activation fetches anything that was not preloaded.
        }
        return added;
    };

    return { count: links.length, dispose, preloadModules };
}

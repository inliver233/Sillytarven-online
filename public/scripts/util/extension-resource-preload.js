const DEFAULT_MAX_PRELOADS = 64;

function createDisposer(links) {
    let disposed = false;
    return () => {
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
}

/**
 * Add passive preload hints for extension JavaScript and styles without executing either resource.
 * @param {Record<string, object>} manifests Extension manifests keyed by extension name
 * @param {object} [options] Preload options
 * @param {string[]|Set<string>} [options.excludedExtensions] Extensions that must not be preloaded
 * @param {number} [options.maxPreloads] Maximum number of resource hints to add
 * @param {Document} [options.documentRef] Document used to create resource hints
 * @returns {{count: number, dispose: () => void}} Preload count and idempotent cleanup callback
 */
export function preloadExtensionResources(manifests, {
    excludedExtensions = [],
    maxPreloads = DEFAULT_MAX_PRELOADS,
    documentRef = globalThis.document,
} = {}) {
    if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) {
        throw new TypeError('Extension manifests must be an object.');
    }
    if (!Array.isArray(excludedExtensions) && !(excludedExtensions instanceof Set)) {
        throw new TypeError('Excluded extensions must be an array or Set.');
    }

    const requestedLimit = Number(maxPreloads);
    if (!Number.isFinite(requestedLimit) || requestedLimit < 0) {
        throw new TypeError('maxPreloads must be a non-negative finite number.');
    }
    if (typeof documentRef?.createElement !== 'function' || typeof documentRef?.head?.appendChild !== 'function') {
        throw new TypeError('A document with a writable head is required.');
    }

    const excluded = new Set(excludedExtensions);
    const limit = Math.floor(requestedLimit);
    const links = [];
    const dispose = createDisposer(links);

    try {
        for (const [name, manifest] of Object.entries(manifests)) {
            if (links.length >= limit) {
                break;
            }
            if (excluded.has(name) || !manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
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
                link.href = `/scripts/extensions/${name}/${resource.file}`;
                documentRef.head.appendChild(link);
                links.push(link);
            }
        }
    } catch (error) {
        dispose();
        throw error;
    }

    return { count: links.length, dispose };
}

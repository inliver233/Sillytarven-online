function toSet(value, label) {
    if (!Array.isArray(value) && !(value instanceof Set)) {
        throw new TypeError(`${label} must be an array or Set.`);
    }
    return new Set(value);
}

function versionCompare(sourceVersion, minimumVersion) {
    return (sourceVersion || '0.0.0').localeCompare(minimumVersion, undefined, {
        numeric: true,
        sensitivity: 'base',
    }) >= 0;
}

function compareManifestEntries([leftName, left], [rightName, right]) {
    const order = parseInt(left?.loading_order) - parseInt(right?.loading_order);
    return order || String(left?.display_name || leftName).localeCompare(String(right?.display_name || rightName));
}

/**
 * Builds the canonical, loading-order activation plan used by both preloading and activation.
 * @param {Record<string, object>} manifests Extension manifests keyed by extension name
 * @param {object} options Activation environment
 * @param {string} options.clientVersion Current SillyTavern client version
 * @param {string[]|Set<string>} [options.modules] Available Extras modules
 * @param {string[]|Set<string>} [options.disabledExtensions] Disabled extensions
 * @param {string[]|Set<string>} [options.activeExtensions] Already active extensions
 * @returns {Array<object>} Ordered activation entries with eligibility details
 */
export function getExtensionActivationPlan(manifests, {
    clientVersion,
    modules = [],
    disabledExtensions = [],
    activeExtensions = [],
} = {}) {
    if (!manifests || typeof manifests !== 'object' || Array.isArray(manifests)) {
        throw new TypeError('Extension manifests must be an object.');
    }
    const availableModules = toSet(modules, 'Extras modules');
    const disabled = toSet(disabledExtensions, 'Disabled extensions');
    const active = toSet(activeExtensions, 'Active extensions');
    const entries = Object.entries(manifests)
        .filter(([, manifest]) => manifest && typeof manifest === 'object' && !Array.isArray(manifest))
        .sort(compareManifestEntries);
    const extensionNames = new Set(entries.map(([name]) => name));

    return entries.map(([name, manifest]) => {
        const extrasRequirements = manifest.requires;
        const extensionDependencies = manifest.dependencies;
        const minClientVersion = manifest.minimum_client_version;
        const hasInvalidRequirements = extrasRequirements !== undefined && !Array.isArray(extrasRequirements);
        const hasInvalidDependencies = extensionDependencies !== undefined && !Array.isArray(extensionDependencies);
        const missingModules = Array.isArray(extrasRequirements)
            ? extrasRequirements.filter(requirement => !availableModules.has(requirement))
            : [];
        const missingDependencies = Array.isArray(extensionDependencies)
            ? extensionDependencies.filter(dependency => !extensionNames.has(dependency))
            : [];
        const disabledDependencies = missingDependencies.length === 0 && Array.isArray(extensionDependencies)
            ? extensionDependencies.filter(dependency => disabled.has(dependency))
            : [];
        const meetsClientMinimumVersion = minClientVersion == null
            || versionCompare(String(clientVersion || ''), String(minClientVersion));
        const meetsModuleRequirements = missingModules.length === 0;
        const meetsExtensionDeps = missingDependencies.length === 0 && disabledDependencies.length === 0;
        const isDisabled = disabled.has(name);
        const isActive = active.has(name);

        return {
            name,
            manifest,
            displayName: manifest.display_name || name,
            minClientVersion,
            hasInvalidRequirements,
            hasInvalidDependencies,
            missingModules,
            missingDependencies,
            disabledDependencies,
            meetsClientMinimumVersion,
            meetsModuleRequirements,
            meetsExtensionDeps,
            isDisabled,
            isActive,
            eligible: meetsClientMinimumVersion
                && meetsModuleRequirements
                && meetsExtensionDeps
                && !isDisabled
                && !isActive,
        };
    });
}

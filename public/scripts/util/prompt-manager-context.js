function getModelSettings(serviceSettings) {
    if (!serviceSettings || typeof serviceSettings !== 'object' || Array.isArray(serviceSettings)) {
        return [];
    }
    return Object.keys(serviceSettings)
        .filter(key => key === 'model' || key.endsWith('_model') || key.endsWith('_model_id'))
        .sort()
        .map(key => [key, serviceSettings[key]]);
}

/**
 * Creates the complete identity that a Prompt Manager background dry-run may update.
 * @param {object} context Prompt Manager context
 * @returns {string} Stable serialized identity
 */
export function createPromptManagerContextIdentity({
    chatIdentity = null,
    activeCharacterId = null,
    mainApi = null,
    backgroundTokensEnabled = false,
    serviceSettings = null,
} = {}) {
    return JSON.stringify({
        chatIdentity,
        activeCharacterId: activeCharacterId == null ? null : String(activeCharacterId),
        mainApi,
        chatCompletionSource: serviceSettings?.chat_completion_source ?? null,
        models: getModelSettings(serviceSettings),
        backgroundTokensEnabled: Boolean(backgroundTokensEnabled),
    });
}

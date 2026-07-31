/**
 * Create an immutable container for Prompt Manager state produced by prompt assembly.
 * @param {object} chatCompletion Prepared chat completion
 * @param {string|null} error Prompt Manager error message
 * @returns {{chatCompletion: object, error: string|null}}
 */
export function createPromptManagerResult(chatCompletion, error = null) {
    return Object.freeze({ chatCompletion, error: error ?? null });
}

/**
 * Apply a prepared result to a Prompt Manager instance.
 * @param {object} promptManager Prompt Manager instance
 * @param {{chatCompletion?: object, error?: string|null}|null} result Prepared result
 * @returns {boolean} Whether the result was committed
 */
export function commitPromptManagerResult(promptManager, result) {
    if (!result?.chatCompletion || typeof promptManager?.setChatCompletion !== 'function') {
        return false;
    }
    promptManager.error = result.error ?? null;
    promptManager.setChatCompletion(result.chatCompletion);
    return true;
}

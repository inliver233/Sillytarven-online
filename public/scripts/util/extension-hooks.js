/**
 * Lifecycle hooks named in an extension's manifest.json:
 *
 *     "hooks": { "activate": "init" }
 *
 * Newer SillyTavern extensions start from the exported function named there instead of from
 * top-level code, so without this they load and silently do nothing. Only `activate` is run;
 * the module is the instance the page already loaded (same URL), so nothing runs twice.
 */

/**
 * Runs the manifest's `hooks.activate` function, if it names one.
 * @param {string} name Extension name, for messages
 * @param {{ hooks?: { activate?: unknown } }} manifest Extension manifest
 * @param {() => Promise<Record<string, unknown>>} loadModule Resolves to the extension's module
 * @returns {Promise<boolean>} Whether a hook ran
 */
export async function runExtensionActivateHook(name, manifest, loadModule) {
    const hook = manifest?.hooks?.activate;
    if (hook === undefined || hook === null || hook === '') {
        return false;
    }
    if (typeof hook !== 'string') {
        throw new Error(`Extension ${name}: manifest.json 'hooks.activate' must be the name of an exported function.`);
    }
    const module = await loadModule();
    const activate = module?.[hook];
    if (typeof activate !== 'function') {
        throw new Error(`Extension ${name}: 'hooks.activate' names "${hook}", which its module does not export as a function.`);
    }
    await activate();
    return true;
}

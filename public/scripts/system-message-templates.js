/**
 * Render the fixed set of templates required to initialize system messages.
 * @param {(templateId: string, templateData?: Record<string, any>) => Promise<string>} renderTemplate Template renderer
 * @param {string} displayVersion Current display version
 * @returns {Promise<{help: string, hotkeys: string, formatting: string, welcome: string, welcomePrompt: string, assistantNote: string}>} Rendered templates
 */
export async function renderSystemMessageTemplates(renderTemplate, displayVersion) {
    const [help, hotkeys, formatting, welcome, welcomePrompt, assistantNote] = await Promise.all([
        renderTemplate('help'),
        renderTemplate('hotkeys'),
        renderTemplate('formatting'),
        renderTemplate('welcome', { displayVersion }),
        renderTemplate('welcomePrompt'),
        renderTemplate('assistantNote'),
    ]);

    return { help, hotkeys, formatting, welcome, welcomePrompt, assistantNote };
}

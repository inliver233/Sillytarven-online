export const INLIVER_THEME_NAME = 'inliver';

const INLIVER_BASE_SIGNATURES = [
    '--il-spring:',
    '@keyframes il-rise',
    '#top-settings-holder .drawer-icon',
];

function normalizeCss(css) {
    return typeof css === 'string' ? css : '';
}

function hasInliverBaseStyles(css) {
    return INLIVER_BASE_SIGNATURES.every(signature => css.includes(signature));
}

/**
 * Resolve the effective custom CSS without changing the user's saved editor content.
 * The built-in inliver theme is prepended only when its base rules are absent.
 * @param {string} themeName Selected theme name
 * @param {string} customCss User-saved custom CSS
 * @param {object[]} availableThemes Available theme presets
 * @returns {string} CSS to install in the runtime style element
 */
export function resolveThemeCustomCss(themeName, customCss, availableThemes) {
    const userCss = normalizeCss(customCss);
    if (themeName !== INLIVER_THEME_NAME) {
        return userCss;
    }

    const theme = Array.isArray(availableThemes)
        ? availableThemes.find(candidate => candidate?.name === INLIVER_THEME_NAME)
        : null;
    const baseCss = normalizeCss(theme?.custom_css);
    if (!baseCss || hasInliverBaseStyles(userCss)) {
        return userCss;
    }

    return userCss.trim() ? `${baseCss}\n\n${userCss}` : baseCss;
}

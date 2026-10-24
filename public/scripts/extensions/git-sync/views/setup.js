import { renderQuickStart } from './quick-start.js';

/**
 * First run: the guided 快速开始 (start here, or bring a backup back).
 * @param {HTMLElement} body
 * @param {import('../index.js').PanelApp} app
 */
export function renderSetupWizard(body, app) {
    renderQuickStart(body, app);
}

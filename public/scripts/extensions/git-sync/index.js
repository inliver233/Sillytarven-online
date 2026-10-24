import { esc, gitApi, showError } from './shared.js';
import overviewView from './views/overview.js';
import changesView from './views/changes.js';
import historyView from './views/history.js';
import branchesView from './views/branches.js';
import remotesView from './views/remotes.js';
import tagsView from './views/tags.js';
import safetyView from './views/safety.js';
import settingsView from './views/settings.js';
import { renderSetupWizard } from './views/setup.js';

/**
 * 酒馆 Git: the panel shell. Each tab is a view module `{ id, label, icon, module, render(container, app) }`;
 * a view shows up only when the server serves the module it needs.
 */

const VIEWS = [overviewView, changesView, historyView, branchesView, remotesView, tagsView, safetyView, settingsView];

/**
 * @typedef {object} PanelApp
 * @property {any} state Latest /state response
 * @property {(tab?: string) => Promise<void>} refresh Reloads state and re-renders (optionally switching tab)
 * @property {(tab: string, params?: object) => void} go Switches tab
 * @property {object} params Parameters passed to the current tab
 * @property {(label: string, work: () => Promise<any>) => Promise<any>} busy Runs work with a blocking overlay
 */

let panel = null;
/** @type {PanelApp} */
const app = {
    state: null,
    params: {},
    tab: 'overview',
    async refresh(tab) {
        if (tab) app.tab = tab;
        try {
            app.state = await gitApi('/state');
        } catch (error) {
            showError(error, '读取酒馆 Git 失败');
            return;
        }
        render();
    },
    go(tab, params = {}) {
        app.tab = tab;
        app.params = params;
        render();
    },
    async busy(label, work) {
        const overlay = panel.querySelector('.git-sync-busy');
        overlay.querySelector('.git-sync-busy-label').textContent = label;
        overlay.classList.add('active');
        try {
            return await work();
        } finally {
            overlay.classList.remove('active');
        }
    },
};

function availableViews() {
    const modules = new Set(app.state?.modules ?? []);
    return VIEWS.filter(view => modules.has(view.module));
}

function render() {
    if (!panel) return;
    const body = panel.querySelector('.git-sync-body');
    const nav = panel.querySelector('.git-sync-nav');
    const status = panel.querySelector('.git-sync-header-status');
    const state = app.state;
    if (!state) return;

    if (!state.exists) {
        nav.innerHTML = '';
        status.textContent = '尚未创建仓库';
        body.innerHTML = '';
        renderSetupWizard(body, app);
        return;
    }

    status.innerHTML = `<i class="fa-solid fa-code-branch"></i> ${esc(state.branch ?? '（游离版本）')}${state.head ? ` · <code>${esc(state.head.slice(0, 7))}</code>` : ' · 还没有提交'}`;
    const views = availableViews();
    if (!views.some(view => view.id === app.tab)) app.tab = 'overview';
    nav.innerHTML = views.map(view => `
        <button type="button" class="git-sync-tab${view.id === app.tab ? ' active' : ''}" data-tab="${view.id}">
            <i class="fa-solid ${view.icon}"></i><span>${esc(view.label)}</span>
        </button>`).join('');
    nav.querySelectorAll('.git-sync-tab').forEach(button => button.addEventListener('click', () => app.go(button.dataset.tab)));

    const view = views.find(entry => entry.id === app.tab);
    // Each render gets its own container: a slower, older render then fills a detached element
    // instead of overwriting the tab the user switched to.
    const container = document.createElement('div');
    container.className = 'git-sync-view';
    container.innerHTML = '<div class="git-sync-loading"><i class="fa-solid fa-spinner fa-spin"></i> 加载中…</div>';
    body.replaceChildren(container);
    Promise.resolve(view.render(container, app)).catch(error => {
        container.innerHTML = `<div class="git-sync-error-box">${esc(error?.message || String(error))}</div>`;
    });
}

function openPanel(tab) {
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'git_sync_panel';
        panel.className = 'git-sync-panel';
        panel.innerHTML = `
            <div class="git-sync-window" role="dialog" aria-label="酒馆 Git">
                <header class="git-sync-header">
                    <div class="git-sync-title"><i class="fa-brands fa-git-alt"></i> 酒馆 Git</div>
                    <div class="git-sync-header-status"></div>
                    <button type="button" class="git-sync-close menu_button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </header>
                <nav class="git-sync-nav"></nav>
                <main class="git-sync-body"></main>
                <div class="git-sync-busy"><div><i class="fa-solid fa-spinner fa-spin"></i> <span class="git-sync-busy-label"></span></div></div>
            </div>`;
        document.body.appendChild(panel);
        panel.querySelector('.git-sync-close').addEventListener('click', closePanel);
        panel.addEventListener('click', event => {
            if (event.target === panel) closePanel();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && panel?.classList.contains('open') && !document.querySelector('dialog[open]')) closePanel();
        });
    }
    panel.classList.add('open');
    app.params = {};
    void app.refresh(tab ?? app.tab);
}

function closePanel() {
    panel?.classList.remove('open');
}

function addMenuButton(attempt = 0) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        if (attempt < 40) setTimeout(() => addMenuButton(attempt + 1), 500);
        return;
    }
    if (document.getElementById('git_sync_menu_button')) return;
    const button = document.createElement('div');
    button.id = 'git_sync_menu_button';
    button.className = 'list-group-item flex-container flexGap5';
    button.innerHTML = '<div class="fa-brands fa-git-alt extensionsMenuExtensionButton"></div>酒馆 Git';
    button.addEventListener('click', () => openPanel());
    menu.appendChild(button);
}

function addSettingsBlock() {
    const host = document.getElementById('extensions_settings2');
    if (!host || document.getElementById('git_sync_settings_block')) return;
    const block = document.createElement('div');
    block.id = 'git_sync_settings_block';
    block.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-brands fa-git-alt"></i> 酒馆 Git</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small>用 Git 给你的聊天、角色卡、世界书、预设做版本备份，可同步到 GitHub、GitLab、Gitee、Gitea 等任意 Git 仓库。</small>
                <div class="menu_button menu_button_icon" id="git_sync_open"><i class="fa-brands fa-git-alt"></i><span>打开酒馆 Git</span></div>
            </div>
        </div>`;
    host.appendChild(block);
    block.querySelector('#git_sync_open').addEventListener('click', () => openPanel());
}

jQuery(() => {
    addMenuButton();
    addSettingsBlock();
});

export { openPanel };

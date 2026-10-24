import { esc, gitApi, showError, timeAgo } from './shared.js';
import overviewView from './views/overview.js';
import changesView from './views/changes.js';
import historyView from './views/history.js';
import branchesView from './views/branches.js';
import remotesView from './views/remotes.js';
import tagsView from './views/tags.js';
import safetyView from './views/safety.js';
import settingsView from './views/settings.js';
import { renderSetupWizard } from './views/setup.js';
import { startSmartCommit } from './smart-commit.js';

/**
 * 酒馆 Git: the panel shell. Each tab is a view module `{ id, label, icon, module, render(container, app) }`;
 * a view shows up only when the server serves the module it needs.
 */

const VIEWS = [overviewView, changesView, historyView, branchesView, remotesView, tagsView, safetyView, settingsView];

/** One-line explanation at the top of each tab, until the user taps "知道了". */
const TAB_GUIDES = {
    overview: ['fa-house', '这里看总体情况：有没有没存的改动、最近一次存档、备份放在哪。'],
    changes: ['fa-pen-to-square', '这里是<b>还没存</b>的改动。平时会自动存，不用管；想马上存就点“提交”。'],
    history: ['fa-clock-rotate-left', '每一条是一次存档。点一条看改了什么；想回到那时候，点<b>回到这个版本</b>。'],
    branches: ['fa-code-branch', '分支 = 平行世界。想试一条新剧情又怕弄乱，就建个分支，随时切回来。'],
    remotes: ['fa-cloud', '这里是网上的备份位置。酒馆云会自动同步，一般不用动。'],
    tags: ['fa-bookmark', '存档点 = 给重要的存档起个名字（比如“第一章结束”），以后好找。'],
    safety: ['fa-life-ring', '每次恢复、切换之前，都会自动先存一份“安全存档”。后悔了就从这里找回。'],
    settings: ['fa-gear', '一般不用改。想换自动存的频率、关掉 AI 写说明、选存哪些，来这里。'],
};

function guideDismissed(tab) {
    try {
        return localStorage.getItem(`git_sync_guide_${tab}`) === '1';
    } catch {
        return false;
    }
}

function dismissGuide(tab) {
    try {
        localStorage.setItem(`git_sync_guide_${tab}`, '1');
    } catch {
        // Private mode: the guide just shows again next time.
    }
}

/**
 * Where saves end up: 酒馆云, the user's own git host, or only this tavern.
 * @param {any} state /state response
 */
function destinationBadge(state) {
    const remotes = Object.entries(state.settings?.remotes ?? {});
    const cloud = remotes.find(([name, remote]) => name === 'cloud' && remote.provider === 'hosted');
    if (cloud) {
        const status = state.hosted?.status ?? {};
        const when = status.lastPushAt ? `${timeAgo(status.lastPushAt / 1000)}同步` : '等待第一次同步';
        if (status.lastError && (status.lastErrorAt ?? 0) > (status.lastPushAt ?? 0)) {
            return `<span class="git-sync-dest warn" title="${esc(status.lastError)}"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(state.hosted.label)}：同步出错，稍后自动重试</span>`;
        }
        return `<span class="git-sync-dest cloud" title="每次存档后自动传到${esc(state.hosted.label)}"><i class="fa-solid fa-cloud"></i> ${esc(state.hosted.label)} · ${esc(when)}</span>`;
    }
    const other = remotes.find(([, remote]) => remote.provider !== 'hosted');
    if (other) {
        const label = state.providers?.[other[1].provider]?.label ?? other[0];
        return `<span class="git-sync-dest remote" title="备份会推送到你自己的 ${esc(label)} 仓库"><i class="fa-solid fa-cloud-arrow-up"></i> ${esc(label)}</span>`;
    }
    return '<span class="git-sync-dest local" title="只存在这个酒馆里，没有网上的备份"><i class="fa-solid fa-house"></i> 只在本地</span>';
}

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

    status.innerHTML = `${destinationBadge(state)} <span class="git-sync-branch"><i class="fa-solid fa-code-branch"></i> ${esc(state.branch ?? '（游离版本）')}${state.head ? ` · <code>${esc(state.head.slice(0, 7))}</code>` : ' · 还没有提交'}</span>`;
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
    const guide = TAB_GUIDES[view.id];
    if (guide && !guideDismissed(view.id)) {
        const tip = document.createElement('div');
        tip.className = 'git-sync-guide';
        tip.innerHTML = `<i class="fa-solid ${guide[0]}"></i><span>${guide[1]}</span><button type="button" class="menu_button git-sync-small">知道了</button>`;
        tip.querySelector('button').addEventListener('click', () => {
            dismissGuide(view.id);
            tip.remove();
        });
        body.replaceChildren(tip, container);
    } else {
        body.replaceChildren(container);
    }
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
                    <div class="git-sync-title"><i class="fa-brands fa-git-alt"></i> 酒馆 Git <span class="git-sync-beta">测试版</span></div>
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

/** "酒馆 Git" next to "备份与导出" in the user settings panel. */
function addUserSettingsButton() {
    const backup = document.getElementById('backup_hub_button');
    if (!backup || document.getElementById('git_sync_user_button')) return;
    const button = document.createElement('div');
    button.id = 'git_sync_user_button';
    button.className = 'margin0 menu_button_icon menu_button';
    button.title = '用 Git 给聊天、角色卡、世界书、预设做版本备份（测试版）';
    button.innerHTML = '<i class="fa-fw fa-brands fa-git-alt"></i><span>酒馆 Git</span>';
    button.addEventListener('click', () => openPanel());
    backup.after(button);
}

/**
 * Any link to "#tavern-git" opens the panel, e.g. a button in an announcement:
 *   [打开酒馆 Git](#tavern-git "button")
 */
function handleEntryLinks() {
    document.addEventListener('click', (event) => {
        const link = /** @type {HTMLElement} */ (event.target)?.closest?.('a[href="#tavern-git"]');
        if (!link) return;
        event.preventDefault();
        // The announcement popup sits above the panel; close it first.
        document.getElementById('closeAnnouncementsPopup')?.click();
        openPanel();
    }, true);
    const openFromHash = () => {
        if (location.hash === '#tavern-git') {
            history.replaceState(null, '', location.pathname + location.search);
            openPanel();
        }
    };
    window.addEventListener('hashchange', openFromHash);
    openFromHash();
}

jQuery(() => {
    addMenuButton();
    addSettingsBlock();
    addUserSettingsButton();
    handleEntryLinks();
    startSmartCommit();
});

export { openPanel };

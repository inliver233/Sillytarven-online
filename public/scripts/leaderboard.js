// 排行榜：两个站一起排，默认匿名参加，打开时每 3 秒刷新
import { getRequestHeaders } from '../script.js';
import { eventSource, event_types } from './events.js';
import { accountStorage } from './util/AccountStorage.js';

const POLL_MS = 3000;
/** 页面在用（有点击、输入、滚动）时每分钟报一次，算在线时长 */
const ACTIVE_PING_MS = 60 * 1000;
const VIEW_KEY = 'leaderboard_view';

const METRICS = [
    { id: 'chat', label: '聊天', icon: 'fa-comments', unit: '条', hint: 'AI 回复条数：每次生成都算，重新生成、继续也算' },
    { id: 'words', label: '字数', icon: 'fa-feather', unit: '字', hint: 'AI 回复的字数，「继续」只算新写的部分' },
    { id: 'online', label: '时长', icon: 'fa-clock', unit: '', hint: '在用酒馆的时间：页面开着但没人动不算，每天最多 16 小时' },
    { id: 'talk', label: '话痨', icon: 'fa-keyboard', unit: '条', hint: '你发出去、并且让 AI 回了的消息条数' },
    { id: 'active', label: '活跃', icon: 'fa-calendar-check', unit: '天', hint: '有聊天的天数' },
    { id: 'streak', label: '连续', icon: 'fa-fire', unit: '天', hint: '到今天连续聊天的天数（今天还没聊不算断）', noWindow: true },
    { id: 'night', label: '夜猫子', icon: 'fa-moon', unit: '条', hint: '凌晨 0–5 点（北京时间）的 AI 回复' },
    { id: 'variety', label: '博爱', icon: 'fa-heart', unit: '位', hint: '聊过的不同角色数：只统计个数，不记是谁' },
    { id: 'group', label: '群聊', icon: 'fa-users', unit: '条', hint: '群聊里的 AI 回复条数' },
    { id: 'rookie', label: '新星', icon: 'fa-star', unit: '条', hint: '注册 30 天内的新人，按 AI 回复条数排' },
];
const WINDOWS = [
    { id: 'today', label: '今日' },
    { id: 'week', label: '本周' },
    { id: 'month', label: '本月' },
    { id: 'all', label: '总榜' },
];
const SITES = [
    { id: 'all', label: '全部' },
    { id: 'legacy', label: 'legacy' },
    { id: 'modern', label: 'modern' },
];
const MODE_TEXT = {
    anon: '匿名参加',
    public: '显示昵称',
    none: '不上榜',
};
const ERROR_TEXT = {
    nickname_empty: '昵称不能是空的',
    nickname_reserved: '这个昵称容易让人误会成官方，换一个吧',
    nickname_taken: '这个昵称已经有人用了',
    admin: '管理员不参与排行',
};

/** @type {boolean|null} 排行榜开没开（第一次报在用时知道） */
let enabled = null;
let started = false;
let lastInputAt = 0;
let lastPingAt = 0;
/** @type {{metric: string, window: string, site: string}} */
let view = { metric: 'chat', window: 'today', site: 'all' };
/** @type {{root: HTMLElement, list: HTMLElement, me: HTMLElement, footer: HTMLElement, hint: HTMLElement, panel: HTMLElement} | null} */
let popup = null;
let pollTimer = null;
let boardVersion = '';
let lastBoard = null;
/** 上一次显示的数值，名字 → 数值，用来让涨了的行闪一下 */
let lastValues = new Map();
let requestSerial = 0;

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
        else element.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        element.append(child);
    }
    return element;
}

function metricOf(id) {
    return METRICS.find(metric => metric.id === id) ?? METRICS[0];
}

/**
 * @param {string} metricId
 * @param {number} value
 * @returns {string}
 */
export function formatLeaderboardValue(metricId, value) {
    const metric = metricOf(metricId);
    if (metric.id === 'online') {
        const minutes = Math.floor(value / 60000);
        const hours = Math.floor(minutes / 60);
        if (!hours) return `${minutes} 分钟`;
        return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
    }
    if (metric.id === 'words' && value >= 10000) {
        return `${(value / 10000).toFixed(value >= 1e6 ? 0 : 1)} 万字`;
    }
    return `${Number(value).toLocaleString('zh-CN')} ${metric.unit}`.trim();
}

function siteBadges(sites) {
    return (sites ?? []).map(site => h('span', { class: `leaderboard-badge leaderboard-badge-${site}`, text: site, title: site === 'legacy' ? '老站' : '新站' }));
}

// ---------- 在线时长：页面在用才报 ----------

function noteInput() {
    lastInputAt = Date.now();
}

async function ping() {
    lastPingAt = Date.now();
    try {
        const response = await fetch(`/api/leaderboard/ping?t=${Date.now()}`, { cache: 'no-store' });
        if (response.status === 404) setEnabled(false);
        else if (response.ok) setEnabled(true);
    } catch {
        // 下一分钟再报
    }
}

function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    document.getElementById('option_leaderboard')?.classList.toggle('displayNone', !value);
}

function startActivityReports() {
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
        window.addEventListener(type, noteInput, { capture: true, passive: true });
    }
    document.addEventListener('scroll', noteInput, { capture: true, passive: true });
    setInterval(() => {
        if (enabled === false || document.visibilityState !== 'visible') return;
        if (lastInputAt > lastPingAt) void ping();
    }, ACTIVE_PING_MS);
    document.addEventListener('visibilitychange', () => {
        // 切走前把最后这一段报掉
        if (document.visibilityState === 'hidden' && enabled && lastInputAt > lastPingAt) void ping();
        if (document.visibilityState === 'visible' && popup) void refresh();
    });
    // 打开页面本身也算在用，顺便知道排行榜开没开
    void ping();
}

// ---------- 弹窗 ----------

function loadView() {
    try {
        const saved = JSON.parse(accountStorage.getItem(VIEW_KEY) || 'null');
        if (saved && METRICS.some(m => m.id === saved.metric)) view.metric = saved.metric;
        if (saved && WINDOWS.some(w => w.id === saved.window)) view.window = saved.window;
        if (saved && SITES.some(s => s.id === saved.site)) view.site = saved.site;
    } catch {
        // 用默认的
    }
}

function saveView() {
    accountStorage.setItem(VIEW_KEY, JSON.stringify(view));
}

/** ☰ 菜单 →「排行榜」 */
export async function openLeaderboard() {
    if (popup) return;
    loadView();
    buildPopup();
    boardVersion = '';
    lastBoard = null;
    lastValues = new Map();
    void refresh();
    pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    try {
        const response = await fetch('/api/leaderboard/me', { cache: 'no-store' });
        if (response.status === 404) {
            toastr.info('排行榜还没开放');
            closeLeaderboard();
            return;
        }
        const me = response.ok ? await response.json() : null;
        // 两个站都还没选过：第一次打开问一下要不要匿名
        if (popup && me && !me.admin && !me.explicit) showChoice(me, true);
    } catch {
        // 榜照样能看
    }
}

function closeLeaderboard() {
    if (!popup) return;
    clearInterval(pollTimer);
    pollTimer = null;
    const root = popup.root;
    popup = null;
    root.classList.remove('show');
    setTimeout(() => root.remove(), 250);
    document.removeEventListener('keydown', onKeydown, true);
}

function onKeydown(event) {
    if (event.key !== 'Escape' || !popup) return;
    event.stopPropagation();
    if (!popup.panel.classList.contains('displayNone')) hidePanel();
    else closeLeaderboard();
}

function segment(items, current, onPick, className) {
    return h('div', { class: `leaderboard-segment ${className}`, role: 'tablist' },
        ...items.map(item => h('button', {
            type: 'button',
            role: 'tab',
            class: item.id === current ? 'active' : '',
            'aria-selected': String(item.id === current),
            'data-id': item.id,
            text: item.label,
            onclick: () => onPick(item.id),
        })));
}

function buildPopup() {
    const list = h('div', { class: 'leaderboard-list', 'aria-live': 'polite' });
    const me = h('div', { class: 'leaderboard-me' });
    const footer = h('div', { class: 'leaderboard-footer' });
    const hint = h('div', { class: 'leaderboard-hint' });
    const panel = h('div', { class: 'leaderboard-panel displayNone' });
    const metrics = h('div', { class: 'leaderboard-metrics', role: 'tablist' },
        ...METRICS.map(metric => h('button', {
            type: 'button',
            role: 'tab',
            class: `leaderboard-chip${metric.id === view.metric ? ' active' : ''}`,
            'data-id': metric.id,
            title: metric.hint,
            onclick: () => pick('metric', metric.id),
        }, h('i', { class: `fa-solid ${metric.icon}` }), h('span', { text: metric.label }))));
    const root = h('div', { id: 'leaderboardPopup', class: 'leaderboard-overlay', onclick: event => event.target === root && closeLeaderboard() },
        h('div', { class: 'leaderboard-popup', role: 'dialog', 'aria-label': '排行榜' },
            h('div', { class: 'leaderboard-header' },
                h('h2', {}, h('i', { class: 'fa-solid fa-ranking-star' }), h('span', { text: '排行榜' })),
                h('span', { class: 'leaderboard-live', title: '打开时每 3 秒自动更新' }, h('span', { class: 'leaderboard-live-dot' }), h('span', { text: '实时' })),
                h('span', { class: 'leaderboard-spacer' }),
                h('button', { type: 'button', class: 'leaderboard-icon-button', title: '怎么算的', onclick: showRules }, h('i', { class: 'fa-solid fa-circle-info' })),
                h('button', { type: 'button', class: 'leaderboard-icon-button', title: '关闭', onclick: closeLeaderboard }, h('i', { class: 'fa-solid fa-times' }))),
            metrics,
            h('div', { class: 'leaderboard-filters' },
                segment(WINDOWS, view.window, id => pick('window', id), 'leaderboard-windows'),
                segment(SITES, view.site, id => pick('site', id), 'leaderboard-sites')),
            hint,
            list,
            me,
            footer,
            panel));
    document.body.append(root);
    popup = { root, list, me, footer, hint, panel };
    updateControls();
    document.addEventListener('keydown', onKeydown, true);
    requestAnimationFrame(() => root.classList.add('show'));
}

function pick(key, id) {
    if (view[key] === id) return;
    view[key] = id;
    saveView();
    updateControls();
    boardVersion = '';
    lastValues = new Map();
    popup?.list.classList.add('loading');
    void refresh();
}

function updateControls() {
    if (!popup) return;
    const metric = metricOf(view.metric);
    popup.root.querySelectorAll('.leaderboard-chip').forEach(chip => {
        const active = chip.getAttribute('data-id') === view.metric;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-selected', String(active));
        if (active) chip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    for (const [selector, current] of [['.leaderboard-windows', view.window], ['.leaderboard-sites', view.site]]) {
        popup.root.querySelectorAll(`${selector} button`).forEach(button => {
            const active = button.getAttribute('data-id') === current;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
    }
    popup.root.querySelector('.leaderboard-windows')?.classList.toggle('displayNone', !!metric.noWindow);
    popup.hint.textContent = metric.hint;
}

async function refresh() {
    if (!popup) return;
    const serial = ++requestSerial;
    const params = new URLSearchParams({ metric: view.metric, window: view.window, site: view.site });
    if (boardVersion) params.set('v', boardVersion);
    try {
        const response = await fetch(`/api/leaderboard/board?${params}`, { cache: 'no-store' });
        if (serial !== requestSerial || !popup) return;
        if (response.status === 404) {
            toastr.info('排行榜还没开放');
            closeLeaderboard();
            return;
        }
        if (!response.ok) throw new Error(String(response.status));
        const board = await response.json();
        if (serial !== requestSerial || !popup) return;
        popup.list.classList.remove('loading');
        if (board.unchanged) {
            renderFooter(lastBoard);
            return;
        }
        boardVersion = board.version;
        lastBoard = board;
        render(board);
    } catch {
        if (serial !== requestSerial || !popup) return;
        popup.list.classList.remove('loading');
        popup.footer.textContent = '连不上服务器，稍后自动重试';
    }
}

function rankCell(rank) {
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    return h('span', { class: 'leaderboard-rank', text: medals[rank] ?? String(rank) });
}

function render(board) {
    if (!popup) return;
    const rows = board.rows ?? [];
    const values = new Map();
    const fragment = document.createDocumentFragment();
    if (!rows.length) {
        fragment.append(h('div', { class: 'leaderboard-empty', text: view.window === 'today' ? '今天还没有人上榜，去聊两句就是第一名' : '这里还没有人上榜' }));
    }
    for (const row of rows) {
        const before = lastValues.get(row.name);
        values.set(row.name, row.value);
        const bumped = lastValues.size > 0 && (before === undefined || row.value > before);
        fragment.append(h('div', {
            class: `leaderboard-row${row.rank <= 3 ? ` leaderboard-top leaderboard-top${row.rank}` : ''}${row.me ? ' leaderboard-row-me' : ''}${bumped ? ' leaderboard-bumped' : ''}`,
        },
        rankCell(row.rank),
        h('span', { class: 'leaderboard-name' },
            h('span', { class: `leaderboard-name-text${row.anonymous ? ' leaderboard-anonymous' : ''}`, text: row.name, title: row.anonymous ? '匿名代号' : '' }),
            row.me ? h('span', { class: 'leaderboard-you', text: '我' }) : null,
            ...siteBadges(row.sites)),
        h('span', { class: 'leaderboard-value', text: formatLeaderboardValue(view.metric, row.value) })));
    }
    lastValues = values;
    popup.list.replaceChildren(fragment);
    renderMe(board);
    renderFooter(board);
}

function renderMe(board) {
    if (!popup) return;
    const me = board.me;
    if (board.admin || !me) {
        popup.me.replaceChildren(h('span', { class: 'leaderboard-me-note', text: board.admin ? '管理员不参与排行' : '' }));
        return;
    }
    const status = me.mode === 'none'
        ? '不上榜（只有你自己看得到）'
        : me.rank ? `第 ${me.rank} 名` : '还没上榜';
    const gap = me.rank && me.gap ? `距上一名还差 ${formatLeaderboardValue(view.metric, me.gap)}` : (me.rank === 1 ? '目前第一' : '');
    popup.me.replaceChildren(
        h('div', { class: 'leaderboard-me-main' },
            h('span', { class: 'leaderboard-me-rank', text: status }),
            h('span', { class: 'leaderboard-me-name' },
                h('span', { class: me.mode === 'public' ? '' : 'leaderboard-anonymous', text: me.name }),
                ...siteBadges(me.sites)),
            h('span', { class: 'leaderboard-me-value', text: formatLeaderboardValue(view.metric, me.value) })),
        h('div', { class: 'leaderboard-me-side' },
            gap ? h('small', { class: 'leaderboard-gap', text: gap }) : null,
            h('button', {
                type: 'button',
                class: 'leaderboard-settings',
                title: '改匿名、昵称或不上榜',
                onclick: () => void openSettings(),
            }, h('i', { class: 'fa-solid fa-user-gear' }), h('span', { text: MODE_TEXT[me.mode] ?? '设置' }))));
}

function renderFooter(board) {
    if (!popup || !board) return;
    const parts = [`${board.participants ?? 0} 人上榜`];
    const now = Date.now();
    for (const peer of board.peers ?? []) {
        if (peer.error && (!peer.syncedAt || now - peer.syncedAt > 30000)) {
            parts.push(peer.syncedAt
                ? `另一个站暂时连不上，它的数据停在 ${Math.max(1, Math.round((now - peer.syncedAt) / 60000))} 分钟前`
                : '另一个站暂时连不上，现在只有本站的数据');
        }
    }
    if (board.backfill) parts.push(`历史聊天记录统计中 ${board.backfill.done}/${board.backfill.total}`);
    popup.footer.textContent = parts.join(' · ');
}

// ---------- 设置：匿名 / 昵称 / 不上榜 ----------

function hidePanel() {
    popup?.panel.classList.add('displayNone');
    popup?.panel.replaceChildren();
}

function showRules() {
    if (!popup) return;
    const since = lastBoard?.countingSince ? new Date(lastBoard.countingSince).toLocaleDateString('zh-CN') : '';
    popup.panel.replaceChildren(h('div', { class: 'leaderboard-card' },
        h('h3', { text: '怎么算的' }),
        h('ul', {},
            h('li', { text: '两个站一起排：legacy 是老站，modern 是新站。两个站用同一个 Discord 账号的，算同一个人，名字后面两个标记都有。' }),
            h('li', { text: '聊天、字数：每次 AI 生成回复都算（重新生成、继续也算；继续只算新写的字）。导入、复制的旧聊天不算。' }),
            h('li', { text: '话痨：你发出去、并且让 AI 回了的消息。' }),
            h('li', { text: '时长：页面在用（有点击、输入、滚动）才计时，开着不动不算，每天最多 16 小时。' }),
            h('li', { text: '博爱只统计聊过多少个不同的角色，不记录是谁。' }),
            h('li', { text: '今日、本周、本月按北京时间算，每周从周一开始。' }),
            h('li', { text: since ? `${since} 之前的聊天按现有聊天记录补算（删掉的不算）；时长从这天开始算。` : '上线之前的聊天按现有聊天记录补算（删掉的不算）；时长从上线开始算。' }),
            h('li', { text: '默认匿名：代号是固定的，别人没法从代号知道你是谁。管理员不参与排行。' })),
        h('div', { class: 'leaderboard-card-actions' },
            h('button', { type: 'button', class: 'menu_button', text: '知道了', onclick: hidePanel }))));
    popup.panel.classList.remove('displayNone');
}

async function openSettings() {
    try {
        const response = await fetch('/api/leaderboard/me', { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        showChoice(await response.json(), false);
    } catch {
        toastr.error('加载设置失败，请稍后再试');
    }
}

/**
 * @param {{mode: string, nickname: string, explicit: boolean, anonymousName: string, sites: string[]}} me
 * @param {boolean} first 第一次打开时的询问
 */
function showChoice(me, first) {
    if (!popup) return;
    let mode = me.explicit ? me.mode : 'anon';
    const nickname = h('input', {
        type: 'text',
        class: 'text_pole leaderboard-nickname',
        maxlength: 16,
        placeholder: '起个昵称（最多 16 个字）',
        value: me.nickname || '',
        onfocus: () => select('public'),
    });
    const error = h('div', { class: 'leaderboard-error' });
    const option = (value, title, detail) => h('label', { class: 'leaderboard-option', 'data-mode': value },
        h('input', { type: 'radio', name: 'leaderboard-mode', value, onchange: () => select(value) }),
        h('span', { class: 'leaderboard-option-text' }, h('b', { text: title }), h('small', { text: detail })),
        value === 'public' ? nickname : null);
    const options = h('div', { class: 'leaderboard-options' },
        option('anon', `匿名参加（代号「${me.anonymousName}」）`, '别人只看到这个代号，看不到你的账号'),
        option('public', '显示昵称', '只显示你起的昵称和数字，不显示账号、角色和聊天内容'),
        option('none', '不上榜', '别人看不到你，你自己仍能看到自己排第几'));
    function select(value) {
        mode = value;
        options.querySelectorAll('.leaderboard-option').forEach(item => {
            const selected = item.getAttribute('data-mode') === value;
            item.classList.toggle('selected', selected);
            const radio = item.querySelector('input[type=radio]');
            if (radio instanceof HTMLInputElement) radio.checked = selected;
        });
        error.textContent = '';
    }
    async function save() {
        const body = { mode, nickname: mode === 'public' ? String(nickname instanceof HTMLInputElement ? nickname.value : '') : '' };
        if (mode === 'public' && !body.nickname.trim()) {
            error.textContent = ERROR_TEXT.nickname_empty;
            nickname.focus();
            return;
        }
        try {
            const response = await fetch('/api/leaderboard/me', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                error.textContent = ERROR_TEXT[data?.error] ?? '保存失败，请稍后再试';
                return;
            }
            hidePanel();
            toastr.success(mode === 'public' ? `之后排行榜上显示「${data.nickname}」` : mode === 'none' ? '已不上榜，只有你自己看得到自己的排名' : '已设为匿名参加');
            boardVersion = '';
            void refresh();
        } catch {
            error.textContent = '保存失败，请稍后再试';
        }
    }
    const both = (me.sites ?? []).length > 1;
    popup.panel.replaceChildren(h('div', { class: 'leaderboard-card' },
        h('h3', { text: first ? '要匿名参加排行榜吗？' : '排行榜设置' }),
        first ? h('p', { text: '排行榜默认匿名参加：别人只会看到一个代号，不知道是你。' }) : null,
        first ? h('p', { text: '不匿名也完全没关系——只会显示你起的昵称和次数、字数这些数字，不会显示你的账号、角色或聊天内容。' }) : null,
        options,
        error,
        h('small', { class: 'leaderboard-note', text: both ? '你在两个站用的是同一个 Discord 账号，这个设置两个站一起生效。以后可以在榜单底部随时改。' : '以后可以在榜单底部随时改。' }),
        h('div', { class: 'leaderboard-card-actions' },
            first ? null : h('button', { type: 'button', class: 'menu_button', text: '取消', onclick: hidePanel }),
            h('button', { type: 'button', class: 'menu_button leaderboard-primary', text: '确定', onclick: () => void save() }))));
    select(mode);
    popup.panel.classList.remove('displayNone');
}

// 排在最前面：后面的监听器可能弹窗等用户点（比如通行密钥提示），不能让它们挡住菜单项
eventSource.makeFirst(event_types.APP_READY, () => {
    if (started) return;
    started = true;
    startActivityReports();
});

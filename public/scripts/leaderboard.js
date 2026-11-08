// 排行榜：两个站一起排，默认匿名参加，打开时每 3 秒刷新
import { getRequestHeaders } from '../script.js';
import { eventSource, event_types } from './events.js';
import { onLive } from './live.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';

const POLL_MS = 3000;
/** 页面在用（有点击、输入、滚动）时每分钟报一次，算在线时长 */
const ACTIVE_PING_MS = 60 * 1000;
const VIEW_KEY = 'leaderboard_view';

const METRICS = [
    { id: 'score', label: '综合', icon: 'fa-trophy', unit: '分', hint: '各项加权得分，满分 100。点击某行查看明细，ⓘ 查看公式' },
    { id: 'chat', label: '聊天', icon: 'fa-comments', unit: '条', hint: 'AI 回复条数（含重新生成、继续）' },
    { id: 'words', label: '字数', icon: 'fa-feather', unit: '字', hint: 'AI 回复字数（继续只计新增部分）' },
    { id: 'online', label: '时长', icon: 'fa-clock', unit: '', hint: '页面有操作时的在线时长，每日上限 16 小时' },
    { id: 'talk', label: '话痨', icon: 'fa-keyboard', unit: '条', hint: '发出并得到 AI 回复的消息数' },
    { id: 'active', label: '活跃', icon: 'fa-calendar-check', unit: '天', hint: '有聊天的天数', noHour: true },
    { id: 'streak', label: '连续', icon: 'fa-fire', unit: '天', hint: '截至今日的连续聊天天数（今日未聊不中断）', noWindow: true },
    { id: 'night', label: '夜猫子', icon: 'fa-moon', unit: '条', hint: '0–5 点（北京时间）的 AI 回复数' },
    { id: 'variety', label: '博爱', icon: 'fa-heart', unit: '位', hint: '聊过的不同角色数（仅计数量）' },
    { id: 'group', label: '群聊', icon: 'fa-users', unit: '条', hint: '群聊中的 AI 回复数' },
    { id: 'rookie', label: '新星', icon: 'fa-star', unit: '条', hint: '注册 30 天内用户的 AI 回复数' },
];
/** 综合榜各项的叫法（服务器发来权重，说明里照着写） */
const SCORE_LABELS = { chat: '聊天', words: '字数', online: '时长', active: '活跃天数', talk: '话痨', variety: '博爱', streak: '连续天数' };
const DIMENSION_LABELS = { output: '产出', time: '时间', habit: '坚持', breadth: '广度' };
const DEFAULT_SCORE_PARTS = [
    { metric: 'chat', weight: 15, unit: 1, dimension: 'output' },
    { metric: 'words', weight: 15, unit: 100, dimension: 'output' },
    { metric: 'talk', weight: 10, unit: 1, dimension: 'output' },
    { metric: 'online', weight: 20, unit: 60000, dimension: 'time' },
    { metric: 'active', weight: 20, unit: 1, dimension: 'habit' },
    { metric: 'streak', weight: 10, unit: 1, dimension: 'habit' },
    { metric: 'variety', weight: 10, unit: 1, dimension: 'breadth' },
];
const DEFAULT_DAILY_CAPS = { ai: 1000, chars: 1500000, user: 800 };
const WINDOWS = [
    { id: 'hour', label: '本小时' },
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
    anon: '匿名',
    public: '实名',
};

/** @type {boolean|null} 排行榜开没开（第一次报在用时知道） */
let enabled = null;
let started = false;
let lastInputAt = 0;
let lastPingAt = 0;
/** @type {{metric: string, window: string, site: string}} */
let view = { metric: 'score', window: 'today', site: 'all' };
/** @type {{root: HTMLElement, list: HTMLElement, me: HTMLElement, test: HTMLElement, footer: HTMLElement, hint: HTMLElement, panel: HTMLElement} | null} */
let popup = null;
let pollTimer = null;
let boardVersion = '';
let lastBoard = null;
/** 综合榜里点开看各项得分的行（按名字，刷新后保持展开） */
const expandedRows = new Set();
/** 上一次显示的数值和名次（key → 值），用来做涨跌、名次升降的效果 */
let lastValues = new Map();
let lastRanks = new Map();
/** 上一次的榜是哪一期（小时榜按小时、其他按天）：换期时数值整体重来，不算涨跌 */
let lastPeriod = '';
/** 「我」那栏上一次的数值 */
let lastMeValue = null;
/** 名次变化的标记（▲2、▼1、NEW）显示一会儿，刷新后接着显示：key → {kind, text, at} */
const moveMarks = new Map();
/**
 * 名次那一格跟着发生的事换几秒表情，可以按顺序播几段（比如原来的猫娘哭完，再换第四名的哭脸）：
 * key → {start, until, phases: [{ms, catgirl?: 名次, face?: 表情, place?: 哪个名次的哭脸}]}
 */
const moods = new Map();
const MOVE_MARK_MS = 8000;
let requestSerial = 0;

/** 换榜或重新打开：下一次显示不算涨跌、不比名次 */
function resetEffects() {
    lastValues = new Map();
    lastRanks = new Map();
    lastPeriod = '';
    lastMeValue = null;
    moveMarks.clear();
    moods.clear();
}

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
    if (metric.id === 'score') return `${Number(value).toFixed(1)} 分`;
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

/**
 * 综合得分的各项，例如「聊天 20.9 · 字数 20.0 · …」
 * @param {(number|null)[]} parts 各项得分（null：这一期没人有这项数据，不计入）
 * @param {{metric: string}[]} [scoreParts]
 * @returns {string}
 */
export function formatScoreParts(parts, scoreParts = DEFAULT_SCORE_PARTS) {
    return (parts ?? []).map((points, index) => {
        const metric = scoreParts[index]?.metric;
        const label = SCORE_LABELS[metric] ?? metricOf(metric).label;
        return `${label} ${points === null || points === undefined ? '—' : Number(points).toFixed(1)}`;
    }).join(' · ');
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
        else if (response.ok) {
            setEnabled(true);
            // 还没选（或者管理员让 TA 重新选）：页面开着也弹出来
            const data = await response.json().catch(() => null);
            if (data?.choose) void maybeShowLaunchNotice();
        }
    } catch {
        // 下一分钟再报
    }
}

function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    document.getElementById('option_leaderboard')?.classList.toggle('displayNone', !value);
    if (value) setTimeout(() => void maybeShowLaunchNotice(), NOTICE_DELAY_MS);
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
    resetEffects();
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
        if (popup && me && !me.explicit) showChoice(me, true);
    } catch {
        // 榜照样能看
    }
}

function closeLeaderboard() {
    if (!popup) return;
    window.removeEventListener('resize', fitNames);
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
    const test = h('div', { class: 'leaderboard-test displayNone' });
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
                h('button', { type: 'button', class: 'leaderboard-icon-button', title: '计算规则', onclick: showRules }, h('i', { class: 'fa-solid fa-circle-info' })),
                h('button', { type: 'button', class: 'leaderboard-icon-button', title: '关闭', onclick: closeLeaderboard }, h('i', { class: 'fa-solid fa-times' }))),
            metrics,
            h('div', { class: 'leaderboard-filters' },
                segment(WINDOWS, view.window, id => pick('window', id), 'leaderboard-windows'),
                segment(SITES, view.site, id => pick('site', id), 'leaderboard-sites')),
            hint,
            list,
            test,
            me,
            footer,
            panel));
    document.body.append(root);
    popup = { root, list, me, test, footer, hint, panel };
    updateControls();
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', fitNames);
    requestAnimationFrame(() => root.classList.add('show'));
}

function pick(key, id) {
    if (view[key] === id) return;
    view[key] = id;
    saveView();
    updateControls();
    boardVersion = '';
    resetEffects();
    popup?.list.classList.add('loading');
    void refresh();
}

function updateControls() {
    if (!popup) return;
    const metric = metricOf(view.metric);
    // 「活跃天数」按小时没意义：换到今日
    if (metric.noHour && view.window === 'hour') {
        view.window = 'today';
        saveView();
    }
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
    popup.root.querySelector('.leaderboard-windows button[data-id="hour"]')?.classList.toggle('displayNone', !!metric.noHour);
    updateHint();
}

/** 榜的说明；小时榜加上是哪个小时（过了整点跟着变） */
function updateHint() {
    if (!popup) return;
    const metric = metricOf(view.metric);
    if (view.window === 'hour' && !metric.noWindow) {
        popup.hint.replaceChildren(`${metric.hint} · `, h('span', { class: 'leaderboard-nowrap', text: `本小时 ${currentHourText()}` }));
    } else {
        popup.hint.textContent = metric.hint;
    }
}

/** 现在这个小时（北京时间），比如「01:00–01:59」 */
function currentHourText() {
    const hour = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(/\D/g, '').padStart(2, '0');
    return `${hour}:00–${hour}:59`;
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

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
/** 前三名身上的星光：综合榜更多，第一名最多 */
const SPARKLES = { score: { 1: 6, 2: 3 }, other: { 1: 3 } };

/** 系统或酒馆设置里开了「减少动画」：不滚数字、不滑动、不浮出涨跌（CSS 动画由酒馆统一关掉） */
function calmMotion() {
    return document.body.classList.contains('reduced-motion') || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 综合榜前三的像素猫娘（16×16）：金、银、铜三色头发和铃铛，第一名戴王冠、第二名星星发夹、第三名蝴蝶结。
 * '.' 是透明，其他字母是这一名的颜色。
 */
const CATGIRL_PIXELS = [
    '..O..........O..',
    '.OHO........OHO.',
    '.OPHO......OHPO.',
    '.OPPHOOOOOOHPPO.',
    '.OHHHHHHHHHHHHO.',
    'OHHLHHHHHHHHLHHO',
    'OHHHHHHHHHHHHHHO',
    'OHHHSHHSSHHSHHHO',
    'OHHSOOSSSSOOSHHO',
    'OHHSWeSSSSWeSHHO',
    'OHHSeESSSSeESHHO',
    'OHHSBBSMMSBBSHHO',
    'OhHOSSSSSSSSOHhO',
    'OhhhOORRRROOhhhO',
    '.OOOOOOwGOOOOOO.',
    '......OggO......',
];
/** 名次 → 叠在上面的配饰 [x, y, 颜色] */
const CATGIRL_EXTRAS = {
    1: [[5, 0, 'O'], [7, 0, 'O'], [8, 0, 'O'], [10, 0, 'O'], [5, 1, 'G'], [7, 1, 'w'], [8, 1, 'G'], [10, 1, 'G'], [5, 2, 'G'], [6, 2, 'G'], [7, 2, 'J'], [8, 2, 'J'], [9, 2, 'G'], [10, 2, 'G'], [5, 3, 'g'], [6, 3, 'g'], [7, 3, 'g'], [8, 3, 'g'], [9, 3, 'g'], [10, 3, 'g']],
    2: [[12, 4, 'w'], [11, 5, 'w'], [12, 5, 'K'], [13, 5, 'w'], [12, 6, 'g']],
    3: [[2, 4, 'K'], [4, 4, 'K'], [2, 5, 'K'], [3, 5, 'k'], [4, 5, 'K']],
};
const CATGIRL_COMMON = { P: '#ff9ab3', S: '#ffe3d1', W: '#ffffff', B: '#ff8fa3', M: '#9a3412', R: '#d6334f', J: '#e11d48', r: '#ff6b81', Q: '#7dd3fc', q: '#e0f2fe', Y: '#ffe066' };
const CATGIRL_COLORS = {
    1: { O: '#3b2410', H: '#f8c537', h: '#c98f12', L: '#fff1a8', E: '#3b2410', e: '#e11d48', G: '#ffd34d', g: '#b8860b', w: '#fff6c8' },
    2: { O: '#2b3442', H: '#e6ecf3', h: '#9fadbe', L: '#ffffff', E: '#2b3442', e: '#3b82f6', G: '#dfe6ee', g: '#8592a3', w: '#ffffff', K: '#60a5fa' },
    3: { O: '#3a1f0d', H: '#c77d3e', h: '#8c5224', L: '#f2c08f', E: '#3a1f0d', e: '#16a34a', G: '#e09a5b', g: '#8c5a2b', w: '#ffe0bf', K: '#f472b6', k: '#be185d' },
};

/** 睁眼的像素：闭眼时这几格是皮肤，中间一行画一道线 */
const CATGIRL_EYES = [[4, 8], [5, 8], [4, 9], [5, 9], [4, 10], [5, 10], [10, 8], [11, 8], [10, 9], [11, 9], [10, 10], [11, 10]];
const CATGIRL_CLOSED_EYES = [[4, 9, 'E'], [5, 9, 'E'], [10, 9, 'E'], [11, 9, 'E']];
/** 平时的嘴：换表情时这两格是皮肤 */
const CATGIRL_MOUTH = [[7, 11], [8, 11]];
/** 一闪一闪的像素：第一名王冠尖上的光，第二名星星发夹的光 */
const CATGIRL_GLINTS = { 1: [[5, 1], [8, 1], [10, 1]], 2: [[12, 5]], 3: [] };
/**
 * 表情（盖在脸上，平时的眼睛和嘴藏起来）：开心（笑眼、张嘴笑）、得意（半眯眼、猫咪笑、头顶闪光）、
 * 吃惊（瞪眼、o 嘴、冷汗）、难过（闭眼流泪、嘴角往下）。
 */
const CATGIRL_FACES = {
    // 笑眼「^ ^」、张嘴笑；嘴和腮红之间空一格，不连成一条
    happy: [[3, 10, 'E'], [4, 9, 'E'], [5, 9, 'E'], [6, 10, 'E'], [9, 10, 'E'], [10, 9, 'E'], [11, 9, 'E'], [12, 10, 'E'],
        [5, 11, 'S'], [10, 11, 'S'], [6, 11, 'M'], [7, 11, 'r'], [8, 11, 'r'], [9, 11, 'M'], [7, 12, 'M'], [8, 12, 'M']],
    // 得意：半眯的眼（眼皮压下来、眼角拉长）、嘴角上翘的猫咪笑，头顶两侧闪光
    excited: [[3, 9, 'E'], [4, 9, 'E'], [5, 9, 'E'], [4, 10, 'e'], [5, 10, 'e'], [10, 9, 'E'], [11, 9, 'E'], [12, 9, 'E'], [10, 10, 'e'], [11, 10, 'e'],
        [5, 11, 'S'], [10, 11, 'S'], [6, 11, 'M'], [9, 11, 'M'], [7, 12, 'M'], [8, 12, 'M'],
        [0, 2, 'Y'], [15, 2, 'Y']],
    shocked: [[4, 8, 'E'], [5, 8, 'E'], [4, 9, 'W'], [5, 9, 'W'], [4, 10, 'W'], [5, 10, 'E'],
        [10, 8, 'E'], [11, 8, 'E'], [10, 9, 'W'], [11, 9, 'W'], [10, 10, 'E'], [11, 10, 'W'],
        [7, 11, 'M'], [8, 11, 'M'], [7, 12, 'M'], [8, 12, 'M'], [13, 5, 'q'], [13, 6, 'Q'], [13, 7, 'Q']],
    sad: [[4, 10, 'E'], [5, 10, 'E'], [10, 10, 'E'], [11, 10, 'E'], [4, 11, 'Q'], [4, 12, 'Q'], [11, 11, 'Q'], [11, 12, 'Q'],
        [7, 11, 'M'], [8, 11, 'M'], [6, 12, 'M'], [9, 12, 'M']],
};

/**
 * @param {[number, number, string][]} pixels
 * @param {Record<string, string>} colors
 * @returns {string} 每一段同一行、同色、相连的像素一个矩形
 */
function pixelRects(pixels, colors) {
    const sorted = [...pixels].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    let out = '';
    for (let i = 0; i < sorted.length;) {
        const [x, y, letter] = sorted[i];
        let end = i + 1;
        while (end < sorted.length && sorted[end][1] === y && sorted[end][2] === letter && sorted[end][0] === x + (end - i)) end++;
        out += `<rect x="${x}" y="${y}" width="${end - i}" height="1" fill="${colors[letter]}"/>`;
        i = end;
    }
    return out;
}

/**
 * 一只猫娘（SVG），分成会动的几层：耳朵（抖）、眼睛（眨）、嘴、各种表情、闪光，整只一起呼吸；动画在 leaderboard.css。
 * @param {1|2|3} rank
 * @returns {string}
 */
function catgirlSvg(rank) {
    const colors = { ...CATGIRL_COMMON, ...CATGIRL_COLORS[rank] };
    const extras = new Map(CATGIRL_EXTRAS[rank].map(([x, y, letter]) => [`${x},${y}`, letter]));
    const eyes = new Set(CATGIRL_EYES.map(([x, y]) => `${x},${y}`));
    const mouth = new Set(CATGIRL_MOUTH.map(([x, y]) => `${x},${y}`));
    /** @type {Record<string, [number, number, string][]>} */
    const layers = { earLeft: [], earRight: [], body: [], eyes: [], mouth: [], extras: [] };
    CATGIRL_PIXELS.forEach((row, y) => [...row].forEach((letter, x) => {
        const key = `${x},${y}`;
        if (extras.has(key)) layers.extras.push([x, y, extras.get(key)]);
        if (letter === '.' || extras.has(key)) return;
        if (eyes.has(key) || mouth.has(key)) {
            layers[eyes.has(key) ? 'eyes' : 'mouth'].push([x, y, letter]);
            layers.body.push([x, y, 'S']);
        } else if (y <= 3 && x <= 4) {
            layers.earLeft.push([x, y, letter]);
        } else if (y <= 3 && x >= 11) {
            layers.earRight.push([x, y, letter]);
        } else {
            layers.body.push([x, y, letter]);
        }
    }));
    const glints = CATGIRL_GLINTS[rank].map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="#ffffff"/>`).join('');
    return `<svg class="leaderboard-catgirl leaderboard-catgirl-${rank}" viewBox="0 0 16 16" shape-rendering="crispEdges" role="img" aria-label="第 ${rank} 名"><title>第 ${rank} 名</title><g class="cg-all">`
        + `<g class="cg-ear-left">${pixelRects(layers.earLeft, colors)}</g><g class="cg-ear-right">${pixelRects(layers.earRight, colors)}</g>`
        + `<g class="cg-body">${pixelRects(layers.body, colors)}</g>`
        + `<g class="cg-normal"><g class="cg-eyes">${pixelRects(layers.eyes, colors)}</g><g class="cg-blink">${pixelRects(CATGIRL_CLOSED_EYES, colors)}</g><g class="cg-mouth">${pixelRects(layers.mouth, colors)}</g></g>`
        + Object.entries(CATGIRL_FACES).map(([mood, pixels]) => `<g class="cg-face cg-face-${mood}">${pixelRects(pixels, colors)}</g>`).join('')
        + `<g class="cg-extras">${pixelRects(layers.extras, colors)}</g>${glints ? `<g class="cg-glint">${glints}</g>` : ''}</g></svg>`;
}

/** 每只猫娘解析一次，之后每次显示复制一份 */
const catgirlTemplates = {};

/**
 * @param {1|2|3} rank
 * @returns {Element}
 */
function catgirlElement(rank) {
    if (!catgirlTemplates[rank]) {
        const template = document.createElement('template');
        template.innerHTML = catgirlSvg(rank);
        catgirlTemplates[rank] = template;
    }
    return catgirlTemplates[rank].content.firstElementChild.cloneNode(true);
}

/** 综合榜第四、五名的头像（静止；那一行的边框颜色在 leaderboard.css 里，取自图片） */
const PLACE_FACES = { 4: '/img/leaderboard-fourth.webp', 5: '/img/leaderboard-fifth.webp' };
/** 这个名次被挤下去时，那一行先换成这张哭脸 */
const PLACE_SAD_FACES = { 4: '/img/leaderboard-fourth-sad.webp', 5: '/img/leaderboard-fifth-sad.webp' };

/**
 * @param {{start: number, until: number, phases: {ms: number, catgirl?: number, face?: string, place?: number}[]}} [mood]
 * @param {number} now
 * @returns {{ms: number, catgirl?: number, face?: string, place?: number}|null} 这会儿播的那一段
 */
function currentPhase(mood, now) {
    if (!mood || now >= mood.until) return null;
    let end = mood.start;
    for (const phase of mood.phases) {
        end += phase.ms;
        if (now < end) return phase;
    }
    return null;
}

/**
 * @param {number} rank
 * @param {boolean} fancy 综合榜：前三是像素猫娘，第四、五名是头像；其他榜是奖牌
 * @param {any} [mood] 这一行的表情（见 moods）
 */
function rankCell(rank, fancy, mood) {
    const phase = fancy ? currentPhase(mood, Date.now()) : null;
    let mark;
    if (phase?.place) {
        mark = h('img', { class: `leaderboard-place-face leaderboard-place-sad${phase.place}`, src: PLACE_SAD_FACES[phase.place], alt: `第 ${rank} 名`, title: `第 ${rank} 名`, draggable: 'false' });
    } else if (phase?.catgirl) {
        // 可能是原来那个名次的猫娘（刚被挤下去，还在哭）
        mark = catgirlElement(/** @type {1|2|3} */ (phase.catgirl));
        mark.classList.add(`cg-mood-${phase.face}`);
    } else if (fancy && rank <= 3) {
        mark = catgirlElement(/** @type {1|2|3} */ (rank));
    } else if (fancy && PLACE_FACES[rank]) {
        mark = h('img', { class: 'leaderboard-place-face', src: PLACE_FACES[rank], alt: `第 ${rank} 名`, title: `第 ${rank} 名`, draggable: 'false' });
    } else {
        mark = h('span', { class: 'leaderboard-medal', text: MEDALS[rank] ?? String(rank) });
    }
    return h('span', { class: 'leaderboard-rank' }, mark);
}

function adminBadge() {
    return h('span', { class: 'leaderboard-admin-badge', title: '管理员' }, h('i', { class: 'fa-solid fa-shield-halved' }), h('span', { text: 'ADMIN' }));
}

/** 比显示精度还小的变化不算（综合分 0.1、时长 1 分钟、其他 1） */
function significant(metric, delta) {
    if (metric === 'score') return Math.abs(delta) >= 0.05;
    if (metric === 'online') return Math.abs(delta) >= 60000;
    return Math.abs(delta) >= 1;
}

/** 正在滚动的数字：元素 → {from, to, metric, start} */
const tweens = new Map();
let tweenFrame = 0;
const TWEEN_MS = 800;

/**
 * 数字从旧值滚到新值。
 * @param {HTMLElement} element
 * @param {number} from
 * @param {number} to
 * @param {string} metric
 */
function tweenValue(element, from, to, metric) {
    tweens.set(element, { from, to, metric, start: performance.now() });
    element.textContent = formatLeaderboardValue(metric, from);
    tweenFrame ||= requestAnimationFrame(stepTweens);
}

function stepTweens(now) {
    tweenFrame = 0;
    for (const [element, tween] of tweens) {
        const progress = Math.min(1, Math.max(0, (now - tween.start) / TWEEN_MS));
        if (!element.isConnected || progress >= 1) {
            if (element.isConnected) element.textContent = formatLeaderboardValue(tween.metric, tween.to);
            tweens.delete(element);
            continue;
        }
        const value = tween.from + (tween.to - tween.from) * (1 - (1 - progress) ** 3);
        element.textContent = formatLeaderboardValue(tween.metric, tween.metric === 'score' ? value : Math.round(value));
    }
    if (tweens.size) tweenFrame = requestAnimationFrame(stepTweens);
}

/**
 * 涨跌的数从数值旁边浮出来：涨的往上飘，跌的往下沉。
 * @param {HTMLElement} cell
 * @param {string} metric
 * @param {number} delta
 */
function floatDelta(cell, metric, delta) {
    const chip = h('span', { class: `leaderboard-delta ${delta > 0 ? 'gain' : 'loss'}`, 'aria-hidden': 'true', text: `${delta > 0 ? '+' : '−'}${formatLeaderboardValue(metric, Math.abs(delta))}` });
    chip.addEventListener('animationend', () => chip.remove());
    cell.append(chip);
}

/**
 * 一次性的效果：整行闪一下（涨、跌、登顶、冲进前三），可带一句文字，放完就移除。
 * @param {HTMLElement} row
 * @param {string} kind gain、loss，或者前三名的变动（见 topEvents）
 * @param {string} [label]
 */
function burst(row, kind, label) {
    const flash = h('span', { class: `leaderboard-flash ${kind}`, 'aria-hidden': 'true' });
    flash.addEventListener('animationend', () => flash.remove());
    row.append(flash);
    if (!label) return;
    const callout = h('span', { class: `leaderboard-callout ${kind}`, 'aria-hidden': 'true', text: label });
    callout.addEventListener('animationend', () => callout.remove());
    row.append(callout);
}

/** 各行（按 key）在列表内容里的位置 */
function rowTops(list) {
    const base = list.getBoundingClientRect().top - list.scrollTop;
    const tops = new Map();
    for (const row of list.querySelectorAll('.leaderboard-row[data-key]')) tops.set(row.dataset.key, row.getBoundingClientRect().top - base);
    return tops;
}

/** 前三名变动时的文字 */
const TOP_EVENT_LABELS = { upset: '⚡ 下克上！', crown: '👑 登顶', swap: '⇅ 互换', podium: '冲进前三', displaced: '被顶替', out: '跌出前三' };

/**
 * 前三名的变动，按行（key）：
 * upset 下克上（一次升三名以上，或从第三名以下直接登顶）、crown 登顶、swap 前三之内往上换位、
 * podium 冲进前三、displaced 名次被人抢走（还在前三）、out 跌出前三。
 * @param {{key?: string, name: string, rank: number}[]} rows
 * @returns {Map<string, string>}
 */
function topEvents(rows) {
    const events = new Map();
    /** 上一次各名次是谁 */
    const holders = new Map([...lastRanks].map(([id, rank]) => [rank, id]));
    for (const row of rows) {
        const id = row.key ?? row.name;
        const before = lastRanks.get(id);
        if (before === undefined || row.rank >= before || row.rank > 3) continue;
        const jump = before - row.rank;
        events.set(id, jump >= 3 || (row.rank === 1 && before > 3) ? 'upset' : row.rank === 1 ? 'crown' : before <= 3 ? 'swap' : 'podium');
        const displaced = holders.get(row.rank);
        if (displaced !== undefined && displaced !== id && !events.has(displaced)) events.set(displaced, 'displaced');
    }
    for (const row of rows) {
        const id = row.key ?? row.name;
        const before = lastRanks.get(id);
        if (before !== undefined && before <= 3 && row.rank > 3) events.set(id, 'out');
    }
    return events;
}

/** 表情持续多久 */
const MOOD_MS = { excited: 3600, happy: 2400, shocked: 3000, sad: 3200 };
/** 被挤下去时，原来的脸和新名次的脸各哭多久 */
const CRY_MS = 1800;

/**
 * 名次那一格跟着发生的事换表情，过几秒自己换回来（期间刷新也接着播）：
 * - 前三之内：下克上、登顶得意，往上换位、冲进前三、加分开心，被顶替吃惊，名次往下掉难过。
 * - 从有脸的名次（前五）掉到前三以外：原来的脸先哭（前三是那只猫娘），再换新名次的哭脸
 *   （第四、五名有），然后才是新名次平时的样子。
 * @param {{key?: string, name: string, rank: number, value: number}[]} rows
 * @param {Map<string, string>} events topEvents() 的结果
 * @param {number} now
 */
function setMoods(rows, events, now) {
    for (const row of rows) {
        const id = row.key ?? row.name;
        const event = events.get(id);
        const previousRank = lastRanks.get(id);
        const previous = lastValues.get(id);
        /** @type {{ms: number, catgirl?: number, face?: string, place?: number}[]} */
        const phases = [];
        if (previousRank !== undefined && row.rank > previousRank && previousRank <= 5 && row.rank > 3) {
            if (previousRank <= 3) phases.push({ catgirl: previousRank, face: 'sad', ms: PLACE_SAD_FACES[row.rank] ? CRY_MS : MOOD_MS.sad });
            else if (PLACE_SAD_FACES[previousRank]) phases.push({ place: previousRank, ms: CRY_MS });
            if (PLACE_SAD_FACES[row.rank]) phases.push({ place: row.rank, ms: CRY_MS });
        } else if (row.rank <= 3) {
            let face = null;
            if (event === 'upset' || event === 'crown') face = 'excited';
            else if (event === 'swap' || event === 'podium') face = 'happy';
            else if (event === 'displaced') face = 'shocked';
            else if (previousRank !== undefined && row.rank > previousRank) face = 'sad';
            else if (previous !== undefined && significant(view.metric, row.value - previous) && row.value > previous) face = 'happy';
            if (face) phases.push({ catgirl: row.rank, face, ms: MOOD_MS[face] });
        }
        if (!phases.length) continue;
        const until = now + phases.reduce((sum, phase) => sum + phase.ms, 0);
        moods.set(id, { start: now, until, phases });
        // 没有新数据就不会重画：每换一段、播完时把这一格重画一次
        let at = 0;
        for (const phase of phases) {
            at += phase.ms;
            setTimeout(() => redrawRankCell(id, until), at + 30);
        }
    }
}

/**
 * @param {string} id 行的 key
 * @param {number} until 是哪一次的表情（期间又有新的表情就不管）
 */
function redrawRankCell(id, until) {
    if (moods.get(id)?.until !== until) return;
    if (Date.now() >= until) moods.delete(id);
    const cell = popup?.list.querySelector(`.leaderboard-row[data-key="${CSS.escape(id)}"] .leaderboard-rank`);
    if (cell && lastRanks.has(id)) cell.replaceWith(rankCell(lastRanks.get(id), view.metric === 'score', moods.get(id)));
}

/**
 * 换了名次的行从原来的位置滑到新位置（往上走的盖在别人上面），新上榜的从左边滑进来。
 * 前三名的变动走得更有戏：互换时两行交叉划弧，下克上先蓄力再冲上去。
 * @param {HTMLElement} list
 * @param {Map<string, number>} before 刷新前的位置
 * @param {Map<string, string>} events topEvents() 的结果
 */
function slideRows(list, before, events) {
    const after = rowTops(list);
    for (const row of list.querySelectorAll('.leaderboard-row[data-key]')) {
        const from = before.get(row.dataset.key);
        if (from === undefined) {
            row.animate([{ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
            continue;
        }
        const dy = from - after.get(row.dataset.key);
        if (Math.abs(dy) < 1) continue;
        row.classList.add(dy > 0 ? 'leaderboard-moving-up' : 'leaderboard-moving-down');
        const event = events.get(row.dataset.key);
        let frames = [{ transform: `translateY(${dy}px)` }, { transform: 'none' }];
        let duration = Math.min(900, 400 + Math.abs(dy) * 0.5);
        if (event === 'upset') {
            frames = [
                { transform: `translateY(${dy}px) scale(1)` },
                { transform: `translateY(${dy + 6}px) scale(0.97)`, offset: 0.18 },
                { transform: `translateY(${dy * 0.3}px) scale(1.06)`, offset: 0.62 },
                { transform: 'translateY(-6px) scale(1.04)', offset: 0.82 },
                { transform: 'none' },
            ];
            duration = 1000;
        } else if (event === 'swap' || event === 'crown' || (event === 'displaced' && dy < 0)) {
            // 交叉换位：往上的从右边划过去，往下的从左边
            const side = dy > 0 ? 16 : -16;
            frames = [{ transform: `translateY(${dy}px)` }, { transform: `translate(${side}px, ${dy / 2}px) scale(${dy > 0 ? 1.04 : 0.97})`, offset: 0.5 }, { transform: 'none' }];
            duration = 750;
        }
        const animation = row.animate(frames, { duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
        const done = () => row.classList.remove('leaderboard-moving-up', 'leaderboard-moving-down');
        animation.addEventListener('finish', done);
        animation.addEventListener('cancel', done);
        // 跌出前三：名字和分数先褪成灰色（名次那一格不褪：那里的猫娘在哭）
        if (event === 'out') {
            for (const cell of row.querySelectorAll('.leaderboard-name, .leaderboard-value')) {
                cell.animate([{ filter: 'grayscale(1) brightness(0.75)' }, { filter: 'grayscale(1) brightness(0.75)', offset: 0.4 }, { filter: 'none' }], { duration: 1800, easing: 'ease-out' });
            }
        }
    }
    // 下克上：落定时整个列表震一下
    if ([...events.values()].includes('upset')) {
        list.animate([{ transform: 'none' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }], { duration: 420, delay: 760, easing: 'ease-out' });
    }
}

function render(board) {
    if (!popup) return;
    const rows = board.rows ?? [];
    const metric = view.metric;
    const fancy = metric === 'score';
    // 版本号是「数据版本-这一期」，管理员测试时后面还有「-t测试值」
    const period = String(board.version ?? '').split('-')[1] ?? '';
    // 刚打开、换了榜、换了一期（新的一小时或一天）：直接显示，不算涨跌
    const fresh = lastValues.size === 0 || period !== lastPeriod;
    if (fresh) moveMarks.clear();
    const animate = !fresh && !calmMotion();
    const before = animate ? rowTops(popup.list) : null;
    const now = Date.now();
    const events = animate ? topEvents(rows) : new Map();
    if (animate && fancy) setMoods(rows, events, now);
    const values = new Map();
    const ranks = new Map();
    const fragment = document.createDocumentFragment();
    if (!rows.length) {
        const empty = { hour: '这个小时还没有人上榜，去聊两句就是第一名', today: '今天还没有人上榜，去聊两句就是第一名' };
        fragment.append(h('div', { class: 'leaderboard-empty', text: empty[view.window] ?? '这里还没有人上榜' }));
    }
    for (const row of rows) {
        // 打码后的名字可能撞车，行按服务器给的 key 区分
        const id = row.key ?? row.name;
        const previous = lastValues.get(id);
        const previousRank = lastRanks.get(id);
        values.set(id, row.value);
        ranks.set(id, row.rank);
        if (!fresh && previousRank === undefined) {
            moveMarks.set(id, { kind: 'new', text: 'NEW', at: now });
        } else if (!fresh && row.rank !== previousRank) {
            const up = row.rank < previousRank;
            moveMarks.set(id, { kind: up ? 'up' : 'down', text: `${up ? '▲' : '▼'}${Math.abs(previousRank - row.rank)}`, at: now });
        }
        const mark = moveMarks.get(id);
        const breakdown = row.parts ? formatScoreParts(row.parts, board.scoreParts) : '';
        const canRemove = !!(board.admin && row.id);
        const expandable = !!breakdown || canRemove;
        const expanded = expandable && expandedRows.has(id);
        const valueText = h('span', { class: 'leaderboard-value-text', text: formatLeaderboardValue(metric, row.value) });
        const valueCell = h('span', { class: 'leaderboard-value' },
            // 名次变化的标记，几秒后淡出（刷新后从原来的进度接着淡）
            mark ? h('span', { class: `leaderboard-move ${mark.kind}`, style: `animation-delay: -${now - mark.at}ms`, text: mark.text }) : null,
            valueText);
        const sparkles = row.rank <= 3 ? SPARKLES[fancy ? 'score' : 'other'][row.rank] ?? 0 : 0;
        const element = h('div', {
            class: `leaderboard-row${row.rank <= 3 ? ` leaderboard-top leaderboard-top${row.rank}` : ''}${PLACE_FACES[row.rank] ? ` leaderboard-place${row.rank}` : ''}${row.me ? ' leaderboard-row-me' : ''}${expandable ? ' leaderboard-row-expandable' : ''}${expanded ? ' expanded' : ''}`,
            'data-key': id,
            title: breakdown || null,
        },
        rankCell(row.rank, fancy, moods.get(id)),
        h('span', { class: 'leaderboard-name' },
            h('span', { class: `leaderboard-name-text${row.anonymous ? ' leaderboard-anonymous' : ''}`, text: row.name, title: row.anonymous ? '匿名' : '' }),
            row.emoji ? h('span', { class: 'leaderboard-emoji', text: row.emoji }) : null,
            row.me ? h('span', { class: 'leaderboard-you', text: '我' }) : null,
            row.admin ? adminBadge() : null,
            ...siteBadges(row.sites)),
        valueCell,
        expandable ? h('span', { class: 'leaderboard-row-details' },
            breakdown ? h('span', { class: 'leaderboard-row-parts', text: breakdown }) : null,
            // 管理员的「移出」收在点开后的详情里，不占名字的地方
            canRemove ? h('button', {
                type: 'button',
                class: 'leaderboard-admin-action',
                onclick: event => {
                    event.stopPropagation();
                    void askToChooseAgain({ id: row.id }, row.name);
                },
            }, h('i', { class: 'fa-solid fa-rotate-left' }), h('span', { text: '让 TA 重新选' })) : null,
            canRemove && row.emoji ? h('button', {
                type: 'button',
                class: 'leaderboard-admin-action',
                onclick: event => {
                    event.stopPropagation();
                    void clearEmoji(row.id, row.name);
                },
            }, h('i', { class: 'fa-solid fa-face-meh-blank' }), h('span', { text: '清除表情' })) : null,
            canRemove ? h('button', {
                type: 'button',
                class: 'leaderboard-remove',
                onclick: event => {
                    event.stopPropagation();
                    void setRemoved(row.id, row.name, true);
                },
            }, h('i', { class: 'fa-solid fa-user-slash' }), h('span', { text: '移出榜单' })) : null) : null,
        sparkles ? h('span', { class: 'leaderboard-sparkles', 'aria-hidden': 'true' }, ...Array.from({ length: sparkles }, () => h('i'))) : null);
        if (expandable) {
            // 手机上没有悬停提示：点一下展开
            element.addEventListener('click', () => {
                if (expandedRows.has(id)) expandedRows.delete(id);
                else expandedRows.add(id);
                element.classList.toggle('expanded', expandedRows.has(id));
            });
        }
        if (animate) {
            const delta = previous === undefined ? 0 : row.value - previous;
            if (previous === undefined) {
                burst(element, 'gain');
            } else if (significant(metric, delta)) {
                tweenValue(valueText, previous, row.value, metric);
                floatDelta(valueCell, metric, delta);
                burst(element, delta > 0 ? 'gain' : 'loss');
            }
            const event = events.get(id);
            if (event) burst(element, event, TOP_EVENT_LABELS[event]);
            // 被抢走名次的：头像或奖牌晃一下
            if (event === 'displaced' || event === 'out' || (previousRank === 1 && row.rank > 1)) element.classList.add('leaderboard-dethroned');
        }
        fragment.append(element);
    }
    for (const [id, mark] of moveMarks) {
        if (now - mark.at > MOVE_MARK_MS || !values.has(id)) moveMarks.delete(id);
    }
    lastValues = values;
    lastRanks = ranks;
    lastPeriod = period;
    // 一直转的边框、流光按页面打开以来的时间对齐：每次刷新重建的行接着转，不会跳回起点
    popup.root.style.setProperty('--lb-clock', String(Math.round(performance.now())));
    popup.list.classList.toggle('leaderboard-list-score', fancy);
    popup.list.replaceChildren(fragment);
    if (before) slideRows(popup.list, before, events);
    updateHint();
    renderMe(board, animate);
    renderTest(board);
    renderFooter(board);
    fitNames();
}

/**
 * 名字不省略、不换行：放不下就把这个名字的字缩小到正好放下。
 */
function fitNames() {
    if (!popup) return;
    for (const box of popup.root.querySelectorAll('.leaderboard-name, .leaderboard-me-name')) {
        const text = box.querySelector('.leaderboard-name-text, .leaderboard-me-name-text');
        if (!(text instanceof HTMLElement)) continue;
        text.style.fontSize = '';
        for (let size = 1; box.scrollWidth > box.clientWidth + 1 && size > 0.6; size -= 0.05) {
            text.style.fontSize = `${size.toFixed(2)}em`;
        }
    }
}

/**
 * @param {any} board
 * @param {boolean} animate 涨跌要不要动起来
 */
function renderMe(board, animate) {
    if (!popup) return;
    const me = board.me;
    if (!me) {
        popup.me.replaceChildren();
        lastMeValue = null;
        return;
    }
    const valueText = h('span', { class: 'leaderboard-value-text', text: formatLeaderboardValue(view.metric, me.value) });
    const valueCell = h('span', { class: 'leaderboard-me-value' }, valueText);
    if (animate && lastMeValue !== null && significant(view.metric, me.value - lastMeValue)) {
        tweenValue(valueText, lastMeValue, me.value, view.metric);
        floatDelta(valueCell, view.metric, me.value - lastMeValue);
    }
    lastMeValue = me.value;
    const status = me.banned ? '已被管理员移出榜单' : me.rank ? `第 ${me.rank} 名` : '还没上榜';
    // 手机上只写「还差 …」（前半句藏起来），免得把数字挤成省略号
    const gap = me.rank && me.gap
        ? h('small', { class: 'leaderboard-gap' }, h('span', { class: 'leaderboard-gap-prefix', text: '距上一名' }), `还差 ${formatLeaderboardValue(view.metric, me.gap)}`)
        : (me.rank === 1 ? h('small', { class: 'leaderboard-gap', text: '目前第一' }) : null);
    // replaceChildren 会把 null 当成文字「null」显示出来，没有的部分要先去掉
    popup.me.replaceChildren(...[
        h('div', { class: 'leaderboard-me-main' },
            h('span', { class: 'leaderboard-me-rank', text: status }),
            h('span', { class: 'leaderboard-me-name' },
                h('span', { class: `leaderboard-me-name-text${me.mode === 'public' ? '' : ' leaderboard-anonymous'}`, text: me.name }),
                h('button', {
                    type: 'button',
                    class: `leaderboard-emoji-button${me.emoji ? '' : ' empty'}`,
                    title: me.emoji ? '更换或删除名字旁的表情' : '在名字旁加一个表情',
                    onclick: () => showEmojiEditor(me),
                }, me.emoji || h('i', { class: 'fa-regular fa-face-smile' }))),
            valueCell),
        me.parts ? h('div', { class: 'leaderboard-me-parts', text: formatScoreParts(me.parts, board.scoreParts) }) : null,
        // 第二行：标识在左，差距和设置在右（一行放不下名字、标识和按钮）
        h('div', { class: 'leaderboard-me-side' },
            h('span', { class: 'leaderboard-me-tags' },
                me.admin ? adminBadge() : null,
                ...siteBadges(me.sites),
                me.testing ? h('span', { class: 'leaderboard-testing-tag', text: '测试中', title: '只有你自己看得到这个名次' }) : null),
            gap,
            board.admin ? h('button', {
                type: 'button',
                class: `leaderboard-settings leaderboard-test-toggle${testOpen ? ' active' : ''}`,
                title: '测试我的名次（只有自己看得到）',
                onclick: () => {
                    testOpen = !testOpen;
                    renderMe(board, false);
                    renderTest(board);
                },
            }, h('i', { class: 'fa-solid fa-flask' })) : null,
            h('button', {
                type: 'button',
                class: 'leaderboard-settings',
                title: '改成实名或匿名',
                onclick: () => void openSettings(),
            }, h('i', { class: 'fa-solid fa-user-gear' }), h('span', { text: MODE_TEXT[me.mode] ?? '设置' }))),
    ].filter(Boolean));
}

// ---------- 管理员测试自己的名次（只有自己看得到，不计入数据） ----------

let testOpen = false;
/** 每点一下加减多少：[小, 大] */
const TEST_STEPS = { score: [1, 10], words: [1000, 10000], online: [600000, 3600000], active: [1, 5], streak: [1, 5], variety: [1, 5] };

function stepText(metric, step) {
    if (metric === 'online') return step >= 3600000 ? `${step / 3600000}小时` : `${step / 60000}分钟`;
    if (metric === 'words') return step >= 10000 ? `${step / 10000}万` : `${step / 1000}千`;
    return String(step);
}

/**
 * 管理员：加减自己的数值、放到某个名次、一键还原（所有榜单）。改完马上刷新，列表的特效照常播放。
 * @param {any} board
 */
function renderTest(board) {
    if (!popup) return;
    const show = !!board?.admin && testOpen;
    popup.test.classList.toggle('displayNone', !show);
    if (!show) {
        popup.test.replaceChildren();
        return;
    }
    const me = board.me;
    const [small, big] = TEST_STEPS[view.metric] ?? [1, 10];
    const format = value => formatLeaderboardValue(view.metric, value);
    const button = (text, body, title) => h('button', { type: 'button', class: 'leaderboard-test-button', text, title, onclick: () => void tryTest(body) });
    popup.test.replaceChildren(
        h('div', { class: 'leaderboard-test-head' },
            h('i', { class: 'fa-solid fa-flask' }),
            h('b', { text: '测试我的名次' }),
            h('small', { text: me?.testing ? `测试值 ${format(me.value)}，真实 ${format(me.real)}` : '只有你自己看得到，不计入数据' })),
        h('div', { class: 'leaderboard-test-actions' },
            button(`−${stepText(view.metric, big)}`, { step: -big }),
            button(`−${stepText(view.metric, small)}`, { step: -small }),
            button(`+${stepText(view.metric, small)}`, { step: small }),
            button(`+${stepText(view.metric, big)}`, { step: big }),
            h('span', { class: 'leaderboard-test-sep' }),
            ...[1, 2, 3, 10].map(rank => button(`第${rank}`, { rank }, `放到第 ${rank} 名`)),
            h('span', { class: 'leaderboard-test-sep' }),
            button('一键还原', { reset: true }, '所有榜单都回到真实数据')));
}

/**
 * @param {{step?: number, rank?: number, reset?: boolean}} body
 */
async function tryTest(body) {
    try {
        const response = await fetch('/api/leaderboard/admin/test', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ metric: view.metric, window: view.window, site: view.site, ...body }) });
        if (!response.ok) throw new Error(String(response.status));
        if (body.reset) toastr.success('已还原，所有榜单回到真实数据');
        await refresh();
    } catch {
        toastr.error('测试操作失败，请稍后再试');
    }
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

// ---------- 设置：实名 / 匿名 ----------

function hidePanel() {
    popup?.panel.classList.add('displayNone');
    popup?.panel.replaceChildren();
}

function showRules() {
    if (!popup) return;
    const since = lastBoard?.countingSince ? new Date(lastBoard.countingSince).toLocaleDateString('zh-CN') : '';
    const scoreParts = lastBoard?.scoreParts ?? DEFAULT_SCORE_PARTS;
    const caps = lastBoard?.dailyCaps ?? DEFAULT_DAILY_CAPS;
    const total = scoreParts.reduce((sum, part) => sum + part.weight, 0);
    const labelOf = metric => SCORE_LABELS[metric] ?? metricOf(metric).label;
    /** @type {Map<string, {metric: string, weight: number}[]>} */
    const dimensions = new Map();
    for (const part of scoreParts) dimensions.set(part.dimension ?? '', [...(dimensions.get(part.dimension ?? '') ?? []), part]);
    const units = scoreParts.filter(part => part.unit !== 1).map(part => part.metric === 'online'
        ? `时长按${part.unit === 60000 ? '' : ` ${part.unit / 60000} `}分钟计`
        : part.metric === 'words' ? `字数按${part.unit === 100 ? '百' : ` ${part.unit} `}字计` : `${labelOf(part.metric)}按 ${part.unit} 计`);
    /** 两列对照：左边名称，右边说明 */
    const definitions = rows => h('dl', { class: 'leaderboard-defs' }, ...rows.flatMap(([term, text]) => [h('dt', { text: term }), h('dd', { text })]));
    const removed = lastBoard?.admin ? (lastBoard.removed ?? []) : null;
    popup.panel.replaceChildren(h('div', { class: 'leaderboard-card leaderboard-rules' },
        h('h3', { text: '计算规则' }),
        h('h4', { text: '综合分' }),
        h('div', { class: 'leaderboard-formula' },
            h('div', { text: '单项分 = ln(1+数值) ÷ ln(1+最高值)' }),
            h('div', { text: `综合分 = Σ 单项分 × 权重（满分 ${total}）` })),
        h('div', { class: 'leaderboard-weights' },
            ...[...dimensions].map(([dimension, parts]) => h('div', { class: 'leaderboard-weight-row' },
                h('span', { class: 'leaderboard-weight-dimension', text: `${DIMENSION_LABELS[dimension] ?? '其他'} ${parts.reduce((sum, part) => sum + part.weight, 0)}` }),
                h('span', { class: 'leaderboard-weight-parts', text: parts.map(part => `${labelOf(part.metric)} ${part.weight}`).join(' · ') })))),
        h('p', { class: 'leaderboard-rules-note', text: `取对数使数值越高增长越慢，鼓励各项均衡。最高值取同一时间范围、同一站点下的最高者${units.length ? `；${units.join('，')}` : ''}；连续天数不受时间范围影响。` }),
        h('h4', { text: '各榜统计' }),
        definitions(METRICS.filter(metric => metric.id !== 'score').map(metric => [metric.label, metric.hint])),
        h('h4', { text: '其他规则' }),
        definitions([
            ['时间', '北京时间。本小时、今日分别在整点、零点重置，本周自周一起。'],
            ['两站', '同一 Discord 账号合并为一人；名字后的标记表示数据来源站点。'],
            ['名称', '实名显示「昵称#编号」，匿名显示「匿名用户#编号」，编号终身不变；名字旁可加一个表情。'],
            ['计入', '仅统计真实生成的回复；导入、复制的聊天不计入，刷榜者会被移出榜单。'],
            ['上限', `每人每日最多计入 AI 回复 ${caps.ai} 条、消息 ${caps.user} 条、字数 ${caps.chars / 10000} 万、时长 16 小时。`],
            ['历史', since ? `${since} 前的数据按现有聊天记录补算；时长和本小时榜自该日起统计。` : '上线前的数据按现有聊天记录补算；时长和本小时榜自上线起统计。'],
        ]),
        removed ? h('h4', { text: '让某人重新选实名/匿名（仅管理员可见）' }) : null,
        removed ? chooseAgainForm() : null,
        removed ? h('h4', { text: '已移出榜单（仅管理员可见）' }) : null,
        removed ? (removed.length
            ? h('div', { class: 'leaderboard-removed' }, ...removed.map(person => h('div', { class: 'leaderboard-removed-row' },
                h('span', { text: person.name }),
                ...siteBadges(person.sites),
                h('button', { type: 'button', class: 'menu_button', text: '恢复', onclick: () => void setRemoved(person.id, person.name, false) }))))
            : h('p', { class: 'leaderboard-note', text: '无' })) : null,
        h('div', { class: 'leaderboard-card-actions' },
            h('button', { type: 'button', class: 'menu_button', text: '知道了', onclick: hidePanel }))));
    popup.panel.classList.remove('displayNone');
}

/** 管理员：输入本站的账号，让这个人重新选 */
function chooseAgainForm() {
    const input = h('input', { type: 'text', class: 'text_pole', placeholder: '本站的账号，例如 example-123' });
    const submit = () => {
        const handle = input instanceof HTMLInputElement ? input.value.trim() : '';
        if (handle) void askToChooseAgain({ handle }, handle, false);
    };
    input.addEventListener('keydown', event => event.key === 'Enter' && submit());
    return h('div', { class: 'leaderboard-choose-again' },
        input,
        h('button', { type: 'button', class: 'menu_button', text: '重新弹出', onclick: submit }));
}

/**
 * 管理员让某人重新选实名/匿名：撤回 TA 的选择，TA 打开着的页面立即弹出公告（实时推送；另一个站的
 * 页面在两站同步后，几秒内）
 * @param {{id?: string, handle?: string}} who
 * @param {string} name
 * @param {boolean} [confirm] 先问一下
 */
async function askToChooseAgain(who, name, confirm = true) {
    if (confirm && !await callGenericPopup(`让「${name}」重新选实名还是匿名？TA 打开着的页面会立即弹出上线公告（没选之前按匿名显示）。`, POPUP_TYPE.CONFIRM)) {
        return;
    }
    try {
        const response = await fetch('/api/leaderboard/admin/reset-choice', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(who) });
        if (response.status === 404) {
            toastr.warning(who.handle ? `本站没有「${name}」这个账号（另一个站的人要到那个站操作）` : '这个人的账号不在本站，请到另一个站操作');
            return;
        }
        if (!response.ok) throw new Error(String(response.status));
        const { pages = 0 } = await response.json().catch(() => ({}));
        toastr.success(pages
            ? `「${name}」打开着的 ${pages} 个页面正在弹出选择；另一个站的页面几秒内弹出`
            : `「${name}」在本站没有打开着的页面，下次打开时弹出；另一个站的页面几秒内弹出`);
        boardVersion = '';
        await refresh();
    } catch {
        toastr.error('操作失败，请稍后再试');
    }
}

/**
 * 管理员把某人移出榜单（或恢复），两个站都生效
 * @param {string} id
 * @param {string} name
 * @param {boolean} banned
 */
async function setRemoved(id, name, banned) {
    if (banned && !await callGenericPopup(`把「${name}」移出榜单？两个站的榜上都不再显示，本人会看到「已被管理员移出榜单」。之后可以在 ⓘ 里恢复。`, POPUP_TYPE.CONFIRM)) {
        return;
    }
    try {
        const response = await fetch('/api/leaderboard/admin/ban', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id, banned }) });
        if (!response.ok) throw new Error(String(response.status));
        toastr.success(banned ? `已把「${name}」移出榜单` : `已恢复「${name}」`);
        if (!banned) hidePanel();
        boardVersion = '';
        await refresh();
    } catch {
        toastr.error('操作失败，请稍后再试');
    }
}

/**
 * 管理员清除某人名字旁的表情（所有榜单、两个站）
 * @param {string} id
 * @param {string} name
 */
async function clearEmoji(id, name) {
    if (!await callGenericPopup(`清除「${name}」名字旁的表情？所有榜单、两个站都会去掉，TA 之后还能重新设置。`, POPUP_TYPE.CONFIRM)) return;
    try {
        const response = await fetch('/api/leaderboard/admin/clear-emoji', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id }) });
        if (response.status === 404) {
            toastr.warning('这个人的账号不在本站，请到另一个站操作');
            return;
        }
        if (!response.ok) throw new Error(String(response.status));
        toastr.success(`已清除「${name}」的表情`);
        boardVersion = '';
        await refresh();
    } catch {
        toastr.error('操作失败，请稍后再试');
    }
}

/** 选表情时的常用表情（老设备也能显示的） */
const EMOJI_CHOICES = ['🔥', '⭐', '🌙', '☀️', '❄️', '⚡', '🌈', '🌸', '🍀', '🍁', '🌻', '🌊', '💖', '💎', '👑', '🏆', '🎯', '🚀', '🎮', '🎵', '🎨', '📚', '☕', '🍰', '🍓', '🍜', '🐱', '🐶', '🦊', '🐼', '🐰', '🐧', '🦄', '🐉', '😎', '🤖', '👻', '✨', '💤', '🌟'];

/**
 * @param {string} text
 * @returns {string} 正好一个表情，否则 ''（服务器还会再查一遍）
 */
function singleEmoji(text) {
    const value = String(text ?? '').trim();
    if (!value || value.length > 16) return '';
    if (typeof Intl.Segmenter === 'function' && [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length !== 1) return '';
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value) ? value : '';
}

/**
 * 名字旁的表情：只用在这个榜，或者所有榜单；可换可删。
 * @param {{name: string, emoji?: string, emojis?: Record<string, string>}} me
 */
function showEmojiEditor(me) {
    if (!popup) return;
    const metric = metricOf(view.metric);
    const emojis = me.emojis ?? {};
    const ownHere = Object.hasOwn(emojis, metric.id);
    let scope = !ownHere && emojis.all ? 'all' : 'board';
    let selected = me.emoji ?? '';
    const preview = h('span', { class: 'leaderboard-emoji-preview' });
    const error = h('div', { class: 'leaderboard-error' });
    const input = h('input', { type: 'text', class: 'text_pole leaderboard-emoji-input', placeholder: '或者输入、粘贴任意一个表情', maxlength: '16' });
    const grid = h('div', { class: 'leaderboard-emoji-grid' }, ...EMOJI_CHOICES.map(emoji => h('button', {
        type: 'button',
        class: 'leaderboard-emoji-choice',
        'data-emoji': emoji,
        text: emoji,
        onclick: () => {
            if (input instanceof HTMLInputElement) input.value = '';
            pick(emoji);
        },
    })));
    const scopes = h('div', { class: 'leaderboard-emoji-scopes' });
    const remove = h('button', { type: 'button', class: 'menu_button leaderboard-emoji-remove', onclick: () => void save('') });
    const saveButton = h('button', { type: 'button', class: 'menu_button leaderboard-primary', text: '保存', onclick: () => void save(selected) });
    function pick(emoji) {
        selected = emoji;
        error.textContent = '';
        preview.replaceChildren(h('span', { class: 'leaderboard-emoji-preview-name', text: me.name }), emoji ? h('span', { class: 'leaderboard-emoji', text: emoji }) : h('small', { class: 'leaderboard-note', text: '（没有表情）' }));
        grid.querySelectorAll('.leaderboard-emoji-choice').forEach(button => button.classList.toggle('selected', button.getAttribute('data-emoji') === emoji));
        if (saveButton instanceof HTMLButtonElement) saveButton.disabled = !emoji;
    }
    function setScope(value) {
        scope = value;
        scopes.replaceChildren(segment([{ id: 'board', label: `仅「${metric.label}」榜` }, { id: 'all', label: '所有榜单' }], scope, setScope, 'leaderboard-emoji-scope'));
        remove.replaceChildren(h('i', { class: 'fa-solid fa-trash-can' }), h('span', { text: scope === 'all' ? '删除所有榜单的表情' : `删除「${metric.label}」榜的表情` }));
    }
    input.addEventListener('input', () => {
        const value = input instanceof HTMLInputElement ? input.value : '';
        const emoji = singleEmoji(value);
        if (emoji) pick(emoji);
        else if (value.trim()) error.textContent = '只能是一个表情';
    });
    async function save(emoji) {
        try {
            const response = await fetch('/api/leaderboard/me/emoji', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ scope: scope === 'all' ? 'all' : metric.id, emoji }) });
            if (!response.ok) {
                error.textContent = response.status === 400 ? '只能是一个表情' : '保存失败，请稍后再试';
                return;
            }
            hidePanel();
            toastr.success(emoji ? `已${scope === 'all' ? '在所有榜单' : `在「${metric.label}」榜`}名字旁加上 ${emoji}` : '已删除表情');
            boardVersion = '';
            void refresh();
        } catch {
            error.textContent = '保存失败，请稍后再试';
        }
    }
    setScope(scope);
    popup.panel.replaceChildren(h('div', { class: 'leaderboard-card leaderboard-emoji-editor' },
        h('h3', { text: '名字旁的表情' }),
        preview,
        scopes,
        grid,
        input,
        error,
        h('small', { class: 'leaderboard-note', text: '每个榜可以用不同的表情；设为「所有榜单」会替换各榜单独设的。两个站一起生效。' }),
        h('div', { class: 'leaderboard-card-actions' },
            remove,
            h('span', { class: 'leaderboard-spacer' }),
            h('button', { type: 'button', class: 'menu_button', text: '取消', onclick: hidePanel }),
            saveButton)));
    pick(selected);
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
 * @param {{mode: string, explicit: boolean, anonymousName: string, publicName: string, sites: string[]}} me
 * @param {boolean} first 第一次打开时的询问
 */
function showChoice(me, first) {
    if (!popup) return;
    // 没选过时先选中「实名」
    let mode = me.explicit ? me.mode : 'public';
    const error = h('div', { class: 'leaderboard-error' });
    const option = (value, title, detail) => h('label', { class: 'leaderboard-option', 'data-mode': value },
        h('input', { type: 'radio', name: 'leaderboard-mode', value, onchange: () => select(value) }),
        h('span', { class: 'leaderboard-option-text' }, h('b', { text: title }), h('small', { text: detail })));
    const options = h('div', { class: 'leaderboard-options' },
        option('public', `实名（显示「${me.publicName}」）`, '你的账号昵称加编号，以后发奖励一眼就能找到你'),
        option('anon', `匿名（显示「${me.anonymousName}」）`, '只显示「匿名用户」和你的编号'));
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
        try {
            const response = await fetch('/api/leaderboard/me', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ mode }) });
            if (!response.ok) {
                error.textContent = '保存失败，请稍后再试';
                return;
            }
            hidePanel();
            toastr.success(`之后排行榜上显示「${mode === 'public' ? me.publicName : me.anonymousName}」`);
            boardVersion = '';
            void refresh();
        } catch {
            error.textContent = '保存失败，请稍后再试';
        }
    }
    const both = (me.sites ?? []).length > 1;
    popup.panel.replaceChildren(h('div', { class: 'leaderboard-card' },
        h('h3', { text: first ? '你想怎么出现在榜上？' : '排行榜设置' }),
        first ? h('p', { text: `不选的话默认匿名，显示「${me.anonymousName}」。` }) : null,
        first ? h('p', { text: '实名也只显示你的账号昵称和编号、次数字数这些数字，不会显示你的角色或聊天内容。' }) : null,
        options,
        error,
        h('small', { class: 'leaderboard-note', text: both ? '你在两个站用的是同一个 Discord 账号，这个设置两个站一起生效。以后可以在榜单底部随时改。' : '以后可以在榜单底部随时改。' }),
        h('div', { class: 'leaderboard-card-actions' },
            first ? null : h('button', { type: 'button', class: 'menu_button', text: '取消', onclick: hidePanel }),
            h('button', { type: 'button', class: 'menu_button leaderboard-primary', text: '确定', onclick: () => void save() }))));
    select(mode);
    popup.panel.classList.remove('displayNone');
}

// ---------- 上线公告：必须选「实名」或「匿名」，选过（哪个站都行）就不再出现 ----------

/** 等别的启动弹窗先出来，免得两个叠在一起 */
const NOTICE_DELAY_MS = 1500;
let noticeChecking = false;
/** 这个页面里点过「先跳过」：等下次打开页面再问 */
let noticeSkipped = false;

/** 系统公告、通行密钥提示之类的弹窗还开着就先等着 */
function screenIsBusy() {
    return !!(document.getElementById('announcementsPopup') || document.querySelector('dialog.popup[open]') || popup);
}

// 管理员让我重新选（实时推送）：马上弹出，「先跳过」过也重新问
onLive('leaderboard-choose', () => {
    noticeSkipped = false;
    void maybeShowLaunchNotice();
});

async function maybeShowLaunchNotice() {
    if (noticeChecking || noticeSkipped || document.getElementById('leaderboardNotice')) return;
    noticeChecking = true;
    try {
        await new Promise(resolve => {
            if (!screenIsBusy()) return resolve();
            const timer = setInterval(() => {
                if (screenIsBusy()) return;
                clearInterval(timer);
                resolve();
            }, 800);
        });
        // 等的时候可能已经在排行榜里或另一个站选过了：现在再问服务器
        const response = await fetch('/api/leaderboard/me', { cache: 'no-store' });
        if (!response.ok) return;
        const me = await response.json();
        if (me && !me.explicit && !screenIsBusy() && !noticeSkipped) showLaunchNotice(me);
    } catch {
        // 下次再问
    } finally {
        noticeChecking = false;
    }
}

/**
 * @param {{anonymousName: string, publicName: string}} me
 */
function showLaunchNotice(me) {
    if (document.getElementById('leaderboardNotice')) return;
    let failures = 0;
    let saving = false;
    const error = h('div', { class: 'leaderboard-notice-error', role: 'alert' });
    const choice = (mode, recommended, title, detail) => h('button', {
        type: 'button',
        class: `leaderboard-notice-choice ${recommended ? 'leaderboard-notice-primary' : 'leaderboard-notice-secondary'}`,
        'data-mode': mode,
        onclick: event => void choose(mode, event.currentTarget),
    },
    recommended ? h('span', { class: 'leaderboard-notice-badge', text: '推荐' }) : null,
    h('span', { class: 'leaderboard-notice-choice-title' },
        h('i', { class: `fa-solid ${recommended ? 'fa-user-check' : 'fa-user-secret'}` }),
        h('span', { text: title })),
    h('span', { class: 'leaderboard-notice-choice-detail', text: detail }));
    // 一直保存不了也不能把人卡在这里：失败两次后给个出口，下次打开页面再问
    const skip = h('button', {
        type: 'button',
        class: 'leaderboard-notice-skip displayNone',
        text: '先跳过，下次再选',
        onclick: () => {
            noticeSkipped = true;
            close();
        },
    });
    const root = h('div', { id: 'leaderboardNotice', class: 'leaderboard-notice-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'leaderboardNoticeTitle' },
        h('div', { class: 'leaderboard-notice' },
            h('div', { class: 'leaderboard-notice-hero' },
                h('i', { class: 'fa-solid fa-trophy leaderboard-notice-trophy' }),
                h('h2', { id: 'leaderboardNoticeTitle', text: '排行榜上线啦' }),
                h('p', { text: '两个站一起排名 · 每 3 秒实时更新' })),
            h('ul', { class: 'leaderboard-notice-points' },
                h('li', {},
                    h('i', { class: 'fa-solid fa-ranking-star' }),
                    h('span', {}, '综合、聊天、字数、时长、夜猫子……', h('span', { class: 'leaderboard-notice-nowrap', text: '11 个榜' }), '，看看你排第几')),
                h('li', {},
                    h('i', { class: 'fa-solid fa-location-dot' }),
                    h('span', {},
                        '入口在',
                        h('b', { text: '左下角' }),
                        '：点输入框左边的 ',
                        // 「☰ → 排行榜」不拆开换行
                        h('span', { class: 'leaderboard-notice-nowrap' },
                            h('span', { class: 'leaderboard-notice-key' }, h('i', { class: 'fa-solid fa-bars' })),
                            ' → ',
                            h('b', { text: '排行榜' })))),
                h('li', {},
                    h('i', { class: 'fa-solid fa-gift' }),
                    h('span', {}, '以后可能会', h('b', { text: '按排行榜发放奖励' })))),
            h('div', { class: 'leaderboard-notice-question', text: '你想怎么出现在榜上？' }),
            h('div', { class: 'leaderboard-notice-choices' },
                choice('public', true, '实名参加', `榜上显示你的昵称「${me.publicName}」，以后发奖励一眼就能找到你`),
                choice('anon', false, '匿名参加', `榜上显示「${me.anonymousName}」`)),
            error,
            h('small', { class: 'leaderboard-notice-note', text: '昵称后面的编号每人一个、不会重复。选了以后随时能在 排行榜 → 底部「设置」里改。' }),
            skip));

    function close() {
        document.removeEventListener('keydown', swallowEscape, true);
        root.classList.remove('show');
        setTimeout(() => root.remove(), 250);
    }

    /** 不能用 Esc 关掉，也别让 Esc 去关后面的东西 */
    function swallowEscape(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
    }

    /**
     * @param {string} mode
     * @param {HTMLElement} button
     */
    async function choose(mode, button) {
        if (saving) return;
        saving = true;
        const buttons = [...root.querySelectorAll('.leaderboard-notice-choice')];
        buttons.forEach(item => item.toggleAttribute('disabled', true));
        button.classList.add('saving');
        const title = button.querySelector('.leaderboard-notice-choice-title span');
        const original = title?.textContent ?? '';
        if (title) title.textContent = '保存中…';
        error.textContent = '';
        try {
            const response = await fetch('/api/leaderboard/me', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ mode }) });
            // 排行榜被关了：问也没用，直接关掉
            if (response.status === 404) return close();
            if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
            close();
            toastr.success(`榜上会显示「${mode === 'public' ? me.publicName : me.anonymousName}」`, '排行榜', { timeOut: 6000 });
        } catch (failure) {
            failures++;
            error.textContent = `没保存上（${failure instanceof Error && failure.message !== 'Failed to fetch' ? failure.message : '网络不太好'}），再点一次试试`;
            if (failures >= 2) skip.classList.remove('displayNone');
            buttons.forEach(item => item.toggleAttribute('disabled', false));
            button.classList.remove('saving');
            if (title) title.textContent = original;
            saving = false;
        }
    }

    document.addEventListener('keydown', swallowEscape, true);
    document.body.append(root);
    requestAnimationFrame(() => root.classList.add('show'));
}

// 排在最前面：后面的监听器可能弹窗等用户点（比如通行密钥提示），不能让它们挡住菜单项
eventSource.makeFirst(event_types.APP_READY, () => {
    if (started) return;
    started = true;
    startActivityReports();
});

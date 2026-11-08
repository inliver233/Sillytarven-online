/**
 * 用量与花费：每次生成后向服务器取这次上游报的 token 数和（官方接口的）价格（src/usage-meter.js），
 * 显示在回复的头像下面；今天的合计显示在输入框右上角；可以设每日上限：到 80% 提醒一次，
 * 超过后发送前先确认。官方接口按 models.dev 的官方价估算，中转站只显示 token。
 */
import { chat, eventSource, event_types, main_api, saveChatDebounced, saveSettingsDebounced } from '../script.js';
import { extension_settings } from './extensions.js';
import { oai_settings } from './openai.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';
import { uuidv4 } from './utils.js';

/** 每台设备/每个账号只提醒一次的状态（按服务器日期） */
const HINTED_KEY = 'UsageMeter_BudgetHinted';
const WARNED_KEY = 'UsageMeter_WarnedDate';
const OVER_TOAST_KEY = 'UsageMeter_OverToastDate';
const OVER_OK_KEY = 'UsageMeter_OverAllowedDate';
const TIP_KEY = 'UsageMeter_ContextTipDate';

const PROVIDER_LABELS = Object.freeze({
    'google-vertex': 'Vertex AI', google: 'Google AI Studio', openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek',
    openrouter: 'OpenRouter', xai: 'xAI', mistral: 'Mistral', moonshotai: 'Moonshot', zai: '智谱', groq: 'Groq',
});

/** 正在等结果的那次生成（后台的 quiet 生成不算） @type {{ id: string, type: string }|null} */
let pending = null;
/** 服务器上最近一次的统计 @type {any} */
let summary = null;

function settings() {
    extension_settings.usageMeter ??= {};
    const value = extension_settings.usageMeter;
    value.dailyBudget = Math.max(0, Number(value.dailyBudget) || 0);
    value.showOnMessages = value.showOnMessages !== false;
    return value;
}

/** @param {number} count */
export function formatTokens(count) {
    const value = Number(count) || 0;
    return value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(value);
}

/** @param {number} usd */
export function formatCost(usd) {
    const value = Number(usd) || 0;
    if (value === 0) return '$0';
    if (value < 0.01) return '<$0.01';
    return `$${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
}

const priced = usage => usage && (usage.priced === 'official' || usage.priced === 'reported') && Number.isFinite(usage.cost);

/** 头像下面那一小行的悬停说明 */
function describeUsage(usage) {
    const lines = [`输入 ${formatTokens(usage.input)} token${usage.cached ? `（其中缓存 ${formatTokens(usage.cached)}）` : ''}`,
        `输出 ${formatTokens(usage.output)} token${usage.reasoning ? `（含思考 ${formatTokens(usage.reasoning)}）` : ''}`];
    if (usage.priced === 'official') lines.push(`≈ ${formatCost(usage.cost)}，按 ${PROVIDER_LABELS[usage.provider] ?? usage.provider ?? '官方'} 官方价估算`);
    else if (usage.priced === 'reported') lines.push(`${formatCost(usage.cost)}，服务商报的实际花费`);
    else if (usage.priced === 'free') lines.push('免费渠道');
    else lines.push('中转站：只知道 token，不知道它怎么收费');
    lines.push('点击查看今天的用量');
    return lines.join('\n');
}

/**
 * 回复头像下面显示这条的花费（官方接口）或输入 token 数（中转站）。addOneMessage 也会调用。
 * @param {JQuery<HTMLElement>} messageElement
 * @param {any} message
 */
export function renderMessageUsage(messageElement, message) {
    const node = messageElement?.find('.mesCostDisplay')[0];
    if (!node) return;
    const usage = message?.extra?.usage;
    if (!usage || message.is_user || !settings().showOnMessages) {
        node.textContent = '';
        node.removeAttribute('title');
        return;
    }
    node.textContent = usage.priced === 'free' ? '免费' : priced(usage) ? formatCost(usage.cost) : `↑${formatTokens(usage.input)}`;
    node.title = describeUsage(usage);
}

/** 输入框右上角的「今日 ≈ $x」：今天有计价的花费或设了上限时才显示 */
function renderChip() {
    let holder = document.getElementById('usageMeterChipHolder');
    if (!holder) {
        const form = document.getElementById('form_sheld');
        if (!form) return;
        holder = document.createElement('div');
        holder.id = 'usageMeterChipHolder';
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.id = 'usageMeterChip';
        chip.addEventListener('click', () => void openUsagePanel());
        holder.append(chip);
        form.prepend(holder);
    }
    const chip = /** @type {HTMLButtonElement} */ (holder.firstElementChild);
    const today = summary?.today;
    const { dailyBudget } = settings();
    const visible = Boolean(today && (today.priced > 0 || dailyBudget > 0));
    holder.hidden = !visible;
    if (!visible) return;
    const ratio = dailyBudget > 0 ? today.cost / dailyBudget : 0;
    chip.textContent = `今日 ≈ ${formatCost(today.cost)}${dailyBudget > 0 ? ` / ${formatCost(dailyBudget)}` : ''}`;
    chip.title = `今天 ${today.requests} 次请求，输入 ${formatTokens(today.input)}、输出 ${formatTokens(today.output)} token。点击查看用量、设每日上限`;
    chip.classList.toggle('is-warn', ratio >= 0.8 && ratio < 1);
    chip.classList.toggle('is-over', ratio >= 1);
}

/** @param {string} [id] 顺带取这一次生成的记录 */
async function loadSummary(id) {
    const response = await fetch(`/api/usage/summary${id ? `?id=${encodeURIComponent(id)}` : ''}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    summary = await response.json();
    renderChip();
    return summary;
}

/**
 * 发生成请求时调用，返回放进 X-Usage-Id 请求头的编号。
 * @param {string} type 生成类型
 */
export function startUsageRequest(type) {
    const id = uuidv4();
    if (type !== 'quiet') pending = { id, type };
    return id;
}

/**
 * 回复收到后：取这次的用量，记在消息上，必要时提醒。
 * @param {number} messageId
 * @param {string} type
 */
async function onMessageReceived(messageId, type) {
    if (type === 'first_message' || !pending || main_api !== 'openai') return;
    const request = pending;
    pending = null;
    let data = null;
    for (let attempt = 0; attempt < 8 && !data?.item; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 300));
        data = await loadSummary(request.id).catch(() => null);
    }
    const item = data?.item;
    const message = chat[messageId];
    if (!item || !message || message.is_user) return;
    const previous = message.extra?.usage;
    const usage = { input: item.input, cached: item.cached, output: item.output, reasoning: item.reasoning, cost: item.cost, priced: item.priced, provider: item.provider, model: item.model };
    // 「继续」接在同一条消息后面：加在一起
    if (request.type === 'continue' && previous) {
        for (const key of ['input', 'cached', 'output', 'reasoning']) usage[key] += Number(previous[key]) || 0;
        usage.cost = Number.isFinite(previous.cost) && Number.isFinite(item.cost) ? previous.cost + item.cost : null;
        if (usage.cost === null) usage.priced = null;
    }
    message.extra ??= {};
    message.extra.usage = usage;
    const swipe = message.swipe_info?.[message.swipe_id ?? 0];
    if (swipe) {
        swipe.extra ??= {};
        swipe.extra.usage = usage;
    }
    renderMessageUsage($(`#chat .mes[mesid="${messageId}"]`), message);
    saveChatDebounced();
    remind(item, data);
}

/** 第一次有计价时提示可以设上限；到 80% 提醒；超过提醒；上下文太长时提示一次 */
function remind(item, data) {
    if (!priced(item) || !(item.cost > 0)) return;
    const day = data.days?.at(-1)?.date ?? '';
    const { dailyBudget } = settings();
    const spent = Number(data.today?.cost) || 0;
    if (dailyBudget > 0) {
        if (spent >= dailyBudget && accountStorage.getItem(OVER_TOAST_KEY) !== day) {
            accountStorage.setItem(OVER_TOAST_KEY, day);
            toastr.error(`今天已用 ≈ ${formatCost(spent)}，超过了每日上限 ${formatCost(dailyBudget)}。再发送时会先问你一次。`, '已超过每日上限', { timeOut: 15000, onclick: () => void openUsagePanel() });
            return;
        }
        if (spent >= dailyBudget * 0.8 && spent < dailyBudget && accountStorage.getItem(WARNED_KEY) !== day) {
            accountStorage.setItem(WARNED_KEY, day);
            toastr.warning(`今天已用 ≈ ${formatCost(spent)}，到每日上限 ${formatCost(dailyBudget)} 的 ${Math.floor((spent / dailyBudget) * 100)}% 了。`, '用量提醒', { timeOut: 15000, onclick: () => void openUsagePanel() });
            return;
        }
    } else if (!accountStorage.getItem(HINTED_KEY)) {
        accountStorage.setItem(HINTED_KEY, '1');
        const label = item.priced === 'official' ? `按 ${PROVIDER_LABELS[item.provider] ?? '官方'} 官方价估算` : '服务商报的实际花费';
        toastr.info(`这条回复约 ${formatCost(item.cost)}（${label}），今天合计显示在输入框右上角。点这里可以设每日上限，快到了会提醒你。`, '用量与花费', { timeOut: 20000, extendedTimeOut: 10000, onclick: () => void openUsagePanel() });
        return;
    }
    const maxContext = Number(oai_settings.openai_max_context) || 0;
    if (item.cost >= 0.3 && item.input >= 150000 && maxContext > 200000 && accountStorage.getItem(TIP_KEY) !== day) {
        accountStorage.setItem(TIP_KEY, day);
        toastr.info(`这条回复约 ${formatCost(item.cost)}，其中输入就有 ${formatTokens(item.input)} token：每次发送都会带上整段聊天记录。上下文上限现在是 ${formatTokens(maxContext)}，调到 12.8 万左右，每条能省一大半。`, '花费主要在上下文', { timeOut: 25000, extendedTimeOut: 10000 });
    }
}

/**
 * 发送前：今天已超过每日上限就先确认（可选今天不再问）。
 * @returns {Promise<boolean>} 是否继续
 */
export async function confirmUsageBudget() {
    const { dailyBudget } = settings();
    if (!(dailyBudget > 0)) return true;
    const data = await loadSummary().catch(() => summary);
    const spent = Number(data?.today?.cost) || 0;
    const day = data?.days?.at(-1)?.date ?? '';
    if (spent < dailyBudget || accountStorage.getItem(OVER_OK_KEY) === day) return true;
    const result = await callGenericPopup(
        `<h3>已超过每日上限</h3><p>今天已用 ≈ ${formatCost(spent)}，超过了你设的每日上限 ${formatCost(dailyBudget)}。</p><p>还要继续发送吗？</p>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '继续发送', cancelButton: '取消', customButtons: ['今天不再提醒'] },
    );
    if (result === 2) {
        accountStorage.setItem(OVER_OK_KEY, day);
        return true;
    }
    return result === POPUP_RESULT.AFFIRMATIVE;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** 用量面板：今天、最近 7 天、今天按模型，以及每日上限和显示开关 */
export async function openUsagePanel() {
    const data = await loadSummary().catch(() => summary);
    const today = data?.today ?? { requests: 0, reported: 0, input: 0, output: 0, cost: 0, priced: 0, models: {} };
    const options = settings();
    const root = element('div', 'usageMeterPanel');
    root.append(element('h3', '', '用量与花费'));
    const costText = today.priced ? `≈ ${formatCost(today.cost)}` : '没有可计价的用量';
    root.append(element('p', 'usageMeterToday', `今天 ${today.requests} 次请求 · 输入 ${formatTokens(today.input)} · 输出 ${formatTokens(today.output)} token · ${costText}`));
    const missing = today.requests - today.reported;
    if (missing > 0) root.append(element('p', 'usageMeterMuted', `其中 ${missing} 次没拿到用量（服务商没报，或中途停止了）。`));

    const table = element('table', 'usageMeterTable');
    const head = element('tr');
    for (const title of ['日期', '请求', '输入', '输出', '花费']) head.append(element('th', '', title));
    table.append(head);
    for (const day of [...(data?.days ?? [])].reverse()) {
        const row = element('tr');
        row.append(element('td', '', day.date.slice(5)), element('td', '', String(day.requests)), element('td', '', formatTokens(day.input)),
            element('td', '', formatTokens(day.output)), element('td', '', day.priced ? `≈ ${formatCost(day.cost)}` : '—'));
        table.append(row);
    }
    root.append(element('h4', '', '最近 7 天'), table);

    const models = Object.entries(today.models ?? {}).sort(([, a], [, b]) => (b.cost - a.cost) || (b.input - a.input));
    if (models.length) {
        const list = element('ul', 'usageMeterModels');
        for (const [key, totals] of models) {
            const [source, ...rest] = key.split('|');
            const cost = totals.priced ? ` · ≈ ${formatCost(totals.cost)}` : ' · 不计价';
            list.append(element('li', '', `${rest.join('|') || '（未知模型）'}（${source}）：${totals.requests} 次 · 输入 ${formatTokens(totals.input)} · 输出 ${formatTokens(totals.output)}${cost}`));
        }
        root.append(element('h4', '', '今天按模型'), list);
    }

    const budgetRow = element('label', 'usageMeterField');
    const budget = /** @type {HTMLInputElement} */ (element('input', 'text_pole'));
    budget.type = 'number';
    budget.min = '0';
    budget.step = '0.5';
    budget.value = options.dailyBudget ? String(options.dailyBudget) : '';
    budget.placeholder = '不设';
    budgetRow.append(element('span', '', '每日上限（美元）：到 80% 提醒，超过后发送前先确认'), budget);
    const showRow = element('label', 'usageMeterField is-checkbox');
    const show = /** @type {HTMLInputElement} */ (element('input'));
    show.type = 'checkbox';
    show.checked = options.showOnMessages;
    showRow.append(show, element('span', '', '在回复的头像下面显示这条的花费'));
    root.append(element('h4', '', '设置'), budgetRow, showRow);
    root.append(element('p', 'usageMeterMuted', '官方接口按 models.dev 上的官方价估算（每天更新），实际以服务商账单为准；Google 自动缓存省下的部分已经算进去了。中转站按它自己的规则收费，这里只显示 token。'));

    const result = await callGenericPopup(root, POPUP_TYPE.TEXT, '', { okButton: '保存', cancelButton: '关闭', allowVerticalScrolling: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    options.dailyBudget = Math.max(0, Number(budget.value) || 0);
    options.showOnMessages = show.checked;
    saveSettingsDebounced();
    renderChip();
    $('#chat .mes').each((_, node) => renderMessageUsage($(node), chat[Number(node.getAttribute('mesid'))]));
}

export function initUsageMeter() {
    $(document).on('click', '#chat .mesCostDisplay', () => void openUsagePanel());
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => void onMessageReceived(messageId, type).catch(error => console.warn('[usage] Reading the usage failed', error)));
    eventSource.on(event_types.APP_READY, () => void loadSummary().catch(() => null));
}

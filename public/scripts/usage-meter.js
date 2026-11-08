/**
 * 用量与花费：每次生成后向服务器取这次上游报的 token 数和花费（src/usage-meter.js），显示在回复的
 * 头像下面；今天的合计显示在输入框右上角；可以设每日上限：到 80% 提醒一次，超过后发送前先确认。
 * 钱怎么算：官方接口按 models.dev 的官方价；中转站能报已用金额的（new-api、sub2api、gpt-load……）
 * 按它报的；其余按用户在面板里给这个中转站设的价格，或 models.dev 上这个地址的价格；都没有就只显示 token。
 * 服务器一律记美元，这里按用户选的币种显示。
 */
import { chat, eventSource, event_types, getRequestHeaders, main_api, saveChatDebounced, saveSettingsDebounced } from '../script.js';
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
/** 中转站扣费要等服务器向中转站核对，最多等这么久 */
const RELAY_WAIT_MS = 25e3;

const PROVIDER_LABELS = Object.freeze({
    'google-vertex': 'Vertex AI', google: 'Google AI Studio', openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek',
    openrouter: 'OpenRouter', xai: 'xAI', mistral: 'Mistral', moonshotai: 'Moonshot', zai: '智谱', groq: 'Groq',
});
const PRICING_MODES = Object.freeze([['', '只看 token'], ['free', '免费'], ['call', '按次'], ['token', '按 token（每百万）'], ['ratio', '官方价 × 倍率']]);

/** 正在等结果的那次生成（后台的 quiet 生成不算） @type {{ id: string, type: string }|null} */
let pending = null;
/** 服务器上最近一次的统计 @type {any} */
let summary = null;

function settings() {
    extension_settings.usageMeter ??= {};
    const value = extension_settings.usageMeter;
    // 每日上限按美元存，显示时换算
    value.dailyBudget = Math.max(0, Number(value.dailyBudget) || 0);
    value.showOnMessages = value.showOnMessages !== false;
    value.currency = value.currency === 'CNY' ? 'CNY' : 'USD';
    return value;
}

/** 一美元合多少人民币（用户在面板里可以改） */
const rate = () => Number(summary?.settings?.rate) || 7.2;

/** @param {number} count */
export function formatTokens(count) {
    const value = Number(count) || 0;
    return value >= 10000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(value);
}

/**
 * @param {number} usd 美元
 * @param {'USD'|'CNY'} [currency] 默认用户选的币种
 */
export function formatCost(usd, currency = settings().currency) {
    const symbol = currency === 'CNY' ? '¥' : '$';
    const value = (Number(usd) || 0) * (currency === 'CNY' ? rate() : 1);
    if (value === 0) return `${symbol}0`;
    if (value < 0.01) return `<${symbol}0.01`;
    return `${symbol}${value < 10 ? value.toFixed(2) : value.toFixed(1)}`;
}

const PRICED = new Set(['official', 'reported', 'relay', 'catalog', 'custom']);
const priced = usage => Boolean(usage) && PRICED.has(usage.priced) && Number.isFinite(usage.cost);

/** 这笔钱是怎么来的 */
function describeSource(usage) {
    switch (usage.priced) {
        case 'official': return `按 ${PROVIDER_LABELS[usage.provider] ?? usage.provider ?? '官方'} 官方价估算`;
        case 'reported': return '服务商报的实际花费';
        case 'relay': return '中转站实际扣费';
        case 'catalog': return '按 models.dev 上这个服务的价格估算';
        case 'custom': return '按你给这个中转站设的价格';
        default: return '';
    }
}

/** 头像下面那一小行的悬停说明 */
function describeUsage(usage) {
    const lines = [`输入 ${formatTokens(usage.input)} token${usage.cached ? `（其中缓存 ${formatTokens(usage.cached)}）` : ''}`,
        `输出 ${formatTokens(usage.output)} token${usage.reasoning ? `（含思考 ${formatTokens(usage.reasoning)}）` : ''}`];
    if (usage.pending) lines.push('正在向中转站核对花费…');
    else if (priced(usage)) lines.push(`≈ ${formatCost(usage.cost)}，${describeSource(usage)}`);
    else if (usage.priced === 'free') lines.push('免费渠道');
    else lines.push('中转站：不知道它怎么收费，可以在用量面板里给它设价格');
    lines.push('点击查看今天的用量');
    return lines.join('\n');
}

/**
 * 回复头像下面显示这条的花费，不知道价格时显示输入 token 数。addOneMessage 也会调用。
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

function renderAllMessages() {
    $('#chat .mes').each((_, node) => renderMessageUsage($(node), chat[Number(node.getAttribute('mesid'))]));
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

/** 把服务器的记录写到消息上（「继续」接在同一条后面：加在一起） */
function attachUsage(message, item, request, previous) {
    const usage = { input: item.input, cached: item.cached, output: item.output, reasoning: item.reasoning, cost: item.cost, priced: item.priced, provider: item.provider, model: item.model, ...(item.pending ? { pending: true } : {}) };
    if (request.type === 'continue' && previous) {
        for (const key of ['input', 'cached', 'output', 'reasoning']) usage[key] += Number(previous[key]) || 0;
        if (!item.pending) {
            usage.cost = Number.isFinite(previous.cost) && Number.isFinite(item.cost) ? previous.cost + item.cost : null;
            if (usage.cost === null) usage.priced = null;
        }
    }
    message.extra ??= {};
    message.extra.usage = usage;
    const swipe = message.swipe_info?.[message.swipe_id ?? 0];
    if (swipe) {
        swipe.extra ??= {};
        swipe.extra.usage = usage;
    }
}

/**
 * 回复收到后：取这次的用量，记在消息上，必要时提醒。中转站扣费的要等服务器核对完再取一次。
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
    const message = chat[messageId];
    if (!data?.item || !message || message.is_user) return;
    const previous = message.extra?.usage;
    const show = () => renderMessageUsage($(`#chat .mes[mesid="${messageId}"]`), message);
    attachUsage(message, data.item, request, previous);
    show();
    if (data.item.pending) {
        const until = Date.now() + RELAY_WAIT_MS;
        while (data?.item?.pending && Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            data = await loadSummary(request.id).catch(() => data);
        }
        if (chat[messageId] !== message || !data?.item) return;
        if (data.item.pending) data.item = { ...data.item, pending: false };
        attachUsage(message, data.item, request, previous);
        show();
    }
    saveChatDebounced();
    remind(data.item, data);
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
        toastr.info(`这条回复约 ${formatCost(item.cost)}（${describeSource(item)}），今天合计显示在输入框右上角。点这里可以设每日上限，快到了会提醒你。`, '用量与花费', { timeOut: 20000, extendedTimeOut: 10000, onclick: () => void openUsagePanel() });
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

function numberInput(value, { step = '0.01', placeholder = '' } = {}) {
    const input = /** @type {HTMLInputElement} */ (element('input', 'text_pole'));
    input.type = 'number';
    input.min = '0';
    input.step = step;
    input.placeholder = placeholder;
    if (value !== undefined && value !== null && value !== '') input.value = String(value);
    return input;
}

function select(options, value) {
    const node = /** @type {HTMLSelectElement} */ (element('select', 'text_pole'));
    for (const [optionValue, label] of options) node.append(Object.assign(element('option', '', label), { value: optionValue }));
    node.value = value;
    return node;
}

/** @param {any} pricing */
function describePricing(pricing) {
    const symbol = pricing?.currency === 'CNY' ? '¥' : '$';
    switch (pricing?.mode) {
        case 'free': return '免费';
        case 'call': return `每次 ${symbol}${pricing.value}`;
        case 'token': return `每百万 token 输入 ${symbol}${pricing.input}、输出 ${symbol}${pricing.output}`;
        case 'ratio': return `官方价 × ${pricing.ratio}`;
        default: return '';
    }
}

/**
 * 面板里的一个中转站：是什么、报不报花费；不报的可以设价格。
 * @returns {{ node: HTMLElement, read: () => any }} read：现在填的价格（null = 只看 token）
 */
function relayRow(relay) {
    const row = element('div', 'usageMeterRelay');
    row.append(element('div', 'usageMeterRelayName', relay.label ? `${relay.label} · ${relay.address}` : relay.address));
    let status;
    if (relay.billing) {
        status = `中转站会报已用金额，按前后差值算实际花费${Number.isFinite(relay.remaining) && relay.remaining !== null ? `；余额约 ${formatCost(relay.remaining)}` : ''}。同一个 key 在别处用的也会算进来。`;
    } else if (relay.free) {
        status = `${relay.label}：转接免费或订阅额度，没有花费可查。`;
    } else if (relay.catalog) {
        status = `按 models.dev 上「${relay.catalog}」的价格估算。也可以自己设价格。`;
    } else {
        status = '没有提供花费查询，可以自己设价格。';
    }
    row.append(element('p', 'usageMeterMuted', status));
    if (relay.billing) return { node: row, read: () => undefined };

    const current = relay.pricing ?? {};
    const mode = select(PRICING_MODES, current.mode ?? '');
    const currency = select([['CNY', '人民币'], ['USD', '美元']], current.currency ?? 'CNY');
    const value = numberInput(current.value, { placeholder: '每次多少' });
    const input = numberInput(current.input, { placeholder: '输入' });
    const output = numberInput(current.output, { placeholder: '输出' });
    const ratio = numberInput(current.ratio, { step: '0.05', placeholder: '倍率' });
    const fields = element('div', 'usageMeterPricing');
    const note = element('span', 'usageMeterMuted');
    fields.append(mode, value, input, output, ratio, currency, note);
    const update = () => {
        value.hidden = mode.value !== 'call';
        input.hidden = output.hidden = mode.value !== 'token';
        ratio.hidden = mode.value !== 'ratio';
        currency.hidden = !['call', 'token'].includes(mode.value);
        note.textContent = mode.value === 'ratio' ? (relay.official ? `按 ${relay.official} 的官方价` : '模型名对不上官方模型，按倍率算不出来') : '';
    };
    mode.addEventListener('change', update);
    update();
    row.append(fields);
    if (relay.hint && !relay.pricing) {
        const apply = element('button', 'menu_button usageMeterHint', `按模型名建议：${describePricing(relay.hint)}`);
        apply.type = 'button';
        apply.addEventListener('click', () => {
            mode.value = relay.hint.mode;
            if (relay.hint.value !== undefined) value.value = String(relay.hint.value);
            if (relay.hint.currency) currency.value = relay.hint.currency;
            update();
        });
        row.append(apply);
    }
    const read = () => {
        switch (mode.value) {
            case 'free': return { mode: 'free' };
            case 'call': return { mode: 'call', currency: currency.value, value: Number(value.value) || 0 };
            case 'token': return { mode: 'token', currency: currency.value, input: Number(input.value) || 0, output: Number(output.value) || 0 };
            case 'ratio': return { mode: 'ratio', ratio: Number(ratio.value) || 0 };
            default: return null;
        }
    };
    return { node: row, read };
}

async function saveServerSettings(body) {
    const response = await fetch('/api/usage/settings', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** 用量面板：今天、最近 7 天、今天按模型、中转站，以及每日上限、币种和显示开关 */
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

    const relays = (data?.relays ?? []).map(relay => ({ relay, ...relayRow(relay) }));
    if (relays.length) {
        root.append(element('h4', '', '中转站'));
        root.append(element('p', 'usageMeterMuted', '能报已用金额的中转站（new-api、one-api、sub2api、gpt-load、LiteLLM、OpenRouter）自动按实际扣费算；其余可以自己设价格，改过接口的中转站认不出来。'));
        for (const item of relays) root.append(item.node);
    }

    const budgetRow = element('label', 'usageMeterField');
    const budget = numberInput(options.dailyBudget ? (options.dailyBudget * (options.currency === 'CNY' ? rate() : 1)).toFixed(2).replace(/\.?0+$/, '') : '', { step: '0.5', placeholder: '不设' });
    const budgetLabel = element('span', '', '');
    budgetRow.append(budgetLabel, budget);
    const currencyRow = element('label', 'usageMeterField');
    const currency = select([['USD', '美元（$）'], ['CNY', '人民币（¥）']], options.currency);
    const rateInput = numberInput(rate(), { step: '0.01' });
    const rateRow = element('label', 'usageMeterField');
    rateRow.append(element('span', '', '汇率：1 美元合多少人民币（换算显示、换算人民币价格用）'), rateInput);
    currencyRow.append(element('span', '', '显示币种'), currency);
    const updateBudgetLabel = () => {
        budgetLabel.textContent = `每日上限（${currency.value === 'CNY' ? '人民币' : '美元'}）：到 80% 提醒，超过后发送前先确认`;
    };
    currency.addEventListener('change', updateBudgetLabel);
    updateBudgetLabel();
    const showRow = element('label', 'usageMeterField is-checkbox');
    const show = /** @type {HTMLInputElement} */ (element('input'));
    show.type = 'checkbox';
    show.checked = options.showOnMessages;
    showRow.append(show, element('span', '', '在回复的头像下面显示这条的花费'));
    root.append(element('h4', '', '设置'), currencyRow, rateRow, budgetRow, showRow);
    root.append(element('p', 'usageMeterMuted', '官方接口按 models.dev 上的官方价估算（每天更新），实际以服务商账单为准；Google 自动缓存省下的部分已经算进去了。'));

    const result = await callGenericPopup(root, POPUP_TYPE.TEXT, '', { okButton: '保存', cancelButton: '关闭', allowVerticalScrolling: true, wide: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const newRate = Number(rateInput.value);
    options.currency = currency.value === 'CNY' ? 'CNY' : 'USD';
    const shownRate = newRate > 0 ? newRate : rate();
    options.dailyBudget = Math.max(0, Number(budget.value) || 0) / (options.currency === 'CNY' ? shownRate : 1);
    options.showOnMessages = show.checked;
    saveSettingsDebounced();
    try {
        if (newRate > 0 && newRate !== rate()) await saveServerSettings({ rate: newRate });
        for (const { relay, read } of relays) {
            const pricing = read();
            if (pricing === undefined || JSON.stringify(pricing) === JSON.stringify(relay.pricing ?? null)) continue;
            await saveServerSettings({ address: relay.address, pricing });
        }
    } catch (error) {
        toastr.error(`保存中转站价格失败：${error.message}`);
    }
    await loadSummary().catch(() => null);
    renderAllMessages();
}

export function initUsageMeter() {
    $(document).on('click', '#chat .mesCostDisplay', () => void openUsagePanel());
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => void onMessageReceived(messageId, type).catch(error => console.warn('[usage] Reading the usage failed', error)));
    eventSource.on(event_types.APP_READY, () => void loadSummary().catch(() => null));
}

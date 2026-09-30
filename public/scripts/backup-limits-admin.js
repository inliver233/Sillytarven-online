// 管理员面板：备份限额
import { getRequestHeaders } from '../script.js';

const KINDS = Object.freeze([
    {
        key: 'full',
        icon: 'fa-box-archive',
        title: '全量备份',
        description: '个人资料里的「下载备份」，会打包账号的全部数据，文件最大、最耗流量。',
    },
    {
        key: 'partial',
        icon: 'fa-file-zipper',
        title: '批量导出',
        description: '「导入 / 导出对话」面板里把多段对话打包成 ZIP。单段对话导出不计次。',
    },
]);

const MODES = Object.freeze([
    { value: 'unlimited', label: '不限制' },
    { value: 'limited', label: '每日限制' },
    { value: 'disabled', label: '禁止' },
]);

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function createKindCard(kind) {
    const card = element('section', 'backupLimits-card');
    card.dataset.kind = kind.key;

    const head = element('div', 'backupLimits-cardHead');
    const icon = element('i', `fa-solid ${kind.icon}`);
    const titles = element('div', 'backupLimits-cardTitles');
    titles.append(element('h4', '', kind.title), element('p', 'backupLimits-muted', kind.description));
    head.append(icon, titles);

    const modes = element('div', 'backupLimits-segmented');
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', `${kind.title}限制方式`);
    for (const mode of MODES) {
        const label = element('label');
        const input = element('input');
        input.type = 'radio';
        input.name = `backupLimitMode-${kind.key}`;
        input.value = mode.value;
        label.append(input, element('span', '', mode.label));
        modes.append(label);
    }

    const perDay = element('label', 'backupLimits-perDay');
    const perDayInput = element('input', 'text_pole');
    perDayInput.type = 'number';
    perDayInput.min = '1';
    perDayInput.max = '1000';
    perDayInput.step = '1';
    perDayInput.inputMode = 'numeric';
    perDayInput.dataset.role = 'perDay';
    perDay.append(element('span', '', '每人每天最多'), perDayInput, element('span', '', '次'));

    const disabledNote = element('p', 'backupLimits-note', '普通用户将无法使用此功能，管理员不受影响。');
    disabledNote.dataset.role = 'disabledNote';

    card.append(head, modes, perDay, disabledNote);
    card.addEventListener('change', () => syncCard(card));
    return card;
}

function syncCard(card) {
    const mode = card.querySelector('input[type="radio"]:checked')?.value ?? 'unlimited';
    card.querySelector('.backupLimits-perDay').hidden = mode !== 'limited';
    card.querySelector('[data-role="disabledNote"]').hidden = mode !== 'disabled';
    card.classList.toggle('is-disabled', mode === 'disabled');
}

function buildView(block) {
    const root = element('div', 'backupLimits');

    const header = element('header', 'backupLimits-header');
    header.append(
        element('h3', '', '备份限额'),
        element('p', 'backupLimits-muted', '限制普通用户每天发起备份的次数，用来控制下载流量。管理员不受限制；次数按服务器时间每天 0 点重置。生成失败、被取消或没有实际下载的备份不计次。'),
    );

    const cards = element('div', 'backupLimits-cards');
    KINDS.forEach(kind => cards.append(createKindCard(kind)));

    const actions = element('div', 'backupLimits-actions');
    const status = element('span', 'backupLimits-status');
    status.setAttribute('role', 'status');
    const save = element('button', 'menu_button menu_button_icon backupLimits-save');
    save.type = 'button';
    save.append(element('i', 'fa-fw fa-solid fa-floppy-disk'), element('span', '', '保存'));
    actions.append(status, save);

    const usage = element('section', 'backupLimits-usage');
    const usageHead = element('div', 'backupLimits-usageHead');
    const usageTitle = element('h4', '', '今日使用情况');
    const usageDate = element('small', 'backupLimits-muted');
    usageTitle.append(' ', usageDate);
    const refresh = element('button', 'menu_button menu_button_icon backupLimits-refresh');
    refresh.type = 'button';
    refresh.title = '刷新';
    refresh.append(element('i', 'fa-fw fa-solid fa-rotate'), element('span', '', '刷新'));
    usageHead.append(usageTitle, refresh);
    const tiles = element('div', 'backupLimits-tiles');
    const table = element('div', 'backupLimits-table');
    usage.append(usageHead, tiles, table);

    root.append(header, cards, actions, usage);
    block.replaceChildren(root);
    return { root, status, save, refresh, usageDate, tiles, table };
}

function renderPolicy(view, policy) {
    for (const card of view.root.querySelectorAll('.backupLimits-card')) {
        const kindPolicy = policy[card.dataset.kind];
        const radio = card.querySelector(`input[type="radio"][value="${kindPolicy.mode}"]`);
        if (radio) radio.checked = true;
        card.querySelector('[data-role="perDay"]').value = String(kindPolicy.perDay);
        syncCard(card);
    }
}

function readPolicy(view) {
    const policy = {};
    for (const card of view.root.querySelectorAll('.backupLimits-card')) {
        const mode = card.querySelector('input[type="radio"]:checked')?.value ?? 'unlimited';
        const raw = Number(card.querySelector('[data-role="perDay"]').value);
        if (mode === 'limited' && (!Number.isInteger(raw) || raw < 1 || raw > 1000)) {
            throw new Error('每日次数需要是 1 到 1000 之间的整数');
        }
        policy[card.dataset.kind] = { mode, perDay: Number.isInteger(raw) && raw >= 1 ? raw : 1 };
    }
    return policy;
}

function renderUsage(view, usage) {
    view.usageDate.textContent = usage?.date ?? '';
    const tiles = [
        ['全量备份', usage?.totals?.full ?? 0, '次'],
        ['批量导出', usage?.totals?.partial ?? 0, '次'],
        ['使用人数', usage?.totals?.users ?? 0, '人'],
    ];
    view.tiles.replaceChildren(...tiles.map(([label, value, unit]) => {
        const tile = element('div', 'backupLimits-tile');
        const number = element('b', '', String(value));
        number.append(element('small', '', unit));
        tile.append(element('span', '', label), number);
        return tile;
    }));

    const users = Array.isArray(usage?.topUsers) ? usage.topUsers : [];
    if (users.length === 0) {
        view.table.replaceChildren(element('p', 'backupLimits-empty', '今天还没有普通用户使用过备份功能'));
        return;
    }
    const head = element('div', 'backupLimits-row backupLimits-rowHead');
    head.append(element('span', '', '用户'), element('span', '', '全量备份'), element('span', '', '批量导出'));
    const rows = users.map(user => {
        const row = element('div', 'backupLimits-row');
        const full = element('span', '', String(user.full));
        full.dataset.label = '全量备份';
        const partial = element('span', '', String(user.partial));
        partial.dataset.label = '批量导出';
        row.append(element('span', 'backupLimits-handle', user.handle), full, partial);
        return row;
    });
    view.table.replaceChildren(head, ...rows);
}

async function request(method, body) {
    const response = await fetch('/api/backup-limits/config', {
        method,
        headers: getRequestHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    }
    return data;
}

function setStatus(view, text, state = '') {
    view.status.textContent = text;
    view.status.dataset.state = state;
}

const USAGE_REFRESH_MS = 30_000;

/**
 * Refreshes only the usage section while the tab is on screen. The policy
 * form is never overwritten, so unsaved edits survive.
 * @param {HTMLElement} block Tab block
 * @param {ReturnType<typeof buildView>} view View
 */
function startUsageAutoRefresh(block, view) {
    let running = false;
    const timer = setInterval(async () => {
        if (!block.isConnected) {
            clearInterval(timer);
            return;
        }
        if (running || document.hidden || block.offsetParent === null) {
            return;
        }
        running = true;
        try {
            const data = await request('GET');
            renderUsage(view, data.usage);
        } catch (error) {
            console.warn('Backup usage refresh failed:', error);
        } finally {
            running = false;
        }
    }, USAGE_REFRESH_MS);
}

/**
 * Renders the backup limits tab into the admin panel block and loads data.
 * Safe to call again whenever the tab is opened.
 * @param {HTMLElement} block The .backupLimitsAdminBlock element
 */
export async function openBackupLimitsAdmin(block) {
    if (!block) return;
    /** @type {ReturnType<typeof buildView>} */
    let view = block.__backupLimitsView;
    if (!view) {
        view = buildView(block);
        block.__backupLimitsView = view;
        view.root.addEventListener('change', () => setStatus(view, '有未保存的更改', 'dirty'));
        view.save.addEventListener('click', async () => {
            let policy;
            try {
                policy = readPolicy(view);
            } catch (error) {
                setStatus(view, error.message, 'error');
                return;
            }
            view.save.disabled = true;
            setStatus(view, '正在保存…');
            try {
                const data = await request('POST', { policy });
                renderPolicy(view, data.policy);
                renderUsage(view, data.usage);
                setStatus(view, '已保存，立即生效', 'ok');
            } catch (error) {
                setStatus(view, error.message, 'error');
            } finally {
                view.save.disabled = false;
            }
        });
        view.refresh.addEventListener('click', () => void openBackupLimitsAdmin(block));
        startUsageAutoRefresh(block, view);
    }

    setStatus(view, '正在加载…');
    try {
        const data = await request('GET');
        renderPolicy(view, data.policy);
        renderUsage(view, data.usage);
        setStatus(view, '');
    } catch (error) {
        setStatus(view, error.message, 'error');
    }
}

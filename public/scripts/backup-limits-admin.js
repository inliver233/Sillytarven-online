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
    const usageTitle = element('h4', '', '备份记录');
    const daySelect = element('select', 'text_pole backupLimits-day');
    daySelect.setAttribute('aria-label', '选择日期');
    const refresh = element('button', 'menu_button menu_button_icon backupLimits-refresh');
    refresh.type = 'button';
    refresh.title = '刷新';
    refresh.append(element('i', 'fa-fw fa-solid fa-rotate'), element('span', '', '刷新'));
    const headTools = element('div', 'backupLimits-usageTools');
    headTools.append(daySelect, refresh);
    usageHead.append(usageTitle, headTools);
    const live = element('div', 'backupLimits-live');
    const tiles = element('div', 'backupLimits-tiles');
    const usersTitle = element('h5', 'backupLimits-subhead', '按用户');
    const table = element('div', 'backupLimits-table backupLimits-userTable');
    const recentTitle = element('h5', 'backupLimits-subhead', '最近记录');
    const recent = element('div', 'backupLimits-table backupLimits-recent');
    usage.append(usageHead, live, tiles, usersTitle, table, recentTitle, recent);

    root.append(header, cards, actions, usage);
    block.replaceChildren(root);
    return { root, status, save, refresh, daySelect, live, tiles, table, recent };
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

const ACTIVITY_KINDS = Object.freeze({ full: '全量备份', partial: '批量导出', restore: '恢复' });
const ACTIVITY_STATUS = Object.freeze({
    ok: ['成功', 'ok'],
    failed: ['失败', 'error'],
    cancelled: ['已取消', 'muted'],
    rejected: ['被拒绝', 'warn'],
});

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(ms) {
    const seconds = Math.round((Number(ms) || 0) / 1000);
    if (seconds < 1) return '<1 秒';
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatTime(at) {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "2 成功 · 1 失败" style counts for one kind, empty parts left out. */
function describeCounts(counts, { withDownloads = false } = {}) {
    const parts = [];
    if (counts.ok) parts.push(`${counts.ok} 成功`);
    if (counts.failed) parts.push(`${counts.failed} 失败`);
    if (counts.cancelled) parts.push(`${counts.cancelled} 取消`);
    if (counts.rejected) parts.push(`${counts.rejected} 被拒`);
    if (withDownloads && counts.ok) parts.push(`${counts.downloaded} 已下载`);
    return parts.join(' · ') || '—';
}

function badge(status) {
    const [label, tone] = ACTIVITY_STATUS[status] ?? [status, 'muted'];
    const node = element('span', `backupLimits-badge is-${tone}`, label);
    return node;
}

function describeLive(item) {
    if (item.kind === 'stored') {
        return `服务器暂存 ${item.files} 个已生成的备份，共 ${formatBytes(item.bytes)}（等待下载，24 小时后自动删除）`;
    }
    if (item.kind === 'full') {
        return item.state === 'queued'
            ? `${item.handle} 的全量备份正在排队`
            : `${item.handle} 正在生成全量备份，已处理 ${formatBytes(item.processedBytes)}，已写入 ${formatBytes(item.archiveBytes)}`;
    }
    if (item.kind === 'restore') {
        if (item.state === 'uploading') {
            const percent = item.size ? Math.floor(item.received / item.size * 100) : 0;
            return `${item.handle} 正在上传恢复文件 ${percent}%（${formatBytes(item.received)} / ${formatBytes(item.size)}）`;
        }
        if (item.state === 'queued') {
            return `${item.handle} 的恢复正在排队（第 ${item.queuePosition} 位，${formatBytes(item.size)}）`;
        }
        return `${item.handle} 正在恢复数据（${formatBytes(item.size)}）`;
    }
    return '';
}

function renderActivity(view, activity) {
    const days = Array.isArray(activity?.days) ? activity.days : [];
    const selected = activity?.date ?? '';
    view.daySelect.replaceChildren(...days.map(day => {
        const option = element('option', '', day === activity.today ? `今天（${day}）` : day);
        option.value = day;
        option.selected = day === selected;
        return option;
    }));

    // In-progress work is about now, so it is only shown with today's records.
    const live = Array.isArray(activity?.live) && selected === activity.today ? activity.live : [];
    view.live.hidden = live.length === 0;
    view.live.replaceChildren(...live.map(item => {
        const row = element('div', 'backupLimits-liveItem');
        const icon = element('i', `fa-fw fa-solid ${item.kind === 'stored' ? 'fa-hard-drive' : 'fa-spinner fa-spin-pulse'}`);
        row.append(icon, element('span', '', describeLive(item)));
        return row;
    }));

    const totals = activity?.totals ?? {};
    view.tiles.replaceChildren(...Object.entries(ACTIVITY_KINDS).map(([kind, label]) => {
        const counts = totals[kind] ?? {};
        const tile = element('div', 'backupLimits-tile');
        const number = element('b', '', String(counts.ok ?? 0));
        number.append(element('small', '', '次成功'));
        const detail = element('span', 'backupLimits-tileDetail');
        const extra = [];
        if (counts.failed) extra.push(`失败 ${counts.failed}`);
        if (counts.cancelled) extra.push(`取消 ${counts.cancelled}`);
        if (counts.rejected) extra.push(`被拒 ${counts.rejected}`);
        if (counts.bytes) extra.push(`共 ${formatBytes(counts.bytes)}`);
        if (kind === 'full' && counts.ok) extra.push(`已下载 ${counts.downloaded}`);
        detail.textContent = extra.join(' · ');
        tile.append(element('span', '', label), number, detail);
        return tile;
    }));

    const users = Array.isArray(activity?.users) ? activity.users : [];
    if (users.length === 0) {
        view.table.replaceChildren(element('p', 'backupLimits-empty', '这一天没有备份、导出或恢复记录'));
    } else {
        const head = element('div', 'backupLimits-row backupLimits-rowHead');
        ['用户', '全量备份', '批量导出', '恢复', '总大小'].forEach(text => head.append(element('span', '', text)));
        view.table.replaceChildren(head, ...users.map(user => {
            const row = element('div', 'backupLimits-row');
            const handle = element('span', 'backupLimits-handle', user.handle);
            if (user.admin) handle.append(element('small', 'backupLimits-adminTag', '管理员'));
            row.append(handle);
            for (const [kind, label] of Object.entries(ACTIVITY_KINDS)) {
                const cell = element('span', '', describeCounts(user[kind] ?? {}, { withDownloads: kind === 'full' }));
                cell.dataset.label = label;
                row.append(cell);
            }
            const size = element('span', 'backupLimits-size', formatBytes(user.bytes));
            size.dataset.label = '总大小';
            row.append(size);
            return row;
        }));
    }

    const recent = Array.isArray(activity?.recent) ? activity.recent : [];
    if (recent.length === 0) {
        view.recent.replaceChildren(element('p', 'backupLimits-empty', '暂无记录'));
        return;
    }
    view.recent.replaceChildren(...recent.map(event => {
        const row = element('div', 'backupLimits-event');
        const main = element('div', 'backupLimits-eventMain');
        main.append(
            element('span', 'backupLimits-eventTime', formatTime(event.at)),
            element('span', 'backupLimits-handle', event.handle),
            element('span', 'backupLimits-eventKind', ACTIVITY_KINDS[event.kind] ?? event.kind),
            badge(event.status),
        );
        if (event.downloaded) main.append(element('span', 'backupLimits-badge is-muted', '已下载'));
        const meta = [];
        if (event.bytes) meta.push(formatBytes(event.bytes));
        if (event.durationMs) meta.push(`用时 ${formatDuration(event.durationMs)}`);
        if (event.reason) meta.push(event.reason);
        row.append(main);
        if (meta.length) row.append(element('div', 'backupLimits-eventMeta', meta.join(' · ')));
        return row;
    }));
}

async function loadActivity(view, date) {
    const query = date ? `?date=${encodeURIComponent(date)}` : '';
    const response = await fetch(`/api/backup-limits/activity${query}`, { headers: getRequestHeaders(), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    }
    renderActivity(view, data);
    return data;
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
        // Past days do not change; only today's view follows new activity.
        const selected = view.daySelect.value;
        if (selected && view.daySelect.selectedIndex > 0) {
            return;
        }
        running = true;
        try {
            await loadActivity(view, selected);
        } catch (error) {
            console.warn('Backup activity refresh failed:', error);
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
                setStatus(view, '已保存，立即生效', 'ok');
            } catch (error) {
                setStatus(view, error.message, 'error');
            } finally {
                view.save.disabled = false;
            }
        });
        view.refresh.addEventListener('click', () => void openBackupLimitsAdmin(block));
        view.daySelect.addEventListener('change', () => {
            loadActivity(view, view.daySelect.value).catch(error => setStatus(view, error.message, 'error'));
        });
        startUsageAutoRefresh(block, view);
    }

    setStatus(view, '正在加载…');
    try {
        const [data] = await Promise.all([request('GET'), loadActivity(view, view.daySelect.value)]);
        renderPolicy(view, data.policy);
        setStatus(view, '');
    } catch (error) {
        setStatus(view, error.message, 'error');
    }
}

// 管理员面板：邀请奖励（src/referrals.js）——设置、统计、邀请人排行、邀请关系（判定成功 / 撤销 / 收回）
import { getRequestHeaders } from '../script.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';

const PAGE_SIZE = 30;
/** 已经建好的面板（再次切到这一页时只刷新） @type {WeakMap<HTMLElement, () => Promise<void>>} */
const opened = new WeakMap();

const STATUS = Object.freeze({
    pending: ['等待首次回复', 'warn'],
    success: ['已成功', 'ok'],
    expired: ['已作废', 'muted'],
    revoked: ['已撤销', 'error'],
});

const SOURCES = Object.freeze({ link: '邀请链接', code: '填写邀请码', registration: '注册邀请码' });

/** 可疑标记的短名（悬停看全文） */
const FLAG_LABELS = Object.freeze({
    'same-device': '同设备', 'same-ip': '同 IP', 'same-network': '同网段', 'sibling-device': '共用设备', 'sibling-ip': '共用 IP',
    'new-discord': 'Discord 新号', 'burst': '集中绑定', 'inactive': '不活跃',
});
const LEVEL_ORDER = Object.freeze({ high: 3, medium: 2, low: 1 });

/** 溯源时间线里的时刻 */
const EVENT_LABELS = Object.freeze({
    visit: '打开邀请链接', bound: '绑定', reply: '第一条 AI 回复', success: '成功', approved: '管理员判定成功', revoked: '撤销', expired: '作废',
});

/** 数字设置：分组显示；shared 的两项和下方「注册邀请码」共用 */
const GROUPS = Object.freeze([
    {
        title: '奖励',
        fields: [
            { key: 'inviterRewardMiB', label: '邀请人每次得到', unit: 'MB', max: 100_000 },
            { key: 'inviteeRewardMiB', label: '被邀请人得到', unit: 'MB', max: 100_000 },
            { key: 'inviterCapMiB', label: '邀请人最多得到', unit: 'MB', max: 10_000_000, hint: '0 = 不限；到上限后被邀请人照样得到' },
        ],
    },
    {
        title: '规则',
        fields: [
            { key: 'claimWindowDays', label: '注册后多少天内能绑定', unit: '天', max: 3650, hint: '只有新账号能绑定邀请人' },
            { key: 'pendingExpireDays', label: '等多久没成功就作废', unit: '天', max: 3650, hint: '0 = 不作废；只在要求 AI 回复时有用' },
        ],
    },
    {
        title: '谁能邀请',
        fields: [
            { key: 'minRegisteredDays', label: '注册满', unit: '天', max: 3650, shared: '#userInvMinRegDays' },
            { key: 'minOnlineHours', label: '累计在线满', unit: '小时', max: 100_000, shared: '#userInvMinOnlineHours' },
        ],
        hint: '和「注册邀请码」页里用户发码的门槛是同一份设置。用户只会看到「暂未达到邀请资格」，看不到具体门槛。',
        perUser: true,
    },
]);

async function api(path, body) {
    const response = await fetch(`/api/referrals${path}`, {
        method: body ? 'POST' : 'GET',
        headers: getRequestHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
    return data;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, icon, className = '') {
    const node = element('button', `menu_button menu_button_icon ${className}`.trim());
    node.type = 'button';
    node.append(element('i', `fa-fw fa-solid ${icon}`), element('span', '', label));
    return node;
}

function formatDateTime(at) {
    if (!at) return '';
    const date = new Date(at);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const formatMiB = mib => (mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 ? 1 : 0)} GB` : `${mib} MB`);

function person(name, handle) {
    const node = element('span', 'referralAdmin-person');
    node.append(element('span', '', name || handle));
    if (name && name !== handle) node.append(element('small', '', handle));
    node.title = handle;
    return node;
}

/** 点了只看这个人邀请的 */
function inviterButton(name, handle, key, onClick, blocked = false) {
    const node = element('button', 'referralAdmin-personButton');
    node.type = 'button';
    node.title = `只看 ${handle} 邀请的`;
    node.append(person(name, handle));
    if (blocked) node.append(element('span', 'referralAdmin-badge is-error', '已停用'));
    node.addEventListener('click', () => onClick(key));
    return node;
}

/** 被邀请人现在怎样：判断是不是小号 */
function describeInvitee(link) {
    if (link.mirror) return `在${link.inviteeSiteLabel}注册，由${link.inviteeSiteLabel}判断成功`;
    if (link.inviteeExists === false) return '账号已删除';
    const parts = [];
    if (link.inviteeCreated) parts.push(`注册 ${formatDateTime(link.inviteeCreated)}`);
    parts.push(`累计在线 ${link.inviteeOnlineHours ?? 0} 小时`);
    return parts.join(' · ');
}

function badge(status) {
    const [label, tone] = STATUS[status] ?? [status, 'muted'];
    return element('span', `referralAdmin-badge is-${tone}`, label);
}

function buildView(mount) {
    const root = element('div', 'referralAdmin');
    /** @type {{ lookupInput?: HTMLInputElement, lookupButton?: HTMLButtonElement, accessList?: HTMLElement }} */
    const perUserParts = {};

    const header = element('header', 'referralAdmin-header');
    header.append(element('h3', '', '邀请奖励'),
        element('p', 'referralAdmin-muted', '每个用户有自己的邀请链接和邀请码。新账号绑定邀请人、邀请成功后，双方各加存储空间；邀请人得到的空间有上限。邀请成功和奖励到账会实时通知在线的用户。每条邀请都记下关键时刻的 IP、设备和浏览器（原始 IP 保留 90 天），同设备、同 IP 等可疑情况会标出来，同设备的还会提醒在线的管理员；只标记，奖励照发。'));

    const settings = element('section', 'referralAdmin-card');
    const toggles = element('div', 'referralAdmin-toggles');
    const toggle = (key, text, hint) => {
        const label = element('label', 'checkbox_label referralAdmin-toggle');
        const input = /** @type {HTMLInputElement} */ (element('input'));
        input.type = 'checkbox';
        input.dataset.key = key;
        const texts = element('span');
        texts.append(element('span', '', text));
        if (hint) texts.append(element('small', 'referralAdmin-muted', hint));
        label.append(input, texts);
        return label;
    };
    toggles.append(toggle('enabled', '开启邀请奖励', '关闭后用户设置里不再显示入口，也不能再绑定；已经绑定的保留，等待中的不再结算。'),
        toggle('requireValidReply', '被邀请人收到第一条 AI 回复才算成功', '由服务器在转发生成时判断（回复里有文字，或服务商报了输出 token）；绑定前已经聊过的立即成功。关闭则绑定即成功。'),
        toggle('crossSite', '跨站邀请：和另一个站互认邀请码', '两个站都打开才生效。被邀请的人在哪个站注册，就由哪个站判断成功、给被邀请人空间；邀请人的空间由邀请人所在的站给，算进那边的上限。本站暂停注册时，用户的邀请链接自动指向另一个站。'));
    const crossSite = element('p', 'referralAdmin-crossSite');
    settings.append(toggles, crossSite);

    const warning = element('p', 'referralAdmin-warning', '本站没有开启用户存储空间上限，奖励的空间不会生效。');
    warning.hidden = true;
    settings.append(warning);

    for (const group of GROUPS) {
        const box = element('div', 'referralAdmin-group');
        box.append(element('h5', '', group.title));
        const grid = element('div', 'referralAdmin-fields');
        for (const field of group.fields) {
            const label = element('label', 'referralAdmin-field');
            const input = /** @type {HTMLInputElement} */ (element('input', 'text_pole'));
            input.type = 'number';
            input.min = '0';
            input.max = String(field.max);
            input.step = '1';
            input.inputMode = 'numeric';
            input.dataset.key = field.key;
            if (field.shared) input.dataset.shared = field.shared;
            const line = element('span', 'referralAdmin-fieldInput');
            line.append(input, element('span', 'referralAdmin-muted', field.unit));
            label.append(element('span', 'referralAdmin-fieldLabel', field.label), line);
            if (field.hint) label.append(element('small', 'referralAdmin-muted', field.hint));
            grid.append(label);
        }
        box.append(grid);
        if (group.hint) box.append(element('small', 'referralAdmin-muted', group.hint));
        if (group.perUser) {
            const lookup = element('div', 'referralAdmin-lookup');
            const lookupInput = /** @type {HTMLInputElement} */ (element('input', 'text_pole'));
            lookupInput.type = 'search';
            lookupInput.placeholder = '输入账号';
            lookupInput.autocomplete = 'off';
            lookupInput.spellcheck = false;
            const lookupButton = button('查看', 'fa-magnifying-glass', 'referralAdmin-small');
            lookup.append(element('span', 'referralAdmin-fieldLabel', '单独设置某个人：'), lookupInput, lookupButton);
            const accessList = element('div', 'referralAdmin-accessList');
            box.append(lookup, element('small', 'referralAdmin-muted', '可以让不够门槛的人也能邀请，或者停用够门槛的人；查看后在下方「邀请关系」上面操作。'), accessList);
            Object.assign(perUserParts, { lookupInput, lookupButton, accessList });
        }
        settings.append(box);
    }

    const actions = element('div', 'referralAdmin-actions');
    const status = element('span', 'referralAdmin-status');
    status.setAttribute('role', 'status');
    const save = button('保存', 'fa-floppy-disk', 'referralAdmin-save');
    actions.append(status, save);
    settings.append(actions);

    const stats = element('section', 'referralAdmin-section');
    const statsHead = element('div', 'referralAdmin-sectionHead');
    const refresh = button('刷新', 'fa-rotate', 'referralAdmin-small');
    statsHead.append(element('h4', '', '统计'), refresh);
    const tiles = element('div', 'referralAdmin-tiles');
    stats.append(statsHead, tiles);

    const top = element('section', 'referralAdmin-section');
    top.append(element('h4', '', '邀请人排行'), element('p', 'referralAdmin-muted', '点名字只看这个人邀请的，在那里可以单独允许或停用这个人邀请。'));
    const topTable = element('div', 'referralAdmin-table referralAdmin-top');
    top.append(topTable);

    const list = element('section', 'referralAdmin-section');
    const listHead = element('div', 'referralAdmin-sectionHead');
    listHead.append(element('h4', '', '邀请关系'));
    const tools = element('div', 'referralAdmin-tools');
    const search = /** @type {HTMLInputElement} */ (element('input', 'text_pole referralAdmin-search'));
    search.type = 'search';
    search.placeholder = '搜索账号、邀请码、IP 或设备号';
    const filter = /** @type {HTMLSelectElement} */ (element('select', 'text_pole referralAdmin-filter'));
    for (const [value, label] of [['', '全部状态'], ['suspicious', '可疑'], ...Object.entries(STATUS).map(([key, [text]]) => [key, text])]) {
        const option = element('option', '', label);
        option.value = value;
        filter.append(option);
    }
    tools.append(search, filter);
    listHead.append(tools);
    const focus = element('div', 'referralAdmin-focus');
    focus.hidden = true;
    const table = element('div', 'referralAdmin-table referralAdmin-links');
    const pager = element('div', 'referralAdmin-pager');
    const previous = button('上一页', 'fa-chevron-left', 'referralAdmin-small');
    const next = button('下一页', 'fa-chevron-right', 'referralAdmin-small');
    const pageText = element('span', 'referralAdmin-muted');
    pager.append(previous, pageText, next);
    list.append(listHead, focus, table, pager);

    root.append(header, settings, stats, top, list);
    mount.replaceChildren(root);
    return { root, warning, crossSite, status, save, refresh, tiles, topTable, search, filter, focus, table, pager, previous, next, pageText, ...perUserParts };
}

function setStatus(view, text, state = '') {
    view.status.textContent = text;
    view.status.dataset.state = state;
}

function fillSettings(view, config) {
    for (const input of view.root.querySelectorAll('.referralAdmin-card input[data-key]')) {
        const value = config[input.dataset.key];
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = String(value ?? 0);
    }
    view.warning.hidden = config.rewardsAvailable !== false;
    view.crossSite.textContent = describeCrossSite(config.crossSiteStatus);
    syncDependent(view);
}

/** 两个站现在的情况（跨站邀请开关下面那行） */
function describeCrossSite(status) {
    if (!status) return '';
    if (!status.configured) return '没有配置另一个站（两站 config.yaml 里 leaderboard 的 site、secret、peers），跨站邀请用不了。';
    const here = `本站（${status.siteLabel}）${status.registrationOpen ? '开放注册' : '暂停注册'}`;
    if (!status.peer) return `${here}；连不上另一个站（${status.peerUrl}）：${status.error || '没有回应'}。`;
    const peer = status.peer;
    const there = `${status.peerLabel}：邀请奖励${peer.enabled ? '开着' : '关着'}，跨站邀请${peer.crossSite ? '开着' : '没开'}，${peer.registrationOpen ? '开放注册' : '暂停注册'}`;
    const where = !status.registrationOpen && peer.registrationOpen && peer.enabled && peer.crossSite ? `；本站用户的邀请链接会指向${status.peerLabel}` : '';
    return `${here}；${there}${where}。`;
}

/** 不要求 AI 回复时「作废」没有意义 */
function syncDependent(view) {
    const requireReply = view.root.querySelector('input[data-key="requireValidReply"]').checked;
    view.root.querySelector('input[data-key="pendingExpireDays"]').disabled = !requireReply;
}

function readSettings(view) {
    const body = {};
    for (const input of view.root.querySelectorAll('.referralAdmin-card input[data-key]')) {
        if (input.type === 'checkbox') {
            body[input.dataset.key] = input.checked;
            continue;
        }
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < 0 || value > Number(input.max)) {
            input.focus();
            throw new Error(`「${input.closest('label').querySelector('.referralAdmin-fieldLabel').textContent}」需要是 0 到 ${input.max} 之间的整数`);
        }
        body[input.dataset.key] = value;
    }
    return body;
}

function renderTiles(view, summary) {
    const tile = (label, value, detail) => {
        const node = element('div', 'referralAdmin-tile');
        node.append(element('span', '', label), element('b', '', String(value)));
        if (detail) node.append(element('small', 'referralAdmin-muted', detail));
        return node;
    };
    view.tiles.replaceChildren(
        tile('绑定', summary.total),
        tile('已成功', summary.success, summary.total ? `${Math.round((summary.success / summary.total) * 100)}%` : ''),
        tile('等待中', summary.pending),
        tile('作废 / 撤销', `${summary.expired} / ${summary.revoked}`),
        tile('已发放', formatMiB(summary.inviterMiB + summary.inviteeMiB), `邀请人 ${formatMiB(summary.inviterMiB)} · 被邀请人 ${formatMiB(summary.inviteeMiB)}`),
        tile('可疑', summary.suspicious ?? 0, '同设备、同 IP 等，只标记'),
    );
}

function headRow(titles) {
    const row = element('div', 'referralAdmin-row referralAdmin-rowHead');
    for (const title of titles) row.append(element('span', '', title));
    return row;
}

function cell(label, ...children) {
    const node = element('span');
    node.dataset.label = label;
    node.append(...children);
    return node;
}

function renderTop(view, top, ctx) {
    if (!top.length) {
        view.topTable.replaceChildren(element('p', 'referralAdmin-empty', '还没有人邀请过。'));
        return;
    }
    const rows = [headRow(['邀请人', '成功', '等待中', '得到'])];
    for (const item of top) {
        const row = element('div', 'referralAdmin-row');
        row.append(cell('', inviterButton(item.inviterName, item.handle, item.inviter, ctx.focusInviter, item.blocked)), cell('成功', document.createTextNode(String(item.success))),
            cell('等待', document.createTextNode(String(item.pending))), cell('得到', document.createTextNode(formatMiB(item.earnedMiB))));
        rows.push(row);
    }
    view.topTable.replaceChildren(...rows);
}

/** 「邀请人 +500 / 被邀请人 +200 MB」，没发过就空 */
function describeReward(link) {
    if (!link.successAt) return '';
    const text = `邀请人 +${link.inviterRewardMiB || 0} / 被邀请人 +${link.inviteeRewardMiB || 0} MB`;
    if (link.status === 'revoked') return link.reclaimed ? `${text}（已收回）` : `${text}（未收回）`;
    return text;
}

function describeTimes(link) {
    const parts = [`绑定 ${formatDateTime(link.boundAt)}`];
    if (link.successAt) parts.push(`成功 ${formatDateTime(link.successAt)}`);
    if (link.expiredAt && link.status === 'expired') parts.push(`作废 ${formatDateTime(link.expiredAt)}`);
    if (link.revokedAt) parts.push(`撤销 ${formatDateTime(link.revokedAt)}${link.revokedBy ? `（${link.revokedBy}）` : ''}`);
    return parts.join('\n');
}

function renderLinks(view, data, state, ctx) {
    const reload = ctx.reloadList;
    if (!data.rows.length) {
        view.table.replaceChildren(element('p', 'referralAdmin-empty', state.query || state.status || state.inviter ? '没有符合条件的邀请关系。' : '还没有邀请关系。'));
    } else {
        const rows = [];
        for (const link of data.rows) {
            // 第一行：被邀请人 ← 邀请人、状态；第二行：来源、时间、奖励；右边：操作
            const row = element('div', 'referralAdmin-link');
            const main = element('div', 'referralAdmin-linkMain');
            main.append(person(link.inviteeName, link.mirror ? link.inviteeHandle : link.invitee), element('span', 'referralAdmin-by', '← 邀请人'),
                inviterButton(link.inviterName, link.inviter, link.inviterKey, ctx.focusInviter, link.inviterBlocked), badge(link.status), ...flagBadges(link.flags));
            const source = SOURCES[link.source] ?? link.source;
            const time = element('span', 'referralAdmin-time', formatDateTime(link.boundAt));
            time.title = describeTimes(link);
            const meta = element('div', 'referralAdmin-linkMeta');
            meta.append(element('span', '', link.code ? `${source} ${link.code}` : source), time);
            const reward = describeReward(link);
            if (reward) meta.append(element('span', '', reward));
            meta.append(element('span', 'referralAdmin-invitee', `被邀请人：${describeInvitee(link)}`));
            const actions = element('div', 'referralAdmin-rowActions');
            if (!link.mirror && (link.status === 'pending' || link.status === 'expired')) {
                const approve = button('判定成功', 'fa-check', 'referralAdmin-small');
                approve.title = '不等 AI 回复，直接算成功并发奖励';
                approve.addEventListener('click', () => void act(approve, async () => {
                    await api('/admin/approve', { invitee: link.invitee });
                    toastr.success('已判定成功，奖励已发放');
                }, reload));
                actions.append(approve);
            }
            const details = element('div', 'referralAdmin-trace');
            details.hidden = true;
            const traceButton = button('溯源', 'fa-fingerprint', 'referralAdmin-small');
            traceButton.title = '这条邀请的时间线、IP、设备';
            traceButton.addEventListener('click', () => {
                if (!details.childElementCount) renderTrace(details, link);
                details.hidden = !details.hidden;
            });
            actions.append(traceButton);
            if (link.status !== 'revoked') {
                const revoke = button('撤销', 'fa-ban', 'referralAdmin-small is-danger');
                revoke.addEventListener('click', () => void act(revoke, async () => {
                    const reclaim = await confirmRevoke(link);
                    if (reclaim === null) return;
                    await api('/admin/revoke', { invitee: link.invitee, reclaim });
                    toastr.success(reclaim ? '已撤销并收回空间' : '已撤销');
                }, reload));
                actions.append(revoke);
            }
            row.append(main, meta, actions, details);
            rows.push(row);
        }
        view.table.replaceChildren(...rows);
    }
    const from = data.total ? state.offset + 1 : 0;
    const to = Math.min(data.total, state.offset + PAGE_SIZE);
    view.pageText.textContent = `第 ${from}–${to} 条，共 ${data.total} 条`;
    view.previous.disabled = state.offset <= 0;
    view.next.disabled = state.offset + PAGE_SIZE >= data.total;
    view.pager.hidden = data.total <= PAGE_SIZE;
}

/** 可疑标签（重的在前） */
function flagBadges(flags) {
    return [...(flags ?? [])].sort((a, b) => (LEVEL_ORDER[b.level] ?? 0) - (LEVEL_ORDER[a.level] ?? 0)).map(flag => {
        const node = element('span', `referralAdmin-flag is-${flag.level}`, FLAG_LABELS[flag.code] ?? flag.code);
        node.title = flag.text;
        return node;
    });
}

/** 浏览器信息的简写 */
function shortAgent(agent) {
    if (!agent) return '';
    const browser = /Edg\//.test(agent) ? 'Edge' : /OPR\//.test(agent) ? 'Opera' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '其他浏览器';
    const system = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac OS X/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
    return system ? `${browser} · ${system}` : browser;
}

/** 一处来路：IP（过了保留期、或者是另一个站记的，只有打码的网段）、设备号前 8 位、浏览器 */
function describeOrigin(item, { remote = false } = {}) {
    const masked = remote ? '（另一个站只给网段）' : '（原始 IP 已过保留期）';
    const parts = [item.ip || (item.net ? `${item.net}${masked}` : '没有 IP')];
    if (item.device) parts.push(`设备 ${item.device.slice(0, 8)}`);
    const agent = shortAgent(item.ua);
    if (agent) parts.push(agent);
    return parts.join(' · ');
}

/** 「溯源」展开的内容：可疑在哪、Discord 号、时间线、被邀请人最近用过的 */
function renderTrace(details, link) {
    const flags = link.flags ?? [];
    if (flags.length) {
        const list = element('ul', 'referralAdmin-traceFlags');
        for (const flag of flags) list.append(element('li', `is-${flag.level}`, flag.text));
        details.append(element('h5', '', '可疑（只标记，奖励照发）'), list);
    }
    if (link.inviteeDiscordDays !== null && link.inviteeDiscordDays !== undefined) {
        details.append(element('p', 'referralAdmin-muted', `被邀请人的 Discord 号注册了 ${link.inviteeDiscordDays} 天`));
    }
    details.append(element('h5', '', link.mirror ? `时间线（${link.inviteeSiteLabel}记下的）` : '时间线'));
    const events = link.events ?? [];
    if (!events.length) details.append(element('p', 'referralAdmin-muted', '没有记录（这个功能上线前的邀请）。'));
    for (const event of events) {
        const line = element('div', 'referralAdmin-traceLine');
        const what = [EVENT_LABELS[event.type] ?? event.type];
        if (event.via === 'controller') what.push('（在总控注册时，没有来路）');
        if (event.by) what.push(`（${event.by}）`);
        if (event.reclaim) what.push('（收回空间）');
        line.append(element('span', 'referralAdmin-time', formatDateTime(event.at)), element('span', '', what.join('')));
        if (event.ip || event.net || event.device) line.append(element('span', 'referralAdmin-muted', describeOrigin(event, { remote: link.mirror })));
        details.append(line);
    }
    const seen = link.inviteeSeen ?? [];
    if (seen.length) {
        details.append(element('h5', '', '被邀请人最近用过'));
        for (const item of seen) {
            details.append(element('div', 'referralAdmin-traceLine', `${describeOrigin(item)} · ${formatDateTime(item.first)} 到 ${formatDateTime(item.last)}，${item.count} 次`));
        }
    }
}

/** 只看一个人时：这个人的情况和处理按钮 */
function renderFocus(view, focus, ctx) {
    view.focus.hidden = !focus;
    if (!focus) {
        view.focus.replaceChildren();
        return;
    }
    const text = element('div', 'referralAdmin-focusText');
    text.append(element('span', '', '只看'), person(focus.inviterName, focus.handle ?? focus.inviter),
        element('span', '', `邀请的：共 ${focus.total} 人，得到 ${formatMiB(focus.earnedMiB)}`));
    if (focus.blocked) text.append(element('span', 'referralAdmin-badge is-error', '邀请已停用'));
    const actions = element('div', 'referralAdmin-rowActions');
    const clear = button('看全部', 'fa-xmark', 'referralAdmin-small');
    clear.addEventListener('click', () => ctx.focusInviter(''));
    if (focus.remote) {
        text.append(element('span', 'referralAdmin-muted', `（${focus.siteLabel}的用户，停用要在${focus.siteLabel}操作）`));
        actions.append(clear);
        view.focus.replaceChildren(text, actions);
        return;
    }
    if (focus.exists === false) {
        view.focus.replaceChildren(element('div', 'referralAdmin-focusText', `没有「${focus.inviter}」这个账号。`), actions);
        actions.append(clear);
        return;
    }
    if (focus.mode === 'allow') text.append(element('span', 'referralAdmin-badge is-ok', '已单独允许'));
    const standing = focus.mode === 'allow' ? '单独允许，可以邀请' : focus.mode === 'block' ? '已停用，不能邀请' : (focus.eligible ? '现在可以邀请' : '现在不能邀请');
    const info = element('div', 'referralAdmin-focusInfo',
        `注册 ${focus.registeredDays} 天 · 累计在线 ${focus.onlineHours} 小时（按 ${focus.roundedHours} 小时算） · 按门槛${focus.meetsThresholds ? '够格' : '不够格'} · ${standing}`);
    const setAccess = async (mode, extra = {}) => {
        const result = await api('/admin/access', { handle: focus.inviter, mode, ...extra });
        const done = { allow: '已允许，这个人现在可以邀请了', block: '已停用', default: '已恢复按门槛' }[mode];
        toastr.success(result.revoked ? `${done}，撤销了 ${result.revoked} 条邀请${extra.reclaim ? '并收回空间' : ''}` : done);
    };
    if (focus.mode !== 'allow' && !focus.meetsThresholds) {
        const allow = button('允许邀请', 'fa-user-check', 'referralAdmin-small');
        allow.title = '不够门槛也能邀请';
        allow.addEventListener('click', () => void act(allow, () => setAccess('allow'), ctx.reloadList));
        actions.append(allow);
    }
    if (focus.mode) {
        const reset = button('恢复按门槛', 'fa-rotate-left', 'referralAdmin-small');
        reset.addEventListener('click', () => void act(reset, () => setAccess('default'), ctx.reloadList));
        actions.append(reset);
    }
    if (focus.mode !== 'block') {
        const block = button('停用邀请', 'fa-user-slash', 'referralAdmin-small is-danger');
        block.addEventListener('click', () => void act(block, async () => {
            const choice = await confirmBlock(focus);
            if (choice) await setAccess('block', choice);
        }, ctx.reloadList));
        actions.append(block);
    }
    actions.append(clear);
    const seen = element('div', 'referralAdmin-focusSeen');
    if (focus.seen?.length) {
        seen.append(element('span', 'referralAdmin-muted', '最近用过：'));
        for (const item of focus.seen.slice(0, 5)) seen.append(element('span', 'referralAdmin-seenItem', `${describeOrigin(item)}（${formatDateTime(item.last)}）`));
    }
    view.focus.replaceChildren(text, actions, info, seen);
}

/** 单独设置过的人 */
function renderAccess(view, rows, ctx) {
    if (!view.accessList) return;
    if (!rows.length) {
        view.accessList.replaceChildren(element('small', 'referralAdmin-muted', '还没有单独设置过的人。'));
        return;
    }
    const items = rows.map(row => {
        const item = element('div', 'referralAdmin-accessItem');
        const reset = button('恢复按门槛', 'fa-rotate-left', 'referralAdmin-small');
        reset.addEventListener('click', () => void act(reset, async () => {
            await api('/admin/access', { handle: row.handle, mode: 'default' });
            toastr.success('已恢复按门槛');
        }, ctx.reloadList));
        item.append(inviterButton(row.name, row.handle, row.handle, ctx.focusInviter),
            element('span', `referralAdmin-badge ${row.mode === 'allow' ? 'is-ok' : 'is-error'}`, row.mode === 'allow' ? '单独允许' : '已停用'),
            element('span', 'referralAdmin-muted', `${formatDateTime(row.at)}${row.by ? ` · ${row.by}` : ''}`), reset);
        return item;
    });
    view.accessList.replaceChildren(...items);
}

/** @returns {Promise<{revokeAll: boolean, reclaim: boolean}|null>} null = 取消 */
async function confirmBlock(focus) {
    const box = element('div', 'referralAdmin-confirm');
    box.append(element('h3', '', '停用这个人的邀请'),
        element('p', '', `${focus.inviterName || focus.inviter} 的邀请码马上失效，也不能再生成；之后还在等待的邀请成功了，邀请人拿不到空间（被邀请人照常）。随时可以恢复。`));
    const revokeLabel = element('label', 'checkbox_label');
    const revokeAll = /** @type {HTMLInputElement} */ (element('input'));
    revokeAll.type = 'checkbox';
    revokeLabel.append(revokeAll, element('span', '', `同时撤销已有的邀请（共 ${focus.total} 条，等待中的不再结算）`));
    const reclaimLabel = element('label', 'checkbox_label');
    const reclaim = /** @type {HTMLInputElement} */ (element('input'));
    reclaim.type = 'checkbox';
    reclaim.disabled = true;
    reclaimLabel.append(reclaim, element('span', '', '连已发的空间一起收回（邀请人和被邀请人）'));
    revokeAll.addEventListener('change', () => {
        reclaim.disabled = !revokeAll.checked;
        if (!revokeAll.checked) reclaim.checked = false;
    });
    box.append(revokeLabel, reclaimLabel);
    const answer = await callGenericPopup(box, POPUP_TYPE.CONFIRM, '', { okButton: '停用', cancelButton: '取消' });
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return null;
    return { revokeAll: revokeAll.checked, reclaim: reclaim.checked };
}

/** @returns {Promise<boolean|null>} 收不收回空间；null = 取消 */
async function confirmRevoke(link) {
    const box = element('div', 'referralAdmin-confirm');
    box.append(element('h3', '', '撤销这条邀请'),
        element('p', '', `${link.inviterName || link.inviter} 邀请 ${link.inviteeName || link.invitee}。撤销后不再计入邀请人的上限和排行，等待中的不会再结算。`));
    let reclaim = null;
    if (link.status === 'success' && ((link.inviterRewardMiB || 0) + (link.inviteeRewardMiB || 0)) > 0) {
        const label = element('label', 'checkbox_label');
        reclaim = /** @type {HTMLInputElement} */ (element('input'));
        reclaim.type = 'checkbox';
        const other = link.mirror ? link.inviteeSiteLabel : link.inviterSiteLabel;
        const text = other
            ? `同时收回已发的空间（邀请人 ${link.inviterRewardMiB || 0} MB，被邀请人 ${link.inviteeRewardMiB || 0} MB；${other}发的那份由${other}收回）`
            : `同时收回已发的空间（邀请人 ${link.inviterRewardMiB || 0} MB，被邀请人 ${link.inviteeRewardMiB || 0} MB）`;
        label.append(reclaim, element('span', '', text));
        box.append(label);
    }
    const answer = await callGenericPopup(box, POPUP_TYPE.CONFIRM, '', { okButton: '撤销', cancelButton: '取消' });
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return null;
    return Boolean(reclaim?.checked);
}

async function act(control, task, after) {
    control.disabled = true;
    try {
        await task();
        await after?.();
    } catch (error) {
        toastr.error(error.message);
    } finally {
        control.disabled = false;
    }
}

/**
 * 共用的门槛：这里和「注册邀请码」页里的输入框保持一致，免得一边保存时用旧值覆盖另一边。
 * 那边的输入框在另一个标签页里，用到时再找。
 */
const views = new Set();
document.addEventListener('input', event => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (!(target instanceof HTMLInputElement) || !target.id) return;
    for (const view of views) {
        if (!view.root.isConnected) {
            views.delete(view);
            continue;
        }
        const mine = view.root.querySelector(`input[data-shared="#${target.id}"]`);
        if (mine) mine.value = target.value;
    }
});

function bindShared(view) {
    views.add(view);
    for (const input of view.root.querySelectorAll('input[data-shared]')) {
        input.addEventListener('input', () => {
            const other = /** @type {HTMLInputElement|null} */ (document.querySelector(input.dataset.shared));
            if (other) other.value = input.value;
        });
    }
}

function writeShared(view, config) {
    for (const input of view.root.querySelectorAll('input[data-shared]')) {
        const other = /** @type {HTMLInputElement|null} */ (document.querySelector(input.dataset.shared));
        if (other) other.value = String(config[input.dataset.key]);
    }
}

/**
 * 打开（或刷新）管理员面板里的「邀请奖励」。
 * @param {HTMLElement} mount
 */
export async function openReferralAdmin(mount) {
    if (!mount) return;
    if (opened.has(mount)) return opened.get(mount)();

    const view = buildView(mount);
    const state = { query: '', status: '', inviter: '', offset: 0 };
    let searchTimer = 0;

    const loadList = async () => {
        const params = new URLSearchParams({ query: state.query, status: state.status, inviter: state.inviter, offset: String(state.offset), limit: String(PAGE_SIZE) });
        const data = await api(`/admin/list?${params}`);
        if (state.offset > 0 && state.offset >= data.total) {
            state.offset = Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
            return loadList();
        }
        renderTiles(view, data.summary);
        renderTop(view, data.top, ctx);
        renderFocus(view, data.focus, ctx);
        renderLinks(view, data, state, ctx);
    };
    const loadAccess = async () => renderAccess(view, await api('/admin/access'), ctx);
    const ctx = {
        reloadList: async () => {
            await loadList();
            await loadAccess();
        },
        focusInviter: handle => {
            state.inviter = handle;
            state.offset = 0;
            void loadList().then(() => view.focus.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })).catch(error => toastr.error(error.message));
        },
    };
    const reload = async () => {
        try {
            const [config] = await Promise.all([api('/admin/config'), loadList(), loadAccess()]);
            fillSettings(view, config);
            setStatus(view, '');
        } catch (error) {
            setStatus(view, `加载失败：${error.message}`, 'error');
        }
    };

    const lookup = () => {
        const handle = view.lookupInput?.value.trim();
        if (handle) ctx.focusInviter(handle);
    };
    view.lookupButton?.addEventListener('click', lookup);
    view.lookupInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter') lookup();
    });
    view.root.querySelector('.referralAdmin-card').addEventListener('input', event => {
        // 查账号的输入框不算设置
        if (!(/** @type {HTMLElement} */ (event.target)).matches?.('input[data-key]')) return;
        syncDependent(view);
        setStatus(view, '有未保存的修改', 'dirty');
    });
    view.save.addEventListener('click', () => void (async () => {
        let body;
        try {
            body = readSettings(view);
        } catch (error) {
            setStatus(view, error.message, 'error');
            return;
        }
        view.save.disabled = true;
        try {
            const saved = await api('/admin/config', body);
            fillSettings(view, saved);
            writeShared(view, saved);
            setStatus(view, '已保存', 'ok');
        } catch (error) {
            setStatus(view, `保存失败：${error.message}`, 'error');
        } finally {
            view.save.disabled = false;
        }
    })());
    view.refresh.addEventListener('click', () => void act(view.refresh, loadList));
    view.search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
            state.query = view.search.value.trim();
            state.offset = 0;
            void loadList().catch(error => toastr.error(error.message));
        }, 300);
    });
    view.filter.addEventListener('change', () => {
        state.status = view.filter.value;
        state.offset = 0;
        void loadList().catch(error => toastr.error(error.message));
    });
    view.previous.addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - PAGE_SIZE);
        void loadList().catch(error => toastr.error(error.message));
    });
    view.next.addEventListener('click', () => {
        state.offset += PAGE_SIZE;
        void loadList().catch(error => toastr.error(error.message));
    });
    bindShared(view);

    opened.set(mount, reload);
    await reload();
}

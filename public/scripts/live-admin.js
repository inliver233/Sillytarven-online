// 管理员面板：实时推送（向打开着的页面发送刷新、消息等指令，见 src/live.js）
import { getRequestHeaders } from '../script.js';

/** 指令的表单。服务器登记了但这里没有表单的类型，用 JSON 填写数据。 */
const FORMS = Object.freeze({
    reload: {
        label: '刷新页面',
        fields: [
            { key: 'delay', label: '延迟（秒）', type: 'number', min: 0, max: 300, value: 5 },
            { key: 'message', label: '附言', type: 'text', maxLength: 200, placeholder: '选填，显示在刷新提示里' },
            { key: 'wait', label: '等用户空闲再刷新（不在生成、输入、编辑或开着窗口；最多等 10 分钟）', type: 'checkbox', value: true },
        ],
    },
    notice: {
        label: '显示消息',
        fields: [
            { key: 'title', label: '标题', type: 'text', maxLength: 60, placeholder: '选填' },
            { key: 'text', label: '内容', type: 'textarea', maxLength: 1000, required: true },
            { key: 'level', label: '样式', type: 'select', options: [['info', '普通'], ['success', '成功'], ['warning', '警告'], ['error', '错误']], value: 'info' },
            { key: 'timeout', label: '显示时长（秒，0 = 直到关闭）', type: 'number', min: 0, max: 3600, value: 15 },
        ],
    },
});

const KEEP_OPTIONS = Object.freeze([[0, '不保留'], [60, '1 分钟'], [600, '10 分钟'], [3600, '1 小时'], [86400, '24 小时']]);
/** 上线后补发的保留时间 */
const LATE_KEEP_OPTIONS = Object.freeze([[86400, '1 天'], [3 * 86400, '3 天'], [7 * 86400, '7 天'], [30 * 86400, '30 天']]);
const LATE_KEEP_DEFAULT = 7 * 86400;
const ERRORS = Object.freeze({ unknown_type: '服务器不认识这种指令', bad_target: '没有填写账号', bad_data: '内容不完整', not_late: '这种指令不能上线后补发', unknown_command: '这条指令已经过期或撤销', disabled: '本站没有开启实时推送' });
const REFRESH_MS = 10_000;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function request(path, body) {
    const response = await fetch(`/api/live/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: getRequestHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
    });
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(ERRORS[data?.error] ?? data?.error ?? `请求失败（HTTP ${response.status}）`);
    return data;
}

function formatTime(at) {
    const date = new Date(at);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}

/**
 * @param {string[]} handles
 * @param {number} [max]
 */
function listHandles(handles, max = 8) {
    return handles.length > max ? `${handles.slice(0, max).join('、')} 等 ${handles.length} 个` : handles.join('、');
}

/** 补发消息的送达情况 */
function describeSeen(command) {
    if (!command.late) return '';
    if (!command.target?.handles) return command.seenCount ? `已有 ${command.seenCount} 个账号看到` : '还没有人看到';
    const seen = command.seen ?? [];
    const waiting = command.target.handles.filter(handle => !seen.includes(handle));
    if (!waiting.length) return '全部已看到';
    return [seen.length ? `已看到：${listHandles(seen)}` : '', `还没看到：${listHandles(waiting)}`].filter(Boolean).join(' · ');
}

function describeTarget(target) {
    if (target?.all) return '所有页面';
    if (target?.admins) return '管理员';
    const handles = target?.handles ?? [];
    return handles.length > 3 ? `${handles.slice(0, 3).join('、')} 等 ${handles.length} 个账号` : handles.join('、');
}

function radioGroup(name, options, checked) {
    const group = element('div', 'liveAdmin-segmented');
    group.setAttribute('role', 'radiogroup');
    for (const [value, label] of options) {
        const option = element('label');
        const input = element('input');
        input.type = 'radio';
        input.name = name;
        input.value = value;
        input.checked = value === checked;
        option.append(input, element('span', '', label));
        group.append(option);
    }
    return group;
}

function field(spec) {
    const wrap = element('label', `liveAdmin-field is-${spec.type}`);
    let input;
    if (spec.type === 'textarea') {
        input = element('textarea', 'text_pole');
        input.rows = 3;
    } else if (spec.type === 'select') {
        input = element('select', 'text_pole');
        for (const [value, label] of spec.options) input.append(Object.assign(element('option', '', label), { value }));
    } else {
        input = element('input', spec.type === 'checkbox' ? '' : 'text_pole');
        input.type = spec.type;
    }
    input.dataset.key = spec.key;
    if (spec.type === 'checkbox') input.checked = spec.value !== false;
    else if (spec.value !== undefined) input.value = String(spec.value);
    if (spec.min !== undefined) input.min = String(spec.min);
    if (spec.max !== undefined) input.max = String(spec.max);
    if (spec.maxLength) input.maxLength = spec.maxLength;
    if (spec.placeholder) input.placeholder = spec.placeholder;
    if (spec.type === 'checkbox') wrap.append(input, element('span', '', spec.label));
    else wrap.append(element('span', 'liveAdmin-label', spec.label), input);
    return wrap;
}

function buildView(block) {
    const root = element('div', 'liveAdmin');

    const header = element('header', 'liveAdmin-header');
    header.append(
        element('h3', '', '实时推送'),
        element('p', 'liveAdmin-muted', '向打开着的页面立即发送指令。设置保留时间后，期间重新连上的页面（如休眠后恢复、服务器重启后重连）也会收到；之后打开的页面不受影响。消息可以选「上线后补发」：不在线的人在保留期内打开网页时也会收到，每个账号看到一次。'),
    );

    const online = element('section', 'liveAdmin-section');
    const onlineHead = element('div', 'liveAdmin-sectionHead');
    const refresh = element('button', 'menu_button menu_button_icon liveAdmin-small');
    refresh.type = 'button';
    refresh.append(element('i', 'fa-fw fa-solid fa-rotate'), element('span', '', '刷新'));
    onlineHead.append(element('h4', '', '在线'), refresh);
    const tiles = element('div', 'liveAdmin-tiles');
    const users = element('details', 'liveAdmin-users');
    users.append(element('summary', '', '在线账号'), element('div', 'liveAdmin-userList'));
    online.append(onlineHead, tiles, users);

    const send = element('section', 'liveAdmin-section');
    const typeRow = element('div', 'liveAdmin-row');
    typeRow.append(element('span', 'liveAdmin-label', '指令'), element('div', 'liveAdmin-types'));
    const targetRow = element('div', 'liveAdmin-row');
    const handles = element('input', 'text_pole liveAdmin-handles');
    handles.placeholder = '账号，多个用空格或逗号分隔';
    handles.hidden = true;
    targetRow.append(element('span', 'liveAdmin-label', '发给'), radioGroup('liveAdminTarget', [['all', '所有页面'], ['admins', '仅管理员'], ['handles', '指定账号']], 'all'), handles);
    const fields = element('div', 'liveAdmin-fields');
    const lateRow = element('label', 'liveAdmin-field is-checkbox');
    const late = element('input');
    late.type = 'checkbox';
    lateRow.append(late, element('span', '', '不在线的话，上线后补发（保留期内打开网页就会收到，每个账号看到一次，关掉才算看到）'));
    lateRow.hidden = true;
    const keepRow = element('label', 'liveAdmin-field');
    const keep = element('select', 'text_pole liveAdmin-keep');
    for (const [value, label] of KEEP_OPTIONS) keep.append(Object.assign(element('option', '', label), { value: String(value) }));
    keepRow.append(element('span', 'liveAdmin-label', '保留'), keep);
    const actions = element('div', 'liveAdmin-actions');
    const status = element('span', 'liveAdmin-status');
    status.setAttribute('role', 'status');
    const submit = element('button', 'menu_button menu_button_icon liveAdmin-send');
    submit.type = 'button';
    submit.append(element('i', 'fa-fw fa-solid fa-paper-plane'), element('span', '', '发送'));
    actions.append(status, submit);
    send.append(element('h4', '', '发送'), typeRow, targetRow, fields, lateRow, keepRow, actions);

    const kept = element('section', 'liveAdmin-section');
    kept.append(element('h4', '', '保留中的指令'), element('div', 'liveAdmin-kept'));
    kept.hidden = true;

    const note = element('p', 'liveAdmin-muted liveAdmin-note', '服务器上也可以放指令文件触发（如部署脚本）：数据目录下 _global/live/outbox/*.json，内容同 POST /api/live/send，例如 {"type":"reload","data":{"delay":10},"keep":3600}；上线后补发的消息加 "late": true，keep 最长 30 天。');

    root.append(header, online, send, kept, note);
    block.replaceChildren(root);
    return { root, refresh, tiles, users, typeRow, targetRow, handles, fields, lateRow, late, keep, status, submit, kept, commands: [] };
}

function setStatus(view, text, state = '') {
    view.status.textContent = text;
    view.status.dataset.state = state;
}

function selectedType(view) {
    return view.typeRow.querySelector('input:checked')?.value ?? '';
}

function selectedTarget(view) {
    return view.targetRow.querySelector('input:checked')?.value ?? 'all';
}

function renderFields(view) {
    const type = selectedType(view);
    const form = FORMS[type];
    if (form) {
        view.fields.replaceChildren(...form.fields.map(field));
    } else {
        const json = field({ key: '', label: '数据（JSON）', type: 'textarea' });
        json.querySelector('textarea').placeholder = '{}';
        view.fields.replaceChildren(json);
    }
    const command = view.commands.find(item => item.type === type);
    view.lateRow.hidden = !command?.late;
    view.late.checked = false;
    fillKeep(view);
}

/** 保留时间的选项：上线后补发按天，其他按分钟、小时 */
function fillKeep(view) {
    const late = isLate(view);
    const command = view.commands.find(item => item.type === selectedType(view));
    const keep = String(late ? LATE_KEEP_DEFAULT : command?.keep ?? 0);
    const options = (late ? LATE_KEEP_OPTIONS : KEEP_OPTIONS).map(([value, label]) => [String(value), label]);
    if (!options.some(([value]) => value === keep)) options.push([keep, `${keep} 秒`]);
    view.keep.replaceChildren(...options.map(([value, label]) => Object.assign(element('option', '', label), { value })));
    view.keep.value = keep;
}

function isLate(view) {
    return !view.lateRow.hidden && view.late.checked;
}

function renderCommands(view, commands) {
    const types = commands.map(command => command.type);
    if (types.join() === view.commands.map(command => command.type).join()) {
        view.commands = commands;
        return;
    }
    const current = selectedType(view);
    view.commands = commands;
    const options = types.map(type => [type, FORMS[type]?.label ?? type]);
    const group = radioGroup('liveAdminType', options, types.includes(current) ? current : types[0]);
    view.typeRow.querySelector('.liveAdmin-types').replaceWith(Object.assign(group, { className: 'liveAdmin-segmented liveAdmin-types' }));
    renderFields(view);
}

function renderStatus(view, data) {
    const tile = (value, label) => {
        const node = element('div', 'liveAdmin-tile');
        node.append(element('strong', '', String(value)), element('span', '', label));
        return node;
    };
    view.tiles.replaceChildren(tile(data.pages, '页面'), tile(data.users.length, '账号'), tile(data.admins, '管理员页面'));

    view.users.querySelector('summary').textContent = `在线账号（${data.users.length}）· 点击加入「指定账号」`;
    const list = view.users.querySelector('.liveAdmin-userList');
    list.replaceChildren(...data.users.map(user => {
        const chip = element('button', 'liveAdmin-chip', user.pages > 1 ? `${user.handle} ×${user.pages}` : user.handle);
        chip.type = 'button';
        chip.dataset.handle = user.handle;
        return chip;
    }));

    renderCommands(view, data.commands);

    const keptList = view.kept.querySelector('.liveAdmin-kept');
    view.kept.hidden = data.kept.length === 0;
    keptList.replaceChildren(...data.kept.slice().reverse().map(command => {
        const row = element('div', 'liveAdmin-keptRow');
        const text = element('div', 'liveAdmin-keptText');
        const snippet = command.type === 'notice' ? String(command.data?.title || command.data?.text || '').replace(/\s+/g, ' ').slice(0, 24) : '';
        const parts = [FORMS[command.type]?.label ?? command.type, snippet && `「${snippet}」`, command.late && '上线后补发', describeTarget(command.target), `${formatTime(command.at)} 发出，保留到 ${formatTime(command.until)}`];
        text.append(element('span', '', parts.filter(Boolean).join(' · ')));
        const seen = describeSeen(command);
        if (seen) text.append(element('span', 'liveAdmin-keptSeen', seen));
        const cancel = element('button', 'menu_button liveAdmin-small', seen === '全部已看到' ? '移除' : '撤销');
        cancel.type = 'button';
        cancel.dataset.cancel = command.id;
        row.append(text, cancel);
        return row;
    }));
}

function readData(view) {
    const type = selectedType(view);
    const form = FORMS[type];
    if (!form) {
        const raw = view.fields.querySelector('textarea').value.trim();
        try {
            return raw ? JSON.parse(raw) : {};
        } catch {
            throw new Error('数据不是有效的 JSON');
        }
    }
    const data = {};
    for (const spec of form.fields) {
        const input = view.fields.querySelector(`[data-key="${spec.key}"]`);
        if (spec.type === 'checkbox') data[spec.key] = input.checked;
        else if (spec.type === 'number') data[spec.key] = Number(input.value);
        else data[spec.key] = input.value.trim();
        if (spec.required && !data[spec.key]) throw new Error(`请填写${spec.label}`);
    }
    return data;
}

function readTarget(view) {
    const target = selectedTarget(view);
    if (target === 'all') return { all: true };
    if (target === 'admins') return { admins: true };
    const handles = view.handles.value.split(/[\s,，]+/).filter(Boolean);
    if (!handles.length) throw new Error('请填写账号');
    return { handles };
}

async function load(view) {
    renderStatus(view, await request('status'));
}

/** 发给所有页面要再点一次确认。 */
let confirmUntil = 0;

async function submit(view) {
    let body;
    try {
        body = { type: selectedType(view), target: readTarget(view), data: readData(view), keep: Number(view.keep.value) };
        if (isLate(view)) body.late = true;
    } catch (error) {
        setStatus(view, error.message, 'error');
        return;
    }
    const label = view.submit.querySelector('span');
    if (body.target.all && Date.now() > confirmUntil) {
        confirmUntil = Date.now() + 4000;
        label.textContent = body.late ? '确认发给所有人' : '确认发给所有页面';
        setStatus(view, body.late ? '将发给所有账号（在线的马上收到，其他人保留期内上线时收到），再点一次确认' : '将发给所有打开着的页面，再点一次确认', 'dirty');
        setTimeout(() => {
            if (Date.now() >= confirmUntil) label.textContent = '发送';
        }, 4100);
        return;
    }
    confirmUntil = 0;
    label.textContent = '发送';
    view.submit.disabled = true;
    setStatus(view, '正在发送…');
    try {
        const result = await request('send', body);
        const after = result.late ? '；不在线的账号保留期内打开网页时也会收到' : result.kept ? '，保留期内重连的页面也会收到' : '';
        setStatus(view, `已发送到 ${result.pages} 个页面${after}`, 'ok');
        await load(view);
    } catch (error) {
        setStatus(view, error.message, 'error');
    } finally {
        view.submit.disabled = false;
    }
}

function startAutoRefresh(block, view) {
    const timer = setInterval(() => {
        if (!block.isConnected) {
            clearInterval(timer);
            return;
        }
        if (document.hidden || block.offsetParent === null) return;
        load(view).catch(() => {});
    }, REFRESH_MS);
}

export async function openLiveAdmin(block) {
    if (!block) return;
    /** @type {ReturnType<typeof buildView>} */
    let view = block.__liveAdminView;
    if (!view) {
        view = buildView(block);
        block.__liveAdminView = view;
        view.refresh.addEventListener('click', () => load(view).catch(error => setStatus(view, error.message, 'error')));
        view.typeRow.addEventListener('change', () => renderFields(view));
        view.late.addEventListener('change', () => {
            fillKeep(view);
            // 补发的消息默认一直显示到对方关掉
            const timeout = view.fields.querySelector('[data-key="timeout"]');
            if (timeout && view.late.checked) timeout.value = '0';
        });
        view.targetRow.addEventListener('change', event => {
            if (event.target === view.handles) return;
            view.handles.hidden = selectedTarget(view) !== 'handles';
        });
        view.users.addEventListener('click', event => {
            const handle = event.target.closest('[data-handle]')?.dataset.handle;
            if (!handle) return;
            const radio = view.targetRow.querySelector('input[value="handles"]');
            radio.checked = true;
            view.handles.hidden = false;
            const list = view.handles.value.split(/[\s,，]+/).filter(Boolean);
            if (!list.includes(handle)) view.handles.value = [...list, handle].join(' ');
        });
        view.kept.addEventListener('click', async event => {
            const id = event.target.closest('[data-cancel]')?.dataset.cancel;
            if (!id) return;
            try {
                await request('cancel', { id });
                setStatus(view, '已撤销，之后连上的页面不会再收到', 'ok');
            } catch (error) {
                setStatus(view, error.message, 'error');
            }
            await load(view).catch(() => {});
        });
        view.submit.addEventListener('click', () => void submit(view));
        startAutoRefresh(block, view);
    }
    try {
        await load(view);
    } catch (error) {
        setStatus(view, error.message, 'error');
    }
}

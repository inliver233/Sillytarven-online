// 管理员面板：通行密钥（紧凑布局：设置一屏放下，用户列表在自己的框里滚动）
import { getRequestHeaders } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';

const SWITCHES = Object.freeze([
    { key: 'enabled', label: '启用通行密钥', title: '关闭后登录页按钮和设置入口都隐藏，也不能用通行密钥登录；已添加的保留，重新开启即可继续用。' },
    { key: 'allowRegistration', label: '允许添加新的', title: '关闭后用户不能再添加，已添加的仍可登录。' },
    { key: 'showOnLoginPage', label: '登录页显示按钮', title: '关闭后登录页不显示「通行密钥登录」。' },
    { key: 'showInSettings', label: '用户设置显示入口', title: '关闭后只能从公告里的 #passkeys 链接打开。' },
]);

const SELECTS = Object.freeze([
    {
        key: 'loginPrompt', label: '进站提醒', title: '用户进站后，对还没添加通行密钥的人弹一条可关闭的小提示（按用户和浏览器计）。', options: [
            ['off', '不提醒'],
            ['once', '提醒一次'],
            ['weekly', '每周提醒'],
        ],
    },
    {
        key: 'userVerification', label: '验证要求', title: '「必须验证」更安全，但不带指纹或 PIN 的实体安全钥将无法使用。', options: [
            ['preferred', '尽量验证（兼容安全钥）'],
            ['required', '必须验证指纹 / 面容 / 锁屏密码'],
        ],
    },
]);

const TEXTS = Object.freeze([
    { key: 'loginButtonText', label: '按钮文字', title: '登录页「通行密钥登录」按钮上的文字（最多 20 字）', max: 20, placeholder: '通行密钥登录' },
    { key: 'loginHintText', label: '按钮下方说明', title: '登录页按钮下方的小字说明，留空则不显示（最多 80 字）', max: 80, placeholder: '留空则不显示' },
    { key: 'managerDescription', label: '设置窗口说明', title: '用户打开通行密钥设置时顶部的说明（最多 120 字）', max: 120, placeholder: '' },
    { key: 'rpName', label: '站点名称', title: '显示在系统密码管理器里，只影响之后新添加的（最多 40 字）', max: 40, placeholder: 'SillyTavern' },
]);

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatDate(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    if (date.toDateString() === new Date().toDateString()) {
        return `今天 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function callAdminApi(path, body = undefined) {
    const response = await fetch(`/api/passkeys/admin/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`);
    return data;
}

function field(label, control, className = 'passkeyAdmin-field', title = '') {
    const wrap = element('label', className);
    if (title) wrap.title = title;
    wrap.append(element('span', 'passkeyAdmin-fieldLabel', label), control);
    return wrap;
}

function buildView(block) {
    const root = element('div', 'backupLimits passkeyAdmin');

    // Title, state and save on one line.
    const top = element('div', 'passkeyAdmin-top');
    const status = element('span', 'passkeyAdmin-pill');
    const saveStatus = element('span', 'backupLimits-status passkeyAdmin-saveStatus');
    saveStatus.setAttribute('role', 'status');
    const save = element('button', 'menu_button menu_button_icon passkeyAdmin-save');
    save.type = 'button';
    save.append(element('i', 'fa-fw fa-solid fa-floppy-disk'), element('span', '', '保存'));
    const title = element('div', 'passkeyAdmin-title');
    title.append(element('h3', '', '通行密钥'), status);
    top.append(title, saveStatus, save);

    const settings = element('section', 'passkeyAdmin-panel');
    const switches = element('div', 'passkeyAdmin-switches');
    for (const item of SWITCHES) {
        const label = element('label', 'passkeyAdmin-switch');
        label.title = item.title;
        const input = element('input');
        input.type = 'checkbox';
        input.dataset.setting = item.key;
        label.append(input, element('span', '', item.label));
        switches.append(label);
    }

    const rules = element('div', 'passkeyAdmin-rules');
    const max = element('input', 'text_pole');
    max.type = 'number';
    max.min = '1';
    max.max = '50';
    max.step = '1';
    max.inputMode = 'numeric';
    max.dataset.setting = 'maxPerUser';
    rules.append(field('每人上限', max, 'passkeyAdmin-field passkeyAdmin-max', '每个用户最多能添加几个（1–50）'));
    for (const item of SELECTS) {
        const select = element('select', 'text_pole');
        select.dataset.setting = item.key;
        for (const [value, text] of item.options) {
            const option = element('option', '', text);
            option.value = value;
            select.append(option);
        }
        rules.append(field(item.label, select, `passkeyAdmin-field passkeyAdmin-${item.key}`, item.title));
    }

    const texts = element('div', 'passkeyAdmin-texts');
    for (const item of TEXTS) {
        const input = element('input', 'text_pole');
        input.type = 'text';
        input.maxLength = item.max;
        input.placeholder = item.placeholder;
        input.dataset.setting = item.key;
        texts.append(field(item.label, input, 'passkeyAdmin-field', item.title));
    }

    const foot = element('div', 'passkeyAdmin-foot');
    const preview = element('span', 'passkeyAdmin-preview');
    preview.title = '登录页按钮预览';
    preview.append(element('i', 'fa-solid fa-fingerprint'), element('span'));
    const domain = element('small', 'backupLimits-muted passkeyAdmin-domain');
    foot.append(preview, domain);

    settings.append(switches, rules, texts, foot);

    // Usage.
    const usage = element('section', 'passkeyAdmin-panel');
    const usageHead = element('div', 'passkeyAdmin-usageHead');
    const refresh = element('button', 'menu_button passkeyAdmin-iconButton');
    refresh.type = 'button';
    refresh.title = '刷新';
    refresh.append(element('i', 'fa-fw fa-solid fa-rotate'));
    const search = element('input', 'text_pole passkeyAdmin-search');
    search.type = 'search';
    search.placeholder = '搜索用户';
    usageHead.append(element('h4', '', '使用情况'), search, refresh);
    const tiles = element('div', 'passkeyAdmin-tiles');
    const days = element('div', 'passkeyAdmin-days');
    const providers = element('div', 'passkeyAdmin-providers');
    const users = element('div', 'passkeyAdmin-users');
    usage.append(usageHead, tiles, days, providers, users);

    root.append(top, settings, usage);
    block.replaceChildren(root);
    return { root, status, saveStatus, save, preview, domain, refresh, search, tiles, days, providers, users };
}

function renderSettings(view, settings) {
    for (const input of view.root.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
        else input.value = String(settings[key] ?? '');
    }
    syncDerived(view);
}

function readSettings(view) {
    const settings = {};
    for (const input of view.root.querySelectorAll('[data-setting]')) {
        settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
    }
    const max = Number(settings.maxPerUser);
    if (!Number.isInteger(max) || max < 1 || max > 50) {
        throw new Error('每人上限需要是 1 到 50 之间的整数');
    }
    settings.maxPerUser = max;
    return settings;
}

function syncDerived(view) {
    const value = key => view.root.querySelector(`[data-setting="${key}"]`);
    view.preview.querySelector('span').textContent = value('loginButtonText').value.trim() || '通行密钥登录';
    const hint = value('loginHintText').value.trim();
    view.preview.title = hint ? `登录页按钮预览\n说明：${hint}` : '登录页按钮预览（不显示说明）';
    const enabled = value('enabled').checked;
    for (const key of ['allowRegistration', 'showOnLoginPage', 'showInSettings']) {
        value(key).closest('.passkeyAdmin-switch').classList.toggle('is-muted', !enabled);
    }
}

function renderStatus(view, status, settings) {
    let state = 'on';
    let text = '已开启';
    let title = '用户可以在登录页和用户设置里使用通行密钥。';
    if (!status.accounts) {
        state = 'unavailable';
        text = '不可用';
        title = '本节点没有开启账号登录（enableUserAccounts）。';
    } else if (status.stcontrol) {
        state = 'unavailable';
        text = '由主控负责';
        title = '本节点的用户在主控登录：通行密钥在主控后台「通行密钥」里开关和管理，主控开启后，用户设置里的通行密钥按钮会打开主控账号页。';
    } else if (!settings.enabled) {
        state = 'off';
        text = '已关闭';
        title = '登录页和用户设置里都不显示，已添加的通行密钥保留。';
    }
    view.status.dataset.state = state;
    view.status.textContent = text;
    view.status.title = title;
    const origins = status.origins || [];
    view.domain.textContent = `域名 ${status.rpId} · 来源 ${origins.map(origin => origin.replace(/^https?:\/\//, '')).join('、')}`;
    view.domain.title = '在 config.yaml 的 passkeys.rpId / passkeys.origins 修改并重载；改动后已添加的通行密钥全部失效。';
}

function tile(label, value, detail) {
    const node = element('div', 'passkeyAdmin-tile');
    node.append(element('b', '', String(value)), element('span', '', label));
    node.title = detail;
    const small = element('small', '', detail);
    node.append(small);
    return node;
}

function renderUsage(view, data, state) {
    const { summary, stats } = data;
    view.tiles.replaceChildren(
        tile('开通用户', summary.users, `近 7 天用过 ${summary.activeUsers7d} 人`),
        tile('通行密钥', summary.passkeys, `近 7 天新增 ${summary.added7d} · 可同步 ${summary.synced}`),
        tile('近 7 天登录', stats.total.logins, `今天 ${stats.today.logins} 次`),
        tile('近 7 天失败', stats.total.failures, '已删除或验证没通过'),
    );

    // Seven days across, three short rows down.
    const grid = element('div', 'passkeyAdmin-dayGrid');
    grid.append(element('span', 'passkeyAdmin-dayHead'));
    for (const day of stats.days) {
        grid.append(element('span', 'passkeyAdmin-dayHead', day.date === stats.today.date ? '今天' : day.date.slice(5)));
    }
    for (const [key, label] of [['logins', '登录'], ['registrations', '新增'], ['failures', '失败']]) {
        grid.append(element('span', 'passkeyAdmin-dayLabel', label));
        for (const day of stats.days) {
            const cell = element('span', 'passkeyAdmin-dayCell', String(day[key]));
            if (!day[key]) cell.classList.add('is-zero');
            grid.append(cell);
        }
    }
    view.days.replaceChildren(grid);

    view.providers.replaceChildren(...(summary.providers.length
        ? summary.providers.map(item => element('span', 'passkeyAdmin-chip', `${item.name} ${item.count}`))
        : []));
    view.providers.hidden = !summary.providers.length;

    renderUsers(view, data.users, state);
}

function renderUsers(view, users, state) {
    const query = view.search.value.trim().toLowerCase();
    const shown = users.filter(user => !query || user.handle.toLowerCase().includes(query) || String(user.name).toLowerCase().includes(query));
    if (!shown.length) {
        view.users.replaceChildren(element('p', 'passkeyAdmin-empty', users.length ? '没有匹配的用户' : '还没有人添加通行密钥'));
        return;
    }
    const rows = shown.slice(0, state.limit).map(user => {
        const row = element('div', 'passkeyAdmin-user');
        const head = element('div', 'passkeyAdmin-userHead');
        const who = element('span', 'passkeyAdmin-who');
        who.append(element('b', '', user.name));
        if (user.name !== user.handle) who.append(element('small', '', user.handle));
        if (user.admin) who.append(element('span', 'backupLimits-adminTag', '管理员'));
        if (!user.enabled) who.append(element('span', 'backupLimits-badge is-muted', '已禁用'));
        const meta = element('small', 'passkeyAdmin-userMeta', `${user.passkeys.length} 个 · 最近 ${formatDate(user.lastUsedAt)}`);
        const clear = element('button', 'menu_button passkeyAdmin-iconButton passkeyAdmin-clear');
        clear.type = 'button';
        clear.title = '删除该用户的全部通行密钥';
        clear.dataset.handle = user.handle;
        clear.dataset.name = user.name;
        clear.append(element('i', 'fa-fw fa-solid fa-user-slash'));
        head.append(who, meta, clear);

        const keys = element('div', 'passkeyAdmin-keys');
        for (const passkey of user.passkeys) {
            const chip = element('span', 'passkeyAdmin-key');
            chip.title = `${passkey.provider ? passkey.provider + '\n' : ''}添加于 ${formatDate(passkey.createdAt)}\n${passkey.lastUsedAt ? `上次使用 ${formatDate(passkey.lastUsedAt)}` : '还没用过'}${passkey.synced ? '\n可同步' : ''}`;
            chip.append(element('span', '', passkey.name), element('small', '', formatDate(passkey.lastUsedAt || passkey.createdAt)));
            const remove = element('button', 'passkeyAdmin-remove');
            remove.type = 'button';
            remove.title = '删除这个通行密钥';
            remove.dataset.handle = user.handle;
            remove.dataset.id = passkey.id;
            remove.dataset.name = passkey.name;
            remove.append(element('i', 'fa-solid fa-xmark'));
            chip.append(remove);
            keys.append(chip);
        }
        row.append(head, keys);
        return row;
    });
    view.users.replaceChildren(...rows);
    if (shown.length > state.limit) {
        const more = element('button', 'menu_button passkeyAdmin-more', `再显示 50 人（共 ${shown.length} 人）`);
        more.type = 'button';
        more.addEventListener('click', () => {
            state.limit += 50;
            renderUsers(view, users, state);
        });
        view.users.append(more);
    }
}

/**
 * Opens the passkey tab of the admin panel.
 * @param {HTMLElement} block Tab container
 */
export async function openPasskeysAdmin(block) {
    if (!block) return;
    // Opened again: refresh the numbers, keep any unsaved edits.
    if (block.__passkeysAdminReload) {
        await block.__passkeysAdminReload();
        return;
    }
    const view = buildView(block);
    const state = { limit: 50, users: [] };
    let saved = null;

    const setStatus = (text, kind = '') => {
        view.saveStatus.textContent = text;
        view.saveStatus.dataset.state = kind;
    };

    const load = async () => {
        view.refresh.classList.add('disabled');
        try {
            const data = await callAdminApi('overview');
            if (!saved) {
                saved = data.settings;
                renderSettings(view, data.settings);
            }
            renderStatus(view, data.status, saved);
            state.users = data.users;
            renderUsage(view, data, state);
        } catch (error) {
            setStatus(`读取失败：${error.message}`, 'error');
        } finally {
            view.refresh.classList.remove('disabled');
        }
    };

    const onEdit = event => {
        if (event.target === view.search) {
            renderUsers(view, state.users, state);
            return;
        }
        syncDerived(view);
        setStatus('未保存', 'dirty');
    };
    view.root.addEventListener('input', onEdit);
    view.root.addEventListener('change', event => {
        if (event.target !== view.search) onEdit(event);
    });

    view.save.addEventListener('click', async () => {
        let settings;
        try {
            settings = readSettings(view);
        } catch (error) {
            setStatus(error.message, 'error');
            return;
        }
        if (saved?.enabled && !settings.enabled) {
            const confirmed = await callGenericPopup('<h3>关闭通行密钥？</h3><p>关闭后所有用户都不能用通行密钥登录，需要改用其他方式。已添加的通行密钥会保留，重新开启即可继续使用。</p>',
                POPUP_TYPE.CONFIRM, '', { okButton: '关闭', cancelButton: '取消' });
            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        view.save.classList.add('disabled');
        try {
            const data = await callAdminApi('settings', { settings });
            saved = data.settings;
            renderSettings(view, saved);
            setStatus('已保存', 'ok');
            await load();
        } catch (error) {
            setStatus(`保存失败：${error.message}`, 'error');
        } finally {
            view.save.classList.remove('disabled');
        }
    });

    view.refresh.addEventListener('click', () => void load());
    block.__passkeysAdminReload = load;

    view.users.addEventListener('click', async event => {
        const target = /** @type {HTMLElement} */ (event.target).closest('.passkeyAdmin-remove, .passkeyAdmin-clear');
        if (!(target instanceof HTMLElement)) return;
        const all = target.classList.contains('passkeyAdmin-clear');
        const { handle, id, name } = target.dataset;
        const escape = text => $('<span>').text(text).html();
        const message = all
            ? `<h3>删除 ${escape(name)} 的全部通行密钥？</h3><p>适用于用户丢失设备等情况。删除后该用户只能用其他方式登录，之后可以重新添加。</p>`
            : `<h3>删除「${escape(name)}」？</h3><p>用户 ${escape(handle)} 将不能再用这个通行密钥登录，其他登录方式不受影响。</p>`;
        const confirmed = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        try {
            await callAdminApi('delete', all ? { handle, all: true } : { handle, id });
            toastr.success('已删除', '通行密钥');
            await load();
        } catch (error) {
            toastr.error(error.message, '通行密钥');
        }
    });

    await load();
}

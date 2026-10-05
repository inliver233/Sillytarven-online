// 管理员面板：通行密钥
import { getRequestHeaders } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';

const SWITCHES = Object.freeze([
    { key: 'enabled', title: '启用通行密钥', description: '关闭后登录页按钮和设置入口都会隐藏，也不能用通行密钥登录；用户已添加的通行密钥会保留，重新开启后可继续使用。' },
    { key: 'allowRegistration', title: '允许用户添加新的通行密钥', description: '关闭后用户不能再添加，已添加的仍可登录。' },
    { key: 'showOnLoginPage', title: '在登录页显示「通行密钥登录」按钮', description: '关闭后登录页不显示按钮（已有通行密钥也无法从登录页使用）。' },
    { key: 'showInSettings', title: '在用户设置里显示「通行密钥」入口', description: '关闭后只能从公告里的 #passkeys 链接打开设置窗口。' },
]);

const VERIFICATION = Object.freeze([
    { value: 'preferred', label: '尽量验证', hint: '有指纹 / 面容 / 锁屏密码就验证，兼容不带验证的实体安全钥。' },
    { value: 'required', label: '必须验证', hint: '每次都必须验证指纹、面容或锁屏密码，更安全；不支持验证的安全钥将无法使用。' },
]);

const PROMPTS = Object.freeze([
    { value: 'off', label: '不提醒' },
    { value: 'once', label: '提醒一次' },
    { value: 'weekly', label: '每周提醒' },
]);

const TEXTS = Object.freeze([
    { key: 'loginButtonText', label: '登录页按钮文字', max: 20, placeholder: '通行密钥登录' },
    { key: 'loginHintText', label: '登录页按钮下方的说明（留空则不显示）', max: 80, placeholder: '' },
    { key: 'managerDescription', label: '用户设置窗口顶部的说明', max: 120, placeholder: '', multiline: true },
    { key: 'rpName', label: '站点名称（显示在系统密码管理器里，只影响之后新添加的）', max: 40, placeholder: 'SillyTavern' },
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
    const today = new Date();
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (date.toDateString() === today.toDateString()) return `今天 ${time}`;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

function segmented(name, options) {
    const group = element('div', 'backupLimits-segmented');
    group.setAttribute('role', 'radiogroup');
    for (const option of options) {
        const label = element('label');
        const input = element('input');
        input.type = 'radio';
        input.name = name;
        input.value = option.value;
        label.append(input, element('span', '', option.label));
        group.append(label);
    }
    return group;
}

function card(icon, title, description) {
    const node = element('section', 'backupLimits-card');
    const head = element('div', 'backupLimits-cardHead');
    const titles = element('div', 'backupLimits-cardTitles');
    titles.append(element('h4', '', title));
    if (description) titles.append(element('p', 'backupLimits-muted', description));
    head.append(element('i', `fa-solid ${icon}`), titles);
    node.append(head);
    return node;
}

function buildView(block) {
    const root = element('div', 'backupLimits passkeyAdmin');

    const header = element('header', 'backupLimits-header');
    const status = element('div', 'passkeyAdmin-status');
    header.append(
        element('h3', '', '通行密钥'),
        element('p', 'backupLimits-muted', '让用户用指纹、面容或设备锁屏密码登录，不必每次走 Discord。通行密钥保存在各自账号里；这里的设置保存后立即生效，无需重启。'),
        status,
    );

    const switchesCard = card('fa-toggle-on', '开关');
    const switches = element('div', 'passkeyAdmin-switches');
    for (const item of SWITCHES) {
        const label = element('label', 'passkeyAdmin-switch');
        const input = element('input');
        input.type = 'checkbox';
        input.dataset.setting = item.key;
        const text = element('span', 'passkeyAdmin-switchText');
        text.append(element('b', '', item.title), element('small', 'backupLimits-muted', item.description));
        label.append(input, text);
        switches.append(label);
    }
    switchesCard.append(switches);

    const rulesCard = card('fa-sliders', '规则');
    const maxRow = element('label', 'backupLimits-perDay');
    const maxInput = element('input', 'text_pole');
    maxInput.type = 'number';
    maxInput.min = '1';
    maxInput.max = '50';
    maxInput.step = '1';
    maxInput.inputMode = 'numeric';
    maxInput.dataset.setting = 'maxPerUser';
    maxRow.append(element('span', '', '每人最多'), maxInput, element('span', '', '个（1–50）'));
    const verification = segmented('passkeyVerification', VERIFICATION);
    const verificationHint = element('p', 'backupLimits-note');
    const prompts = segmented('passkeyPrompt', PROMPTS);
    rulesCard.append(
        maxRow,
        element('h5', 'passkeyAdmin-label', '验证要求'), verification, verificationHint,
        element('h5', 'passkeyAdmin-label', '登录后提醒还没添加的用户'), prompts,
        element('p', 'backupLimits-note', '在用户进入酒馆后弹一条可关闭的小提示，点一下即可添加；同一用户在同一浏览器里按所选频率提醒。'),
    );

    const textsCard = card('fa-pen-to-square', '文案');
    const textFields = element('div', 'passkeyAdmin-texts');
    for (const item of TEXTS) {
        const label = element('label', 'passkeyAdmin-field');
        const input = element(item.multiline ? 'textarea' : 'input', 'text_pole');
        if (!item.multiline) input.type = 'text';
        else input.rows = 2;
        input.maxLength = item.max;
        input.placeholder = item.placeholder;
        input.dataset.setting = item.key;
        const head = element('span', 'passkeyAdmin-fieldHead');
        const counter = element('small', 'backupLimits-muted passkeyAdmin-counter');
        head.append(element('span', '', item.label), counter);
        label.append(head, input);
        textFields.append(label);
    }
    const preview = element('div', 'passkeyAdmin-preview');
    const previewButton = element('div', 'passkeyAdmin-previewButton');
    previewButton.append(element('i', 'fa-solid fa-fingerprint'), element('span'));
    const previewHint = element('small', 'passkeyAdmin-previewHint');
    preview.append(element('span', 'backupLimits-muted', '登录页预览'), previewButton, previewHint);
    textsCard.append(textFields, preview);

    const domainCard = card('fa-globe', '域名（只读）', '通行密钥绑定在这个域名上。如需修改，请改 config.yaml 里的 passkeys.rpId / passkeys.origins 后重载；改动后已添加的通行密钥将全部失效。');
    const domainInfo = element('div', 'passkeyAdmin-domain');
    domainCard.append(domainInfo);

    const actions = element('div', 'backupLimits-actions');
    const saveStatus = element('span', 'backupLimits-status');
    saveStatus.setAttribute('role', 'status');
    const save = element('button', 'menu_button menu_button_icon backupLimits-save');
    save.type = 'button';
    save.append(element('i', 'fa-fw fa-solid fa-floppy-disk'), element('span', '', '保存'));
    actions.append(saveStatus, save);

    const cards = element('div', 'passkeyAdmin-cards');
    cards.append(switchesCard, rulesCard, textsCard, domainCard);

    const usage = element('section', 'backupLimits-usage');
    const usageHead = element('div', 'backupLimits-usageHead');
    const refresh = element('button', 'menu_button menu_button_icon backupLimits-refresh');
    refresh.type = 'button';
    refresh.append(element('i', 'fa-fw fa-solid fa-rotate'), element('span', '', '刷新'));
    usageHead.append(element('h4', '', '使用情况'), refresh);
    const tiles = element('div', 'backupLimits-tiles passkeyAdmin-tiles');
    const days = element('div', 'backupLimits-table passkeyAdmin-days');
    const providers = element('div', 'passkeyAdmin-providers');
    const usersHead = element('div', 'passkeyAdmin-usersHead');
    const search = element('input', 'text_pole passkeyAdmin-search');
    search.type = 'search';
    search.placeholder = '搜索用户名 / 昵称';
    usersHead.append(element('h5', 'backupLimits-subhead', '已添加通行密钥的用户'), search);
    const users = element('div', 'backupLimits-table passkeyAdmin-users');
    usage.append(usageHead, tiles,
        element('h5', 'backupLimits-subhead', '最近 7 天'), days,
        element('h5', 'backupLimits-subhead', '保存在哪里'), providers,
        usersHead, users);

    root.append(header, cards, actions, usage);
    block.replaceChildren(root);
    return { root, status, maxInput, verification, verificationHint, prompts, previewButton, previewHint, domainInfo, saveStatus, save, refresh, tiles, days, providers, search, users };
}

function renderSettings(view, settings) {
    for (const input of view.root.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
        else input.value = String(settings[key] ?? '');
    }
    const check = (group, value) => {
        const radio = group.querySelector(`input[value="${value}"]`);
        if (radio) radio.checked = true;
    };
    check(view.verification, settings.userVerification);
    check(view.prompts, settings.loginPrompt);
    syncDerived(view);
}

function readSettings(view) {
    const settings = {};
    for (const input of view.root.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        settings[key] = input.type === 'checkbox' ? input.checked : input.value;
    }
    const max = Number(settings.maxPerUser);
    if (!Number.isInteger(max) || max < 1 || max > 50) {
        throw new Error('每人上限需要是 1 到 50 之间的整数');
    }
    settings.maxPerUser = max;
    settings.userVerification = view.verification.querySelector('input:checked')?.value ?? 'preferred';
    settings.loginPrompt = view.prompts.querySelector('input:checked')?.value ?? 'off';
    return settings;
}

/** Keeps the preview, counters and dependent switches in step with the form. */
function syncDerived(view) {
    const value = key => view.root.querySelector(`[data-setting="${key}"]`);
    view.previewButton.querySelector('span').textContent = value('loginButtonText').value.trim() || '通行密钥登录';
    view.previewHint.textContent = value('loginHintText').value.trim();
    view.previewHint.hidden = !view.previewHint.textContent;
    for (const input of view.root.querySelectorAll('.passkeyAdmin-field [data-setting]')) {
        input.closest('.passkeyAdmin-field').querySelector('.passkeyAdmin-counter').textContent = `${input.value.length} / ${input.maxLength}`;
    }
    const enabled = value('enabled').checked;
    for (const key of ['allowRegistration', 'showOnLoginPage', 'showInSettings']) {
        value(key).closest('.passkeyAdmin-switch').classList.toggle('is-muted', !enabled);
    }
    const verification = view.verification.querySelector('input:checked')?.value;
    view.verificationHint.textContent = VERIFICATION.find(item => item.value === verification)?.hint ?? '';
}

function renderStatus(view, status, settings) {
    let state = 'on';
    let text = '已开启：用户可以在登录页和用户设置里使用通行密钥。';
    if (!status.accounts) {
        state = 'unavailable';
        text = '不可用：本节点没有开启账号登录（enableUserAccounts）。';
    } else if (status.stcontrol) {
        state = 'unavailable';
        text = '不可用：本节点的登录由主控负责，通行密钥不会生效。';
    } else if (!settings.enabled) {
        state = 'off';
        text = '已关闭：登录页和用户设置里都不显示，已添加的通行密钥保留。';
    }
    view.status.dataset.state = state;
    view.status.textContent = text;

    view.domainInfo.replaceChildren();
    const rows = [
        ['绑定域名', status.rpId + (status.rpIdFromConfig ? '' : '（未在 config.yaml 设置，使用访问时的主机名）')],
        ['允许来源', (status.origins || []).join('，') + (status.originsFromConfig ? '' : '（未在 config.yaml 设置，使用访问时的地址）')],
    ];
    for (const [label, value] of rows) {
        const row = element('div', 'passkeyAdmin-domainRow');
        row.append(element('span', 'backupLimits-muted', label), element('code', '', value));
        view.domainInfo.append(row);
    }
}

function tile(label, value, unit, detail = '') {
    const node = element('div', 'backupLimits-tile');
    const number = element('b', '', String(value));
    if (unit) number.append(element('small', '', unit));
    node.append(element('span', '', label), number);
    if (detail) node.append(element('span', 'backupLimits-tileDetail', detail));
    return node;
}

function renderUsage(view, data, state) {
    const { summary, stats } = data;
    view.tiles.replaceChildren(
        tile('开通的用户', summary.users, '人', `近 7 天用过 ${summary.activeUsers7d} 人`),
        tile('通行密钥', summary.passkeys, '个', `可同步 ${summary.synced} 个 · 近 7 天新增 ${summary.added7d}`),
        tile('通行密钥登录', stats.total.logins, '次', `今天 ${stats.today.logins} 次 · 近 7 天`),
        tile('登录失败', stats.total.failures, '次', '近 7 天（已删除或验证失败）'),
    );

    const head = element('div', 'backupLimits-row backupLimits-rowHead');
    head.append(element('span', '', '日期'), element('span', '', '登录'), element('span', '', '新增'), element('span', '', '失败'));
    view.days.replaceChildren(head, ...stats.days.slice().reverse().map(day => {
        const row = element('div', 'backupLimits-row');
        row.append(element('span', '', day.date === stats.today.date ? `今天（${day.date.slice(5)}）` : day.date.slice(5)),
            element('span', '', String(day.logins)), element('span', '', String(day.registrations)), element('span', '', String(day.failures)));
        return row;
    }));

    const total = summary.providers.reduce((sum, item) => sum + item.count, 0);
    view.providers.replaceChildren(...(summary.providers.length ? summary.providers.map(item => {
        const row = element('div', 'passkeyAdmin-provider');
        const bar = element('span', 'passkeyAdmin-bar');
        const fill = element('span');
        fill.style.width = `${Math.max(4, Math.round(item.count / total * 100))}%`;
        bar.append(fill);
        row.append(element('span', 'passkeyAdmin-providerName', item.name), bar, element('span', 'passkeyAdmin-providerCount', String(item.count)));
        return row;
    }) : [element('p', 'backupLimits-empty', '还没有人添加通行密钥')]));

    renderUsers(view, data.users, state);
}

function renderUsers(view, users, state) {
    const query = view.search.value.trim().toLowerCase();
    const shown = users.filter(user => !query || user.handle.toLowerCase().includes(query) || String(user.name).toLowerCase().includes(query));
    if (!shown.length) {
        view.users.replaceChildren(element('p', 'backupLimits-empty', users.length ? '没有匹配的用户' : '还没有人添加通行密钥'));
        return;
    }
    const head = element('div', 'backupLimits-row backupLimits-rowHead passkeyAdmin-userRow');
    head.append(element('span', '', '用户'), element('span', '', '数量'), element('span', '', '最近使用'), element('span'));
    view.users.replaceChildren(head, ...shown.slice(0, state.limit).map(user => {
        const wrap = element('div', 'passkeyAdmin-user');
        const row = element('button', 'backupLimits-row passkeyAdmin-userRow');
        row.type = 'button';
        row.setAttribute('aria-expanded', String(state.open.has(user.handle)));
        const who = element('span', 'backupLimits-handle');
        who.append(element('b', '', user.name));
        if (user.name !== user.handle) who.append(element('small', 'backupLimits-muted', ` ${user.handle}`));
        if (user.admin) who.append(element('span', 'backupLimits-adminTag', '管理员'));
        if (!user.enabled) who.append(element('span', 'backupLimits-badge is-muted', '已禁用'));
        row.append(who, element('span', '', `${user.passkeys.length} 个`), element('span', '', formatDate(user.lastUsedAt)), element('i', 'fa-solid fa-chevron-down passkeyAdmin-chevron'));
        const details = element('div', 'passkeyAdmin-details');
        details.hidden = !state.open.has(user.handle);
        for (const passkey of user.passkeys) {
            const item = element('div', 'passkeyAdmin-key');
            const text = element('span', 'passkeyAdmin-keyText');
            text.append(element('b', '', passkey.name),
                element('small', 'backupLimits-muted', `${passkey.provider ? passkey.provider + ' · ' : ''}添加于 ${formatDate(passkey.createdAt)} · ${passkey.lastUsedAt ? `上次使用 ${formatDate(passkey.lastUsedAt)}` : '还没用过'}${passkey.synced ? ' · 可同步' : ''}`));
            const remove = element('button', 'menu_button passkeyAdmin-remove');
            remove.type = 'button';
            remove.title = '删除这个通行密钥';
            remove.dataset.handle = user.handle;
            remove.dataset.id = passkey.id;
            remove.dataset.name = passkey.name;
            remove.append(element('i', 'fa-solid fa-trash-can'));
            item.append(text, remove);
            details.append(item);
        }
        const clear = element('button', 'menu_button menu_button_icon passkeyAdmin-clear');
        clear.type = 'button';
        clear.dataset.handle = user.handle;
        clear.dataset.name = user.name;
        clear.append(element('i', 'fa-solid fa-user-slash'), element('span', '', '删除该用户的全部通行密钥'));
        details.append(clear);
        row.addEventListener('click', () => {
            if (state.open.has(user.handle)) state.open.delete(user.handle);
            else state.open.add(user.handle);
            details.hidden = !state.open.has(user.handle);
            row.setAttribute('aria-expanded', String(!details.hidden));
        });
        wrap.append(row, details);
        return wrap;
    }));
    if (shown.length > state.limit) {
        const more = element('button', 'menu_button passkeyAdmin-more', `显示更多（还有 ${shown.length - state.limit} 人）`);
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
    const state = { open: new Set(), limit: 50, users: [] };
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

    view.root.addEventListener('input', event => {
        if (event.target === view.search) {
            renderUsers(view, state.users, state);
            return;
        }
        syncDerived(view);
        setStatus('有未保存的修改', 'dirty');
    });
    view.root.addEventListener('change', event => {
        if (event.target === view.search) return;
        syncDerived(view);
        setStatus('有未保存的修改', 'dirty');
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
            setStatus('已保存，立即生效', 'ok');
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
        const remove = /** @type {HTMLElement} */ (event.target).closest('.passkeyAdmin-remove');
        const clear = /** @type {HTMLElement} */ (event.target).closest('.passkeyAdmin-clear');
        const target = remove || clear;
        if (!target) return;
        event.stopPropagation();
        const { handle, id, name } = target.dataset;
        const message = remove
            ? `<h3>删除「${$('<span>').text(name).html()}」？</h3><p>用户 ${$('<span>').text(handle).html()} 将不能再用这个通行密钥登录，其他登录方式不受影响。</p>`
            : `<h3>删除 ${$('<span>').text(name).html()} 的全部通行密钥？</h3><p>适用于用户丢失设备等情况。删除后该用户只能用其他方式登录，之后可以重新添加。</p>`;
        const confirmed = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        try {
            await callAdminApi('delete', remove ? { handle, id } : { handle, all: true });
            toastr.success('已删除', '通行密钥');
            await load();
        } catch (error) {
            toastr.error(error.message, '通行密钥');
        }
    });

    await load();
}

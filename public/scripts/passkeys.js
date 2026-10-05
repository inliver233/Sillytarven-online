import { eventSource, event_types, getRequestHeaders } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { createPasskey, describePasskeyError, guessDeviceName, isHostCoveredBy, isPasskeySupported } from './util/webauthn.js';

/**
 * Passkey settings: list, add, rename and delete the passkeys of the signed-in
 * user. Opened from the button next to "Account" in the user settings, and from
 * any link to "#passkeys" (for example a button in an announcement).
 */

/** @type {Promise<{enabled: boolean, rpId: string|null, max?: number, allowRegistration?: boolean, showInSettings?: boolean, loginPrompt?: string, managerDescription?: string}>|null} */
let configRequest = null;

function loadPasskeyConfig() {
    configRequest ??= fetch('/api/passkeys/config')
        .then(response => response.ok ? response.json() : { enabled: false })
        .catch(() => {
            configRequest = null;
            return { enabled: false };
        });
    return configRequest;
}

async function callPasskeyApi(path, body = undefined) {
    const response = await fetch(`/api/passkeys/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data?.error || `请求失败（${response.status}）`);
        error.code = data?.code;
        throw error;
    }
    return data;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[ch]);
}

function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return `今天 ${date.toTimeString().slice(0, 5)}`;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function iconFor(name) {
    if (/iPhone|Android|手机|Samsung/i.test(name)) return 'fa-mobile-screen-button';
    if (/iPad/i.test(name)) return 'fa-tablet-screen-button';
    if (/Mac|Windows|Linux|电脑|Chromebook/i.test(name)) return 'fa-laptop';
    return 'fa-key';
}

/**
 * Opens the passkey settings.
 * @returns {Promise<void>}
 */
export async function openPasskeyManager() {
    const config = await loadPasskeyConfig();
    if (!config.enabled) {
        toastr.info('本站暂未开启通行密钥');
        return;
    }

    const root = $(`
        <div class="passkeyManager">
            <div class="passkeyManager-hero">
                <i class="passkeyManager-heroIcon fa-solid fa-fingerprint"></i>
                <div class="passkeyManager-heroText">
                    <b>通行密钥</b>
                    <span>${escapeHtml(config.managerDescription || '')}</span>
                </div>
            </div>
            <div class="passkeyManager-notice" hidden></div>
            <div class="passkeyManager-list" aria-live="polite"></div>
            <div class="passkeyManager-actions">
                <button type="button" class="menu_button passkeyManager-add">
                    <i class="fa-solid fa-plus"></i><span>添加通行密钥</span>
                </button>
                <small class="passkeyManager-count"></small>
            </div>
            <details class="passkeyManager-help">
                <summary>怎么用？</summary>
                <ol>
                    <li>在常用的设备上点「添加通行密钥」，按提示验证指纹或面容。</li>
                    <li>以后在登录页点「通行密钥登录」，验证一下就能进来。</li>
                    <li>iPhone / Mac 的 iCloud 钥匙串、安卓的 Google 密码管理器会自动同步到同一账号的其他设备；其他设备也可以各自添加，最多 ${config.max} 个。</li>
                    <li>部分没有谷歌服务的安卓手机、微信 / QQ 内置浏览器不支持通行密钥，请用系统浏览器或 Discord 登录。</li>
                </ol>
            </details>
        </div>`);
    const list = root.find('.passkeyManager-list');
    const addButton = root.find('.passkeyManager-add');
    const count = root.find('.passkeyManager-count');
    const notice = root.find('.passkeyManager-notice');
    let passkeys = [];
    let max = config.max;
    let allowRegistration = config.allowRegistration !== false;
    let busy = false;

    const showNotice = (text, kind = 'warning') => {
        notice.attr('data-kind', kind).text(text).prop('hidden', !text);
    };

    const canAdd = isPasskeySupported() && isHostCoveredBy(config.rpId);
    if (!allowRegistration) {
        showNotice('管理员暂时关闭了添加通行密钥，已添加的仍可正常登录。', 'info');
    } else if (!isPasskeySupported()) {
        showNotice('当前浏览器不支持通行密钥。微信 / QQ 里打开的页面请改用系统浏览器（Safari、Chrome、Edge 等）。');
    } else if (!isHostCoveredBy(config.rpId)) {
        showNotice(`请从 ${config.rpId} 的网址打开本站后再添加通行密钥。`);
    }

    const render = () => {
        const blocked = busy || !canAdd || !allowRegistration || passkeys.length >= max;
        count.text(`已添加 ${passkeys.length} / ${max}`);
        addButton.prop('disabled', blocked)
            .toggleClass('disabled', blocked)
            .find('span').text(!allowRegistration ? '暂停添加' : passkeys.length >= max ? `已达上限 ${max} 个` : busy ? '请在弹出的窗口中验证…' : '添加通行密钥');
        if (!passkeys.length) {
            list.html(`
                <div class="passkeyManager-empty">
                    <i class="fa-solid fa-key"></i>
                    <span>还没有通行密钥。添加后，下次登录只需验证一下指纹或面容。</span>
                </div>`);
            return;
        }
        list.html(passkeys.map(passkey => `
            <div class="passkeyManager-item" data-id="${escapeHtml(passkey.id)}">
                <i class="passkeyManager-itemIcon fa-solid ${iconFor(passkey.name)}"></i>
                <div class="passkeyManager-itemText">
                    <b>${escapeHtml(passkey.name)}</b>
                    <small>添加于 ${formatDate(passkey.createdAt)} · ${passkey.lastUsedAt ? `上次使用 ${formatDate(passkey.lastUsedAt)}` : '还没用过'}${passkey.synced ? ' · 可同步' : ''}</small>
                </div>
                <button type="button" class="menu_button passkeyManager-rename" title="改名"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="menu_button passkeyManager-delete" title="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div>`).join(''));
    };

    const refresh = async () => {
        try {
            const data = await callPasskeyApi('list');
            passkeys = data.passkeys || [];
            max = data.max || max;
            allowRegistration = data.allowRegistration !== false;
        } catch (error) {
            showNotice(`读取通行密钥失败：${error.message}`);
        }
        render();
    };

    addButton.on('click', async () => {
        if (busy || !canAdd || !allowRegistration || passkeys.length >= max) return;
        busy = true;
        render();
        try {
            const options = await callPasskeyApi('register/options', {});
            let credential;
            try {
                credential = await createPasskey(options);
            } catch (error) {
                showNotice(describePasskeyError(error, 'create') || '', 'warning');
                return;
            }
            const result = await callPasskeyApi('register/verify', { response: credential, name: guessDeviceName() });
            showNotice(`已添加「${result.passkey.name}」，下次在登录页点「通行密钥登录」就能直接进来。`, 'success');
        } catch (error) {
            showNotice(error.message, 'error');
        } finally {
            busy = false;
            await refresh();
        }
    });

    list.on('click', '.passkeyManager-rename', async function () {
        const id = String($(this).closest('.passkeyManager-item').data('id'));
        const passkey = passkeys.find(item => item.id === id);
        if (!passkey) return;
        const name = await callGenericPopup('给这个通行密钥起个名字，方便区分设备：', POPUP_TYPE.INPUT, passkey.name, { okButton: '保存', cancelButton: '取消' });
        if (typeof name !== 'string' || !name.trim() || name.trim() === passkey.name) return;
        try {
            const data = await callPasskeyApi('rename', { id, name: name.trim() });
            passkeys = data.passkeys;
            render();
        } catch (error) {
            showNotice(error.message, 'error');
        }
    });

    list.on('click', '.passkeyManager-delete', async function () {
        const id = String($(this).closest('.passkeyManager-item').data('id'));
        const passkey = passkeys.find(item => item.id === id);
        if (!passkey) return;
        const confirmed = await callGenericPopup(
            `<h3>删除「${escapeHtml(passkey.name)}」？</h3><p>删除后它就不能再登录本账号了，其他通行密钥和 Discord 登录不受影响。</p>`,
            POPUP_TYPE.CONFIRM, '', { okButton: '删除', cancelButton: '取消' });
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
        try {
            const data = await callPasskeyApi('delete', { id });
            passkeys = data.passkeys;
            render();
            showNotice(`已删除「${passkey.name}」`, 'success');
        } catch (error) {
            showNotice(error.message, 'error');
        }
    });

    render();
    const popup = new Popup(root, POPUP_TYPE.TEXT, '', { okButton: '完成', allowVerticalScrolling: true });
    const shown = popup.show();
    await refresh();
    await shown;
}

const PROMPT_INTERVALS = { once: Infinity, weekly: 7 * 24 * 60 * 60 * 1000 };

/**
 * Once the app is ready, suggests adding a passkey to a user who has none, as
 * often as the administrator chose ("once" or "weekly" per user and browser).
 * @param {object} config Passkey config
 * @param {() => string|null} getHandle Current user's handle
 */
function schedulePasskeyPrompt(config, getHandle) {
    const interval = PROMPT_INTERVALS[config.loginPrompt];
    if (!interval || !config.allowRegistration || !isPasskeySupported() || !isHostCoveredBy(config.rpId)) {
        return;
    }
    const handler = async () => {
        eventSource.removeListener(event_types.APP_READY, handler);
        const handle = getHandle();
        if (!handle) return;
        const key = `passkeyPromptAt:${handle}`;
        let last = 0;
        try {
            last = Number(localStorage.getItem(key)) || 0;
        } catch {
            return;
        }
        if (last && (interval === Infinity || Date.now() - last < interval)) return;
        try {
            const data = await callPasskeyApi('list');
            if ((data.passkeys || []).length > 0) return;
        } catch {
            return;
        }
        try {
            localStorage.setItem(key, String(Date.now()));
        } catch {
            // Shown anyway; it may come back next time.
        }
        toastr.info('添加一个通行密钥，下次用指纹或面容一键登录。点这里设置', '通行密钥', {
            timeOut: 15000,
            extendedTimeOut: 5000,
            closeButton: true,
            onclick: () => void openPasskeyManager(),
        });
    };
    eventSource.on(event_types.APP_READY, handler);
}

/**
 * Shows the passkey button in the user settings when passkeys are on, and lets
 * links to "#passkeys" open the passkey settings.
 * @param {{getHandle?: () => string|null}} [options] Options
 */
export function initPasskeys({ getHandle = () => null } = {}) {
    $(document).on('click', 'a[href="#passkeys"]', function (event) {
        event.preventDefault();
        // From the announcements: close them first, the settings take over from there.
        if ($(this).closest('#announcementsPopup').length) {
            $('#closeAnnouncementsPopup').trigger('click');
        }
        void openPasskeyManager();
    });
    $('#passkeys_button').on('click', () => void openPasskeyManager());
    void loadPasskeyConfig().then(config => {
        $('#passkeys_button').toggle(Boolean(config.enabled && config.showInSettings !== false));
        if (config.enabled) schedulePasskeyPrompt(config, getHandle);
    });
}

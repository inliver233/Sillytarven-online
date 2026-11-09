/**
 * 邀请好友（src/referrals.js）：自己的邀请链接和邀请码、规则、邀请到的人；新账号填写或通过链接绑定邀请人。
 * 邀请链接 /invite/<码> 把码记在这个浏览器里（st_pending_referral），新账号登录后这里问一次要不要绑定。
 * 「用户设置」里的入口只在管理员开启邀请奖励后显示。
 */
import { eventSource, event_types, getRequestHeaders } from '../script.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { isAdmin, openAdminPanel, openMyInvitationCodes } from './user.js';

const PENDING_KEY = 'st_pending_referral';
/** 链接记下的码，过了这么久就不再问 */
const PENDING_MAX_AGE_MS = 30 * 86_400_000;

const STATUS_TEXT = Object.freeze({
    pending: '等待首次 AI 回复',
    success: '已成功',
    expired: '已作废',
    revoked: '已撤销',
});

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

function button(label, icon, onClick, className = '') {
    const node = element('button', `menu_button menu_button_icon referralButton ${className}`.trim());
    node.type = 'button';
    node.append(element('i', `fa-fw fa-solid ${icon}`), element('span', '', label));
    node.addEventListener('click', async () => {
        node.disabled = true;
        try {
            await onClick();
        } finally {
            node.disabled = false;
        }
    });
    return node;
}

function formatDate(at) {
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const inviteLink = code => `${location.origin}/invite/${code}`;
const cleanCode = code => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);

async function copy(text, what) {
    try {
        await navigator.clipboard.writeText(text);
        toastr.success(`${what}已复制`);
    } catch {
        const box = element('div', 'referralCopyFallback');
        box.append(element('p', '', `复制不了，请手动复制下面的${what}：`), element('code', 'referralCopyText', text));
        await callGenericPopup(box, POPUP_TYPE.TEXT);
    }
}

function claimedToast(result) {
    if (result.status !== 'success') toastr.success('绑定成功。收到第一条 AI 回复后，你和好友都会加存储空间。');
    else if (result.rewardMiB > 0) toastr.success(`绑定成功，你获得了 ${result.rewardMiB} MB 存储空间。`);
    else toastr.success('绑定成功。');
}

function section(title, ...children) {
    const node = element('section', 'referralSection');
    node.append(element('h4', '', title), ...children);
    return node;
}

function renderSteps(data) {
    const { rules } = data;
    const steps = element('ol', 'referralSteps');
    const reward = `你得到 ${rules.inviterRewardMiB} MB，好友得到 ${rules.inviteeRewardMiB} MB 存储空间`;
    const items = [
        ['fa-share-nodes', '分享你的邀请链接或邀请码'],
        ['fa-user-plus', `好友用链接注册，或注册后 ${rules.claimWindowDays} 天内填写邀请码`],
        rules.requireValidReply ? ['fa-gift', `好友收到第一条 AI 回复后，${reward}`] : ['fa-gift', `绑定后立即到账：${reward}`],
    ];
    for (const [icon, text] of items) {
        const step = element('li');
        step.append(element('i', `fa-fw fa-solid ${icon}`), element('span', '', text));
        steps.append(step);
    }
    return steps;
}

function renderNotes(data) {
    const { rules } = data;
    const notes = element('ul', 'referralNotes');
    if (rules.inviterCapMiB > 0) notes.append(element('li', '', `你通过邀请最多获得 ${rules.inviterCapMiB} MB；到上限以后好友照样得到空间。`));
    if (rules.requireValidReply && rules.pendingExpireDays > 0) notes.append(element('li', '', `好友绑定后 ${rules.pendingExpireDays} 天内都没收到 AI 回复，这次邀请作废。`));
    notes.append(element('li', '', '每个账号只能绑定一个邀请人，不能邀请自己，也不能互相邀请。'));
    if (!data.rewardsAvailable) notes.append(element('li', 'is-warn', '本站没有开启存储空间上限，奖励暂时不会生效。'));
    return notes;
}

function renderMyLink(data, refresh) {
    if (data.code) {
        const link = inviteLink(data.code);
        const linkRow = element('div', 'referralRow');
        linkRow.append(element('code', 'referralLink', link), button('复制链接', 'fa-link', () => copy(link, '邀请链接')));
        const codeRow = element('div', 'referralRow');
        codeRow.append(element('span', 'referralMuted', '邀请码'), element('code', 'referralCode', data.code),
            button('复制', 'fa-copy', () => copy(data.code, '邀请码')),
            button('换一个', 'fa-rotate', async () => {
                const answer = await callGenericPopup('换一个新的邀请码？旧的邀请码和链接会失效，已经绑定的好友不受影响。', POPUP_TYPE.CONFIRM, '', { okButton: '换', cancelButton: '取消' });
                if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
                try {
                    await api('/code', { reset: true });
                    toastr.success('已换成新的邀请码');
                    await refresh();
                } catch (error) {
                    toastr.error(error.message);
                }
            }, 'is-quiet'));
        return section('我的邀请链接', linkRow, codeRow);
    }
    if (data.eligible) {
        return section('我的邀请链接', button('生成我的邀请链接', 'fa-wand-magic-sparkles', async () => {
            try {
                await api('/code', {});
                await refresh();
            } catch (error) {
                toastr.error(error.message);
            }
        }));
    }
    return section('我的邀请链接', element('p', 'referralMuted', '暂未达到邀请资格（注册时间或在线时长还不够），过段时间再来看看。'));
}

function renderTiles(data) {
    const tiles = element('div', 'referralTiles');
    const tile = (label, value, unit) => {
        const node = element('div', 'referralTile');
        const number = element('b', '', String(value));
        if (unit) number.append(element('small', '', unit));
        node.append(element('span', '', label), number);
        return node;
    };
    const success = data.invitees.filter(item => item.status === 'success').length;
    const earned = tile('已获得', data.earnedMiB, data.rules.inviterCapMiB > 0 ? `/ ${data.rules.inviterCapMiB} MB` : 'MB');
    if (data.rules.inviterCapMiB > 0) {
        const bar = element('div', 'referralCapBar');
        const fill = element('div');
        fill.style.width = `${Math.min(100, (data.earnedMiB / data.rules.inviterCapMiB) * 100)}%`;
        bar.append(fill);
        earned.append(bar);
    }
    tiles.append(tile('已邀请', data.invitees.length, '人'), tile('已成功', success, '人'), earned);
    return tiles;
}

function renderInvitees(data) {
    if (!data.invitees.length) return section('我邀请的人', element('p', 'referralMuted', '还没有。把邀请链接发给朋友吧。'));
    const list = element('div', 'referralList');
    for (const item of data.invitees) {
        const row = element('div', 'referralListRow');
        let reward = '';
        if (item.status === 'success') reward = item.rewardMiB > 0 ? `+${item.rewardMiB} MB` : (data.rewardsAvailable ? '已到上限' : '');
        row.append(element('span', 'referralName', item.name), element('span', `referralBadge is-${item.status}`, STATUS_TEXT[item.status] ?? item.status),
            element('span', 'referralReward', reward), element('span', 'referralMuted', formatDate(item.boundAt)));
        list.append(row);
    }
    return section('我邀请的人', list);
}

function renderInvitedBy(data, refresh) {
    if (data.invitedBy) {
        const by = data.invitedBy;
        const line = element('div', 'referralRow');
        line.append(element('span', 'referralName', by.name), element('span', `referralBadge is-${by.status}`, STATUS_TEXT[by.status] ?? by.status));
        if (by.status === 'success' && by.rewardMiB > 0) line.append(element('span', 'referralReward', `你获得了 ${by.rewardMiB} MB`));
        return section('我的邀请人', line);
    }
    if (!data.canClaim) return null;
    const row = element('div', 'referralRow');
    const input = /** @type {HTMLInputElement} */ (element('input', 'text_pole referralInput'));
    input.placeholder = '好友的邀请码';
    input.maxLength = 16;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const submit = async () => {
        if (!cleanCode(input.value)) return toastr.warning('请先填写邀请码');
        try {
            claimedToast(await api('/claim', { code: input.value }));
            await refresh();
        } catch (error) {
            toastr.error(error.message);
        }
    };
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') void submit();
    });
    row.append(input, button('绑定', 'fa-handshake', submit));
    return section('填写邀请人', row,
        element('p', 'referralMuted', `新账号注册后 ${data.rules.claimWindowDays} 天内可以填写（${formatDate(data.claimDeadline)} 截止），只能填一次。`));
}

async function renderExtras(data) {
    const extras = element('div', 'referralExtras');
    // 用户发放的注册邀请码（开着邀请码注册，或者以前发过）
    const registration = await fetch('/api/user-invitations/my', { headers: getRequestHeaders(), cache: 'no-store' })
        .then(response => (response.ok ? response.json() : null)).catch(() => null);
    if (registration?.systemEnabled || registration?.codes?.length) {
        extras.append(button('注册邀请码', 'fa-ticket', () => openMyInvitationCodes(), 'is-quiet'));
    }
    if (data.isAdmin) extras.append(button('邀请管理', 'fa-user-gear', () => openAdminPanel('userInvitationsAdminBlock'), 'is-quiet'));
    return extras.childElementCount ? extras : null;
}

async function render(root, data, refresh) {
    const parts = [];
    const header = element('header', 'referralHeader');
    header.append(element('h3', '', '邀请好友'));
    parts.push(header);
    if (!data.enabled) {
        header.append(element('p', 'referralMuted', '邀请奖励暂未开放。'));
    } else {
        header.append(element('p', 'referralMuted', '邀请朋友来用，你们都能多一些存储空间。'));
        parts.push(renderSteps(data), renderNotes(data), renderMyLink(data, refresh));
        if (data.code || data.invitees.length) parts.push(renderTiles(data), renderInvitees(data));
        parts.push(renderInvitedBy(data, refresh));
    }
    parts.push(await renderExtras(data));
    root.replaceChildren(...parts.filter(Boolean));
}

/** 打开「邀请好友」 */
export async function openReferralPanel() {
    const root = element('div', 'referralPanel');
    root.append(element('p', 'referralMuted', '加载中…'));
    const refresh = async () => {
        try {
            await render(root, { ...await api('/my'), isAdmin: isAdmin() }, refresh);
        } catch (error) {
            root.replaceChildren(element('p', 'referralMuted', `加载失败：${error.message}`));
        }
    };
    const popup = callGenericPopup(root, POPUP_TYPE.TEXT, '', { okButton: '关闭', wide: true, allowVerticalScrolling: true });
    await refresh();
    await popup;
}

/** 通过邀请链接来的：新账号登录后问一次要不要绑定 */
async function offerPendingReferral() {
    let pending = null;
    try {
        pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    } catch {
        // Unreadable: dropped below.
    }
    const code = cleanCode(pending?.code);
    const forget = () => localStorage.removeItem(PENDING_KEY);
    if (!code || Date.now() - Number(pending?.at || 0) > PENDING_MAX_AGE_MS) return forget();
    let data;
    try {
        data = await api('/my');
    } catch {
        return;
    }
    // 老账号、已经绑过的、自己的链接：不用问了
    if (!data.enabled || !data.canClaim || data.code === code) return forget();
    const { rules } = data;
    const box = element('div', 'referralOffer');
    box.append(element('h3', '', '绑定邀请人'), element('p', '', '你是通过好友的邀请链接来的，邀请码：'), element('code', 'referralCode', code),
        element('p', '', `${rules.requireValidReply ? '绑定后，收到第一条 AI 回复时' : '绑定后'}你获得 ${rules.inviteeRewardMiB} MB 存储空间，好友获得 ${rules.inviterRewardMiB} MB。每个账号只能绑定一次。`));
    const answer = await callGenericPopup(box, POPUP_TYPE.CONFIRM, '', { okButton: '绑定', cancelButton: '不用了' });
    forget();
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return;
    try {
        claimedToast(await api('/claim', { code, source: 'link' }));
    } catch (error) {
        toastr.error(error.message, '绑定邀请人没有成功');
    }
}

export function initReferrals() {
    $('#referral_button').on('click', () => void openReferralPanel());
    eventSource.on(event_types.APP_READY, () => {
        void api('/status').then(({ enabled }) => {
            $('#referral_button').toggle(Boolean(enabled));
            // 等其他启动弹窗和提示（公告、新手引导后的提示）先过去
            if (enabled && localStorage.getItem(PENDING_KEY)) setTimeout(() => void offerPendingReferral(), 4000);
        }).catch(() => null);
    });
}

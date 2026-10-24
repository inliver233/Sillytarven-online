import { esc } from '../shared.js';

/**
 * Form for a remote repository (host preset, address, login name, token).
 * @param {HTMLElement} container
 * @param {any} state /state response (providers, policy)
 * @param {{ name?: string, url?: string, provider?: string, username?: string, hasToken?: boolean }} [initial]
 * @returns {{ read: () => { name: string, url: string, provider: string, username: string, token: string } }}
 */
export function renderRemoteForm(container, state, initial = {}) {
    const providers = state.providers;
    const provider = initial.provider || 'github';
    container.innerHTML = `
        <div class="git-sync-form">
            <label>托管平台
                <select class="text_pole" data-field="provider">
                    ${Object.entries(providers).map(([id, entry]) => `<option value="${esc(id)}"${id === provider ? ' selected' : ''}>${esc(entry.label)}</option>`).join('')}
                </select>
            </label>
            <label>远程名称 <small>（一般用 origin）</small>
                <input class="text_pole" data-field="name" value="${esc(initial.name || 'origin')}" maxlength="50">
            </label>
            <label>仓库地址
                <input class="text_pole" data-field="url" value="${esc(initial.url || '')}" placeholder="https://github.com/你的用户名/tavern-backup.git" spellcheck="false">
            </label>
            <label data-row="username">用户名
                <input class="text_pole" data-field="username" value="${esc(initial.username || '')}" autocomplete="off" spellcheck="false">
            </label>
            <label>访问令牌（token）${initial.hasToken ? ' <small class="git-sync-ok">已保存，留空则不修改</small>' : ''}
                <input class="text_pole" data-field="token" type="password" autocomplete="new-password" placeholder="${initial.hasToken ? '••••••••' : '私有仓库和推送需要'}">
            </label>
            <div class="git-sync-hint" data-hint></div>
        </div>`;
    const field = name => container.querySelector(`[data-field="${name}"]`);
    const updateHint = () => {
        const entry = providers[field('provider').value];
        container.querySelector('[data-row="username"]').style.display = entry.needsUsername ? '' : 'none';
        const hint = container.querySelector('[data-hint]');
        const tips = [];
        if (field('provider').value === 'github') tips.push('建议创建一个<b>私有仓库</b>，token 需要 <code>repo</code> 权限（细粒度 token 需要 Contents 读写）。');
        if (field('provider').value === 'gitlab') tips.push('token 需要 <code>write_repository</code> 权限。');
        if (field('provider').value === 'gitee') tips.push('用户名填 Gitee 的个人空间地址名，token 需要 <code>projects</code> 权限。');
        if (field('provider').value === 'gitea') tips.push('用户名填你在该服务上的用户名，token 需要仓库读写权限。');
        if (entry.tokenUrl) tips.push(`<a href="${esc(entry.tokenUrl)}" target="_blank" rel="noopener noreferrer">去创建 token <i class="fa-solid fa-arrow-up-right-from-square"></i></a>`);
        if (!state.policy?.allowPrivateNetworks) tips.push('出于安全考虑，不能连接内网或本机地址。');
        hint.innerHTML = tips.join('<br>');
    };
    field('provider').addEventListener('change', updateHint);
    updateHint();
    return {
        read: () => ({
            name: field('name').value.trim() || 'origin',
            url: field('url').value.trim(),
            provider: field('provider').value,
            username: field('username').value.trim(),
            token: field('token').value.trim(),
        }),
    };
}

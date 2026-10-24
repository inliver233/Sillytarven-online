import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { confirmAction, esc, finishWorkTreeChange, flushPendingSaves, gitApi, showError } from '../shared.js';
import { runMergeFlow } from './merge.js';
import { renderRemoteForm } from './remote-form.js';

/**
 * Opens the remote form in a popup and saves it.
 * @returns {Promise<boolean>} Whether it was saved
 */
async function editRemote(app, initial) {
    const container = document.createElement('div');
    const form = renderRemoteForm(container, app.state, initial);
    while (true) {
        const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消', wide: true });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return false;
        try {
            const value = form.read();
            await gitApi('/remote/save', { ...value, previousName: initial?.name });
            toastr.success(`已保存远程仓库 ${esc(value.name)}`, '', { escapeHtml: false });
            return true;
        } catch (error) {
            showError(error, '保存失败');
        }
    }
}

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'remotes',
    label: '远程',
    icon: 'fa-cloud',
    module: 'remotes',
    async render(body, app) {
        const remotes = Object.entries(app.state.settings.remotes);
        const branch = app.state.branch;
        body.innerHTML = `
            <div class="git-sync-actions"><button type="button" class="menu_button" data-action="add"><i class="fa-solid fa-plus"></i> 添加远程仓库</button></div>
            ${remotes.length ? '' : '<div class="git-sync-empty"><i class="fa-solid fa-cloud"></i><p>连接一个 GitHub / GitLab / Gitee / Gitea 仓库，就能把存档推送上去，或在别的酒馆拉取下来。</p></div>'}
            ${remotes.map(([name, remote]) => `
                <section class="git-sync-panel-card" data-remote="${esc(name)}">
                    <h3><i class="fa-solid fa-cloud"></i> ${esc(name)} <small class="git-sync-muted">${esc(remote.provider === 'hosted' ? (app.state.hosted?.label ?? '酒馆云') : (app.state.providers[remote.provider]?.label ?? remote.provider))}</small></h3>
                    ${remote.provider === 'hosted' ? '' : `<div class="git-sync-path">${esc(remote.url)}</div>`}
                    <div class="git-sync-muted">${remote.provider === 'hosted' ? '<span class="git-sync-ok">本站提供，不用设置 token</span>' : `${remote.username ? `用户名 ${esc(remote.username)} · ` : ''}${remote.hasToken ? '<span class="git-sync-ok">token 已设置</span>' : '未设置 token（只能读取公开仓库）'}`}</div>
                    <div class="git-sync-actions">
                        <button type="button" class="menu_button git-sync-small" data-op="test"><i class="fa-solid fa-plug"></i> 测试连接</button>
                        <button type="button" class="menu_button git-sync-small" data-op="fetch"><i class="fa-solid fa-arrows-rotate"></i> 获取更新</button>
                        <button type="button" class="menu_button git-sync-small" data-op="pull"><i class="fa-solid fa-cloud-arrow-down"></i> 拉取并合并</button>
                        <button type="button" class="menu_button git-sync-small" data-op="push"><i class="fa-solid fa-cloud-arrow-up"></i> 推送${branch ? ` ${esc(branch)}` : ''}</button>
                        <button type="button" class="menu_button git-sync-small" data-op="push-advanced"><i class="fa-solid fa-sliders"></i> 高级推送…</button>
                        <button type="button" class="menu_button git-sync-small" data-op="import"><i class="fa-solid fa-download"></i> 导入分支…</button>
                        ${remote.provider === 'hosted' ? '' : '<button type="button" class="menu_button git-sync-small" data-op="edit"><i class="fa-solid fa-pen"></i> 编辑</button>'}
                        ${name === 'cloud' && remote.provider === 'hosted' ? '' : '<button type="button" class="menu_button git-sync-small danger" data-op="delete"><i class="fa-solid fa-trash"></i></button>'}
                    </div>
                    <div class="git-sync-remote-result"></div>
                </section>`).join('')}`;

        const add = async () => {
            if (await editRemote(app, remotes.length ? { name: '' } : undefined)) await app.refresh('remotes');
        };
        body.querySelector('[data-action="add"]').addEventListener('click', add);
        if (app.params.add) {
            app.params = {};
            void add();
        }

        body.querySelectorAll('[data-remote]').forEach(card => {
            const name = card.dataset.remote;
            const remote = app.state.settings.remotes[name];
            const result = card.querySelector('.git-sync-remote-result');
            card.querySelectorAll('[data-op]').forEach(button => button.addEventListener('click', async () => {
                const op = button.dataset.op;
                try {
                    if (op === 'test') {
                        const info = await app.busy('正在连接…', () => gitApi('/remote/test', { name }));
                        result.innerHTML = `<div class="git-sync-ok"><i class="fa-solid fa-circle-check"></i> 连接成功${info.canPush ? '，可以推送' : '，<b>但当前 token 不能推送</b>'}</div>
                            <div class="git-sync-muted">远程分支：${info.branches.map(entry => esc(entry.name)).join('、') || '（空仓库）'}</div>`;
                    } else if (op === 'fetch') {
                        await app.busy('正在获取更新…', () => gitApi('/fetch', { remote: name }));
                        toastr.success('已获取远程更新，可以在“分支”和“历史”里查看');
                    } else if (op === 'pull') {
                        await runMergeFlow(app, { route: '/pull', body: { remote: name }, label: '拉取', theirsLabel: `远程 ${name}` });
                    } else if (op === 'push') {
                        await app.busy('正在推送…', () => gitApi('/push', { remote: name }));
                        toastr.success('推送完成');
                    } else if (op === 'push-advanced') {
                        await advancedPush(app, name);
                    } else if (op === 'import') {
                        await importBranch(app, name);
                    } else if (op === 'edit') {
                        if (await editRemote(app, { name, ...remote })) await app.refresh('remotes');
                    } else if (op === 'delete') {
                        if (!await confirmAction(`删除远程仓库 <b>${esc(name)}</b> 的连接？（不会删除网上的仓库）`, { okButton: '删除', danger: true })) return;
                        await gitApi('/remote/delete', { name });
                        await app.refresh('remotes');
                    }
                } catch (error) {
                    showError(error, '操作失败');
                    if (error.status === 502 && op === 'push') {
                        result.innerHTML = '<div class="git-sync-warning">如果远程有你本地没有的提交，请先“拉取并合并”，或使用“高级推送”里的强制推送（会覆盖远程）。</div>';
                    }
                }
            }));
        });
    },
};

async function advancedPush(app, remote) {
    const branches = await gitApi('/branches');
    const container = document.createElement('div');
    container.innerHTML = `
        <h3>推送到 ${esc(remote)}</h3>
        <div class="git-sync-form">
            <label>本地分支 <select class="text_pole" data-field="branch">${branches.local.map(branch => `<option${branch.current ? ' selected' : ''}>${esc(branch.name)}</option>`).join('')}</select></label>
            <label>远程分支名（留空与本地同名）<input class="text_pole" data-field="remoteBranch"></label>
            <label class="checkbox_label"><input type="checkbox" data-field="tags"> 同时推送所有存档点（标签）</label>
            <label class="checkbox_label"><input type="checkbox" data-field="force"> 强制推送（用本地覆盖远程，远程多出来的提交会丢失）</label>
            <label class="checkbox_label"><input type="checkbox" data-field="delete"> 改为删除远程上的这个分支</label>
        </div>`;
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '执行', cancelButton: '取消', wide: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const field = name => container.querySelector(`[data-field="${name}"]`);
    const branch = field('branch').value;
    const remoteBranch = field('remoteBranch').value.trim() || branch;
    if (field('delete').checked) {
        if (!await confirmAction(`删除远程分支 <b>${esc(remote)}/${esc(remoteBranch)}</b>？`, { okButton: '删除', danger: true })) return;
        await app.busy('正在删除远程分支…', () => gitApi('/remote/delete-branch', { remote, branch: remoteBranch }));
        toastr.success('已删除远程分支');
        return;
    }
    if (field('force').checked && !await confirmAction(`强制推送会让 <b>${esc(remote)}/${esc(remoteBranch)}</b> 变成和本地 <b>${esc(branch)}</b> 完全一样，远程多出来的提交会丢失。继续？`, { okButton: '强制推送', danger: true })) return;
    const pushed = await app.busy('正在推送…', () => gitApi('/push', { remote, branch, remoteBranch, force: field('force').checked, tags: field('tags').checked }));
    toastr.success(`推送完成${pushed.pushedTags.length ? `，含 ${pushed.pushedTags.length} 个存档点` : ''}`);
}

async function importBranch(app, remote) {
    const info = await app.busy('正在读取远程分支…', () => gitApi('/remote/test', { name: remote }));
    if (!info.branches.length) {
        toastr.info('远程仓库是空的');
        return;
    }
    const container = document.createElement('div');
    container.innerHTML = `
        <h3>从 ${esc(remote)} 导入</h3>
        <label>分支 <select class="text_pole" data-field="branch">${info.branches.map(branch => `<option${branch.name === info.defaultBranch ? ' selected' : ''}>${esc(branch.name)}</option>`).join('')}</select></label>
        <div class="git-sync-warning"><i class="fa-solid fa-triangle-exclamation"></i> 导入会用这个分支的内容<b>替换</b>当前同步的数据，并切换到该分支。当前数据先保存为安全存档。如果想保留两边的改动，请用“拉取并合并”。</div>`;
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '导入', cancelButton: '取消', wide: true });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    await flushPendingSaves();
    const branch = container.querySelector('[data-field="branch"]').value;
    finishWorkTreeChange(await app.busy('正在导入…', () => gitApi('/import', { remote, branch })), '导入完成');
}

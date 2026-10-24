import { confirmAction, esc, finishWorkTreeChange, flushPendingSaves, gitApi, promptText, showError, timeAgo } from '../shared.js';
import { runMergeFlow } from './merge.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'branches',
    label: '分支',
    icon: 'fa-code-branch',
    module: 'branches',
    async render(body, app) {
        const data = await gitApi('/branches');
        body.innerHTML = `
            <div class="git-sync-hint">分支就像平行的故事线：在一个分支上随便改，不会影响另一个分支。切换分支时，酒馆里同步的数据会换成那个分支的版本（切换前自动保存安全存档）。</div>
            <div class="git-sync-actions"><button type="button" class="menu_button" data-action="create"><i class="fa-solid fa-plus"></i> 新建分支</button></div>
            <h4>本地分支</h4>
            <div class="git-sync-list">
                ${data.local.map(branch => `
                    <div class="git-sync-list-row${branch.current ? ' current' : ''}">
                        <div class="git-sync-list-main">
                            <b><i class="fa-solid fa-code-branch"></i> ${esc(branch.name)}</b>${branch.current ? ' <span class="git-sync-ref head">当前</span>' : ''}
                            <div class="git-sync-muted">${branch.lastCommit ? `${esc(branch.lastCommit.title)} · ${timeAgo(branch.lastCommit.timestamp)}` : ''}</div>
                        </div>
                        <div class="git-sync-actions">
                            ${branch.current ? '' : `<button type="button" class="menu_button git-sync-small" data-switch="${esc(branch.name)}"><i class="fa-solid fa-right-left"></i> 切换</button>
                            <button type="button" class="menu_button git-sync-small" data-merge="${esc(branch.name)}"><i class="fa-solid fa-code-merge"></i> 合并到当前</button>`}
                            <button type="button" class="menu_button git-sync-small" data-rename="${esc(branch.name)}" title="重命名"><i class="fa-solid fa-i-cursor"></i></button>
                            ${branch.current ? '' : `<button type="button" class="menu_button git-sync-small danger" data-delete="${esc(branch.name)}" title="删除"><i class="fa-solid fa-trash"></i></button>`}
                        </div>
                    </div>`).join('') || '<div class="git-sync-muted">还没有分支，先提交一次。</div>'}
            </div>
            ${data.remote.length ? `
            <h4>远程分支 <small class="git-sync-muted">（上次拉取时的状态）</small></h4>
            <div class="git-sync-list">
                ${data.remote.map(branch => `
                    <div class="git-sync-list-row">
                        <div class="git-sync-list-main"><b><i class="fa-solid fa-cloud"></i> ${esc(branch.name)}</b> <code>${esc(branch.oid.slice(0, 7))}</code></div>
                        <div class="git-sync-actions">
                            <button type="button" class="menu_button git-sync-small" data-switch="${esc(branch.name)}"><i class="fa-solid fa-right-left"></i> 切换到它</button>
                            <button type="button" class="menu_button git-sync-small" data-merge="${esc(branch.name)}"><i class="fa-solid fa-code-merge"></i> 合并到当前</button>
                        </div>
                    </div>`).join('')}
            </div>` : ''}`;

        body.querySelector('[data-action="create"]').addEventListener('click', async () => {
            const name = await promptText('新分支名称（例如：if线、测试新预设）');
            if (!name) return;
            const checkout = await confirmAction(`分支 <b>${esc(name)}</b> 从当前版本创建。要立即切换过去吗？`, { okButton: '创建并切换' });
            try {
                if (checkout) await flushPendingSaves();
                const result = await app.busy('正在创建分支…', () => gitApi('/branch/create', { name, checkout }));
                if (!finishWorkTreeChange(result, `已创建分支 ${name}`)) await app.refresh('branches');
            } catch (error) {
                showError(error, '创建分支失败');
            }
        });
        body.querySelectorAll('[data-switch]').forEach(button => button.addEventListener('click', async () => {
            const name = button.dataset.switch;
            if (!await confirmAction(`切换到 <b>${esc(name)}</b>？<br>酒馆里同步的数据会换成这个分支的版本，当前数据先保存为安全存档。`, { okButton: '切换' })) return;
            try {
                await flushPendingSaves();
                finishWorkTreeChange(await app.busy('正在切换分支…', () => gitApi('/branch/switch', { name })), `已切换到 ${name}`);
            } catch (error) {
                showError(error, '切换失败');
            }
        }));
        body.querySelectorAll('[data-merge]').forEach(button => button.addEventListener('click', () => runMergeFlow(app, {
            route: '/merge', body: { from: button.dataset.merge }, label: '合并', theirsLabel: button.dataset.merge,
        })));
        body.querySelectorAll('[data-rename]').forEach(button => button.addEventListener('click', async () => {
            const to = await promptText(`把分支 ${esc(button.dataset.rename)} 重命名为`, button.dataset.rename);
            if (!to || to === button.dataset.rename) return;
            try {
                await gitApi('/branch/rename', { from: button.dataset.rename, to });
                await app.refresh('branches');
            } catch (error) {
                showError(error, '重命名失败');
            }
        }));
        body.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
            if (!await confirmAction(`删除分支 <b>${esc(button.dataset.delete)}</b>？<br>只删除分支名，已有的提交仍可在历史和安全存档中找到。`, { okButton: '删除', danger: true })) return;
            try {
                await gitApi('/branch/delete', { name: button.dataset.delete });
                await app.refresh('branches');
            } catch (error) {
                showError(error, '删除失败');
            }
        }));
    },
};

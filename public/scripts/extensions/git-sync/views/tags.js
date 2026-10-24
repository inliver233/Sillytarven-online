import { confirmAction, esc, finishWorkTreeChange, flushPendingSaves, fullTime, gitApi, promptText, showError } from '../shared.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'tags',
    label: '存档点',
    icon: 'fa-bookmark',
    module: 'tags',
    async render(body, app) {
        const { tags } = await gitApi('/tags');
        body.innerHTML = `
            <div class="git-sync-hint">存档点是给某个版本起的名字（Git 里叫标签），比如“第一章完结”“换预设之前”。推送时可以一起推到远程。</div>
            <div class="git-sync-actions"><button type="button" class="menu_button" data-action="create"><i class="fa-solid fa-bookmark"></i> 给当前版本创建存档点</button></div>
            <div class="git-sync-list">
                ${tags.map(tag => `
                    <div class="git-sync-list-row">
                        <div class="git-sync-list-main">
                            <b><i class="fa-solid fa-bookmark"></i> ${esc(tag.name)}</b> <code>${esc(tag.oid.slice(0, 7))}</code>
                            ${tag.note && tag.note !== tag.name ? `<div>${esc(tag.note)}</div>` : ''}
                            <div class="git-sync-muted">${esc(tag.title)} · ${esc(fullTime(tag.timestamp))}</div>
                        </div>
                        <div class="git-sync-actions">
                            ${app.state.modules.includes('history') ? `<button type="button" class="menu_button git-sync-small" data-view="${esc(tag.oid)}"><i class="fa-solid fa-eye"></i> 查看</button>
                            <button type="button" class="menu_button git-sync-small" data-reset="${esc(tag.oid)}" data-name="${esc(tag.name)}"><i class="fa-solid fa-backward"></i> 回到这里</button>` : ''}
                            <button type="button" class="menu_button git-sync-small danger" data-delete="${esc(tag.name)}"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>`).join('') || '<div class="git-sync-muted">还没有存档点。</div>'}
            </div>`;
        body.querySelector('[data-action="create"]').addEventListener('click', async () => {
            const name = await promptText('存档点名称（例如：第一章完结）');
            if (!name) return;
            const note = await promptText('备注（可不填）') ?? '';
            try {
                await gitApi('/tag/create', { name, note });
                await app.refresh('tags');
            } catch (error) {
                showError(error, '创建失败');
            }
        });
        body.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => app.go('history', { oid: button.dataset.view })));
        body.querySelectorAll('[data-reset]').forEach(button => button.addEventListener('click', async () => {
            if (!await confirmAction(`回到存档点 <b>${esc(button.dataset.name)}</b>？当前数据先保存为安全存档。`, { okButton: '回到这里', danger: true })) return;
            try {
                await flushPendingSaves();
                finishWorkTreeChange(await app.busy('正在切换版本…', () => gitApi('/reset', { oid: button.dataset.reset })), '已回到存档点');
            } catch (error) {
                showError(error, '操作失败');
            }
        }));
        body.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
            if (!await confirmAction(`删除存档点 <b>${esc(button.dataset.delete)}</b>？（只删除名字，不删除数据）`, { okButton: '删除', danger: true })) return;
            try {
                await gitApi('/tag/delete', { name: button.dataset.delete });
                await app.refresh('tags');
            } catch (error) {
                showError(error, '删除失败');
            }
        }));
    },
};

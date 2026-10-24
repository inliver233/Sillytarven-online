import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { KIND_LABELS, confirmAction, esc, finishWorkTreeChange, flushPendingSaves, fullTime, gitApi, showError } from '../shared.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'safety',
    label: '安全存档',
    icon: 'fa-life-ring',
    module: 'safety',
    async render(body, app) {
        const { points } = await gitApi('/safety');
        body.innerHTML = `
            <div class="git-sync-hint">每次切换分支、拉取、合并、导入或恢复之前，酒馆 Git 都会自动把当时的数据（包括还没提交的改动）保存成安全存档。最多保留最近 30 份。</div>
            <div class="git-sync-list">
                ${points.map(point => `
                    <div class="git-sync-list-row">
                        <div class="git-sync-list-main">
                            <b><i class="fa-solid fa-life-ring"></i> ${esc(point.reason || '安全存档')}</b>
                            <div class="git-sync-muted">${esc(fullTime(point.createdAt / 1000))} · ${esc(point.title)} · <code>${esc(point.oid.slice(0, 7))}</code></div>
                        </div>
                        <div class="git-sync-actions">
                            <button type="button" class="menu_button git-sync-small" data-preview="${esc(point.id)}"><i class="fa-solid fa-eye"></i> 与当前对比</button>
                            <button type="button" class="menu_button git-sync-small" data-restore="${esc(point.id)}"><i class="fa-solid fa-rotate-left"></i> 恢复</button>
                            <button type="button" class="menu_button git-sync-small danger" data-delete="${esc(point.id)}"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>`).join('') || '<div class="git-sync-muted">还没有安全存档。</div>'}
            </div>`;
        body.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', async () => {
            try {
                const { changes } = await gitApi('/safety/preview', { id: button.dataset.preview });
                const html = changes.length
                    ? changes.slice(0, 300).map(change => `<div class="git-sync-change ${change.kind}"><span class="git-sync-kind ${change.kind}">${KIND_LABELS[change.kind]}</span><span class="git-sync-change-name" title="${esc(change.path)}">${esc(change.categoryLabel)} · ${esc(change.item)}</span></div>`).join('')
                    : '<div class="git-sync-muted">和当前提交没有区别。</div>';
                await callGenericPopup(`<h3>恢复后会改变的内容（相对当前提交）</h3>${html}`, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: '关闭' });
            } catch (error) {
                showError(error);
            }
        }));
        body.querySelectorAll('[data-restore]').forEach(button => button.addEventListener('click', async () => {
            if (!await confirmAction('把同步的数据恢复成这份安全存档？当前数据也会先保存一份安全存档。', { okButton: '恢复', danger: true })) return;
            try {
                await flushPendingSaves();
                finishWorkTreeChange(await app.busy('正在恢复…', () => gitApi('/safety/restore', { id: button.dataset.restore })), '已恢复安全存档');
            } catch (error) {
                showError(error, '恢复失败');
            }
        }));
        body.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => {
            if (!await confirmAction('删除这份安全存档？', { okButton: '删除', danger: true })) return;
            try {
                await gitApi('/safety/delete', { id: button.dataset.delete });
                await app.refresh('safety');
            } catch (error) {
                showError(error, '删除失败');
            }
        }));
    },
};

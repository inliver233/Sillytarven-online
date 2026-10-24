import { confirmAction, esc, gitApi, promptText, showError } from '../shared.js';
import { renderScopeForm } from './scope-form.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'settings',
    label: '设置',
    icon: 'fa-gear',
    module: 'core',
    async render(body, app) {
        const { settings, defaultAuthor, modules } = app.state;
        const auto = settings.autoBackup;
        const remotes = Object.keys(settings.remotes);
        body.innerHTML = `
            <section class="git-sync-panel-card">
                <h3><i class="fa-solid fa-filter"></i> 同步范围</h3>
                <div data-scope></div>
                <div class="git-sync-hint">取消勾选的类别，下次提交时会从仓库里移除（不会删除你酒馆里的数据）。</div>
            </section>
            <section class="git-sync-panel-card">
                <h3><i class="fa-solid fa-signature"></i> 提交署名</h3>
                <div class="git-sync-form">
                    <label>名字 <input class="text_pole" data-field="authorName" value="${esc(settings.author.name)}" placeholder="${esc(defaultAuthor.name)}"></label>
                    <label>邮箱 <input class="text_pole" data-field="authorEmail" value="${esc(settings.author.email)}" placeholder="${esc(defaultAuthor.email)}"></label>
                </div>
            </section>
            <div class="git-sync-actions"><button type="button" class="menu_button" data-action="save"><i class="fa-solid fa-floppy-disk"></i> 保存设置</button></div>
            ${modules.includes('autoBackup') ? `
            <section class="git-sync-panel-card">
                <h3><i class="fa-solid fa-robot"></i> 自动备份</h3>
                <div class="git-sync-form">
                    <label class="checkbox_label"><input type="checkbox" data-field="autoEnabled"${auto.enabled ? ' checked' : ''}> 定时自动提交</label>
                    <label>间隔（小时） <input class="text_pole" type="number" min="1" max="720" data-field="autoHours" value="${esc(auto.intervalHours)}"></label>
                    <label class="checkbox_label"><input type="checkbox" data-field="autoPush"${auto.push ? ' checked' : ''}${remotes.length ? '' : ' disabled'}> 提交后推送到远程</label>
                    <label>远程 <select class="text_pole" data-field="autoRemote">${remotes.map(name => `<option${name === auto.remote ? ' selected' : ''}>${esc(name)}</option>`).join('') || '<option value="">（先添加远程仓库）</option>'}</select></label>
                </div>
                ${auto.lastError ? `<div class="git-sync-warning">上次自动备份出错：${esc(auto.lastError)}</div>` : ''}
                <div class="git-sync-actions">
                    <button type="button" class="menu_button" data-action="save-auto"><i class="fa-solid fa-floppy-disk"></i> 保存自动备份设置</button>
                    <button type="button" class="menu_button" data-action="run-auto"><i class="fa-solid fa-play"></i> 立即运行一次</button>
                </div>
            </section>` : ''}
            <section class="git-sync-panel-card danger-zone">
                <h3><i class="fa-solid fa-triangle-exclamation"></i> 危险操作</h3>
                <p>删除本账号的酒馆 Git 仓库（全部历史、分支、存档点、安全存档和远程设置）。你酒馆里的数据和网上的远程仓库都不受影响。</p>
                <button type="button" class="menu_button danger" data-action="destroy"><i class="fa-solid fa-trash"></i> 删除仓库</button>
            </section>`;
        const scope = renderScopeForm(body.querySelector('[data-scope]'), app.state, settings.rules);
        const field = name => body.querySelector(`[data-field="${name}"]`);
        body.querySelector('[data-action="save"]').addEventListener('click', async () => {
            try {
                await gitApi('/settings', { rules: scope.read(), author: { name: field('authorName').value, email: field('authorEmail').value } });
                toastr.success('设置已保存');
                await app.refresh('settings');
            } catch (error) {
                showError(error, '保存失败');
            }
        });
        body.querySelector('[data-action="save-auto"]')?.addEventListener('click', async () => {
            try {
                await gitApi('/auto-backup/save', { enabled: field('autoEnabled').checked, intervalHours: Number(field('autoHours').value), push: field('autoPush').checked, remote: field('autoRemote').value });
                toastr.success('自动备份设置已保存');
                await app.refresh('settings');
            } catch (error) {
                showError(error, '保存失败');
            }
        });
        body.querySelector('[data-action="run-auto"]')?.addEventListener('click', async () => {
            try {
                const result = await app.busy('正在备份…', () => gitApi('/auto-backup/run'));
                if (result.error) showError(new Error(result.error), '备份出错');
                else toastr.success(`${result.committed ? `已提交：${esc(result.committed.summary)}` : '没有新改动'}${result.pushed ? '，已推送' : ''}`, '', { escapeHtml: false });
                await app.refresh('settings');
            } catch (error) {
                showError(error, '备份失败');
            }
        });
        body.querySelector('[data-action="destroy"]').addEventListener('click', async () => {
            if (!await confirmAction('确定删除酒馆 Git 仓库吗？这会删除所有本地历史、分支和安全存档。', { okButton: '继续', danger: true })) return;
            const typed = await promptText('请输入你的用户名以确认删除');
            if (!typed) return;
            try {
                await gitApi('/destroy', { confirm: typed });
                toastr.success('仓库已删除');
                await app.refresh('overview');
            } catch (error) {
                showError(error, '删除失败');
            }
        });
    },
};

import { confirmAction, esc, gitApi, promptText, showError } from '../shared.js';
import { renderScopeForm } from './scope-form.js';
import { reloadSmartCommit } from '../smart-commit.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'settings',
    label: '设置',
    icon: 'fa-gear',
    module: 'core',
    async render(body, app) {
        const { settings, defaultAuthor, modules } = app.state;
        const auto = settings.autoBackup;
        const smart = settings.smartCommit ?? { onChatSwitch: false, everyMessages: 0, push: false, remote: 'origin', aiMessages: false };
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
            <section class="git-sync-panel-card">
                <h3><i class="fa-solid fa-wand-magic-sparkles"></i> 智能自动存档</h3>
                <div class="git-sync-hint">玩的时候自动提交，不用记得点。AI 正在回复时会等它说完再存；没有改动就不提交。</div>
                <div class="git-sync-form">
                    <label class="checkbox_label"><input type="checkbox" id="git_sync_smart_switch" data-field="smartSwitch"${smart.onChatSwitch ? ' checked' : ''}> 离开一个聊天（切换聊天或角色）时自动存档</label>
                    <label>每多少条新消息自动存档一次（0 为关闭）
                        <input class="text_pole" type="number" min="0" max="500" id="git_sync_smart_every" data-field="smartEvery" value="${esc(smart.everyMessages)}">
                    </label>
                    <label class="checkbox_label"><input type="checkbox" id="git_sync_smart_push" data-field="smartPush"${smart.push ? ' checked' : ''}${remotes.length ? '' : ' disabled'}> 自动存档后推送到远程</label>
                    <label>推送到 <select class="text_pole" id="git_sync_smart_remote" data-field="smartRemote">${remotes.map(name => `<option${name === smart.remote ? ' selected' : ''}>${esc(name)}</option>`).join('') || '<option value="origin">（先添加远程仓库）</option>'}</select></label>
                    <label class="checkbox_label"><input type="checkbox" id="git_sync_ai_messages" data-field="aiMessages"${smart.aiMessages ? ' checked' : ''}> 用 AI 写提交说明（手动和自动提交都用，使用你当前连接的模型，会消耗少量 token）</label>
                </div>
                <div class="git-sync-actions"><button type="button" class="menu_button" data-action="save-smart"><i class="fa-solid fa-floppy-disk"></i> 保存智能存档设置</button></div>
            </section>
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
        body.querySelector('[data-action="save-smart"]').addEventListener('click', async () => {
            try {
                await gitApi('/settings', {
                    smartCommit: {
                        onChatSwitch: field('smartSwitch').checked,
                        everyMessages: Number(field('smartEvery').value) || 0,
                        push: field('smartPush').checked,
                        remote: field('smartRemote').value,
                        aiMessages: field('aiMessages').checked,
                    },
                });
                await reloadSmartCommit();
                toastr.success('智能存档设置已保存');
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

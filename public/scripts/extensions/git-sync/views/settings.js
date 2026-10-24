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
        const smart = settings.smartCommit ?? { onChatSwitch: false, everyMessages: 0, push: false, remote: 'origin', aiMessages: true };
        const remotes = Object.keys(settings.remotes);
        const cloudOn = Boolean(app.state.hosted) && settings.remotes.cloud?.provider === 'hosted';
        const otherRemotes = remotes.filter(name => settings.remotes[name]?.provider !== 'hosted');
        const every = Number(smart.everyMessages) || 0;
        const presets = [[5, '每 5 条消息（推荐）'], [2, '每次 AI 回复后'], [10, '每 10 条消息'], [20, '每 20 条消息'], [0, '不自动存（只在离开聊天时，或者自己点）']];
        body.innerHTML = `
            <section class="git-sync-panel-card">
                <h3><i class="fa-solid fa-wand-magic-sparkles"></i> 自动存档</h3>
                <div class="git-sync-hint">玩的时候自动存，不用记得点。AI 正在回复时会等它说完；没有改动就不存。</div>
                <div class="git-sync-form">
                    <label>多久存一次
                        <select class="text_pole" id="git_sync_smart_every" data-field="smartEvery">
                            ${presets.map(([value, label]) => `<option value="${value}"${value === every ? ' selected' : ''}>${label}</option>`).join('')}
                            ${presets.some(([value]) => value === every) ? '' : `<option value="${every}" selected>每 ${every} 条消息</option>`}
                        </select>
                    </label>
                    <label class="checkbox_label"><input type="checkbox" id="git_sync_smart_switch" data-field="smartSwitch"${smart.onChatSwitch ? ' checked' : ''}> 离开一个聊天时，把所有改动存一次</label>
                    <label class="checkbox_label"><input type="checkbox" id="git_sync_ai_messages" data-field="aiMessages"${smart.aiMessages ? ' checked' : ''}> 用 AI 写存档说明</label>
                    <div class="git-sync-hint"><i class="fa-solid fa-circle-info"></i> 用你当前连接的模型写一句话，比如“和艾琳在雨夜分别”，每次花一点点 token。每几条消息的小存档不会用 AI。</div>
                </div>
                <details class="git-sync-advanced">
                    <summary>高级</summary>
                    <div class="git-sync-form">
                        <label class="checkbox_label"><input type="checkbox" data-field="beforeReroll"${smart.beforeReroll !== false ? ' checked' : ''}> 重新生成（重 roll）、继续生成之前，先存一份当前聊天</label>
                        <label class="checkbox_label"><input type="checkbox" data-field="beforeDelete"${smart.beforeDelete !== false ? ' checked' : ''}> 删除消息、聊天、角色卡、世界书、预设之前，先存一份</label>
                        <div class="git-sync-hint">这两项只存当前聊天或只在删除时存，很轻，建议保持打开。</div>
                        ${otherRemotes.length ? `
                        <label class="checkbox_label"><input type="checkbox" id="git_sync_smart_push" data-field="smartPush"${smart.push && smart.remote !== 'cloud' ? ' checked' : ''}> 自动存档后推送到我自己的仓库</label>
                        <label>推送到 <select class="text_pole" id="git_sync_smart_remote" data-field="smartRemote">${otherRemotes.map(name => `<option${name === smart.remote ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : ''}
                    </div>
                </details>
                <div class="git-sync-actions"><button type="button" class="menu_button" data-action="save-smart"><i class="fa-solid fa-floppy-disk"></i> 保存</button></div>
            </section>
            <section class="git-sync-panel-card">
                <h3><i class="fa-solid fa-cloud"></i> 备份放在哪</h3>
                ${cloudOn ? `<div><b>${esc(app.state.hosted.label)}</b>：每次存档后服务器自动传上去（小存档最多攒 5 分钟）。</div>` : ''}
                ${otherRemotes.length ? `<div>你自己的仓库：${otherRemotes.map(name => `<code>${esc(name)}</code>`).join('、')}</div>` : ''}
                ${!cloudOn && !otherRemotes.length ? '<div>只在这个酒馆里。<a href="#" data-action="go-remotes">去连一个网上的备份</a></div>' : ''}
            </section>
            <details class="git-sync-panel-card git-sync-more">
                <summary><h3><i class="fa-solid fa-sliders"></i> 更多设置</h3></summary>
                <section>
                    <h4><i class="fa-solid fa-filter"></i> 存哪些</h4>
                    <div data-scope></div>
                    <div class="git-sync-hint">取消勾选的类别，下次存档时会从备份里拿掉（不会删除你酒馆里的数据）。</div>
                </section>
                <section>
                    <h4><i class="fa-solid fa-signature"></i> 存档署名</h4>
                    <div class="git-sync-form">
                        <label>名字 <input class="text_pole" data-field="authorName" value="${esc(settings.author.name)}" placeholder="${esc(defaultAuthor.name)}"></label>
                        <label>邮箱 <input class="text_pole" data-field="authorEmail" value="${esc(settings.author.email)}" placeholder="${esc(defaultAuthor.email)}"></label>
                    </div>
                </section>
                <div class="git-sync-actions"><button type="button" class="menu_button" data-action="save"><i class="fa-solid fa-floppy-disk"></i> 保存这两项</button></div>
                ${modules.includes('autoBackup') ? `
                <section>
                    <h4><i class="fa-solid fa-robot"></i> 定时备份</h4>
                    <div class="git-sync-hint">不开酒馆的时候也按时存一次（比如每天），由服务器来做。</div>
                    <div class="git-sync-form">
                        <label class="checkbox_label"><input type="checkbox" data-field="autoEnabled"${auto.enabled ? ' checked' : ''}> 定时自动存档</label>
                        <label>间隔（小时） <input class="text_pole" type="number" min="1" max="720" data-field="autoHours" value="${esc(auto.intervalHours)}"></label>
                        <label class="checkbox_label"><input type="checkbox" data-field="autoPush"${auto.push ? ' checked' : ''}${otherRemotes.length ? '' : ' disabled'}> 存完推送到我自己的仓库</label>
                        <label>仓库 <select class="text_pole" data-field="autoRemote">${otherRemotes.map(name => `<option${name === auto.remote ? ' selected' : ''}>${esc(name)}</option>`).join('') || '<option value="">（没有自己的仓库）</option>'}</select></label>
                    </div>
                    ${auto.lastError ? `<div class="git-sync-warning">上次定时备份出错：${esc(auto.lastError)}</div>` : ''}
                    <div class="git-sync-actions">
                        <button type="button" class="menu_button" data-action="save-auto"><i class="fa-solid fa-floppy-disk"></i> 保存定时备份</button>
                        <button type="button" class="menu_button" data-action="run-auto"><i class="fa-solid fa-play"></i> 现在存一次</button>
                    </div>
                </section>` : ''}
                <section class="danger-zone">
                    <h4><i class="fa-solid fa-triangle-exclamation"></i> 危险操作</h4>
                    <p>删除这个账号的酒馆 Git（全部历史、分支、存档点、安全存档和远程设置）。你酒馆里的数据不受影响${cloudOn ? `，${esc(app.state.hosted.label)}里的备份也还在` : ''}。</p>
                    <button type="button" class="menu_button danger" data-action="destroy"><i class="fa-solid fa-trash"></i> 删除仓库</button>
                </section>
            </details>`;
        const scope = renderScopeForm(body.querySelector('[data-scope]'), app.state, settings.rules);
        const field = name => body.querySelector(`[data-field="${name}"]`);
        body.querySelector('[data-action="go-remotes"]')?.addEventListener('click', event => {
            event.preventDefault();
            app.go('remotes');
        });
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
                        push: Boolean(field('smartPush')?.checked),
                        remote: field('smartRemote')?.value || (cloudOn ? 'cloud' : smart.remote),
                        aiMessages: field('aiMessages').checked,
                        beforeReroll: field('beforeReroll').checked,
                        beforeDelete: field('beforeDelete').checked,
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

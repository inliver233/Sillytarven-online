import { CATEGORY_ICONS, esc, flushPendingSaves, formatSize, gitApi, showError, timeAgo } from '../shared.js';
import { runMergeFlow } from './merge.js';
import { isGenerating, writeCommitMessage } from '../ai-commit.js';
import { renderQuickStart } from './quick-start.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'overview',
    label: '概览',
    icon: 'fa-house',
    module: 'core',
    async render(body, app) {
        await flushPendingSaves();
        const [status, size, log] = await Promise.all([
            gitApi('/status'),
            gitApi('/size').catch(() => null),
            app.state.modules.includes('history') ? gitApi('/log', { limit: 1 }).catch(() => null) : null,
        ]);
        const state = app.state;
        const remotes = Object.entries(state.settings.remotes);
        const last = log?.commits?.[0];
        const counts = {};
        for (const change of status.changes) counts[change.category] = (counts[change.category] ?? 0) + 1;
        const auto = state.settings.autoBackup;
        body.innerHTML = `
            <div class="git-sync-grid">
                <section class="git-sync-panel-card">
                    <h3><i class="fa-solid fa-pen-to-square"></i> 未提交的改动</h3>
                    ${status.changes.length ? `
                        <div class="git-sync-big">${status.changes.length}<small> 个文件</small></div>
                        <div class="git-sync-chips">${Object.entries(counts).map(([category, count]) => {
        const label = state.categories.find(entry => entry.id === category)?.label ?? category;
        return `<span class="git-sync-chip"><i class="fa-solid ${CATEGORY_ICONS[category] ?? 'fa-file'}"></i>${esc(label)} ${count}</span>`;
    }).join('')}</div>
                        <div class="git-sync-actions">
                            <button type="button" class="menu_button" data-action="commit"><i class="fa-solid fa-floppy-disk"></i> 全部提交</button>
                            ${remotes.length && state.modules.includes('remotes') ? '<button type="button" class="menu_button" data-action="commit-push"><i class="fa-solid fa-cloud-arrow-up"></i> 提交并推送</button>' : ''}
                            <button type="button" class="menu_button" data-action="review"><i class="fa-solid fa-list-check"></i> 逐项查看</button>
                        </div>`
        : '<div class="git-sync-big ok"><i class="fa-solid fa-circle-check"></i><small> 所有改动都已提交</small></div>'}
                    ${status.skipped.length ? `<div class="git-sync-warning"><i class="fa-solid fa-triangle-exclamation"></i> ${status.skipped.length} 个文件超过大小限制，不会同步</div>` : ''}
                </section>
                <section class="git-sync-panel-card">
                    <h3><i class="fa-solid fa-clock-rotate-left"></i> 最近一次提交</h3>
                    ${last ? `<div class="git-sync-commit-title">${esc(last.title)}</div><div class="git-sync-muted">${esc(last.author)} · ${timeAgo(last.timestamp)} · <code>${esc(last.oid.slice(0, 7))}</code></div>` : '<div class="git-sync-muted">还没有提交</div>'}
                    <div class="git-sync-muted">仓库大小 ${size ? formatSize(size.bytes) : '—'}${size ? ` · 跟踪 ${size.trackedFiles} 个文件` : ''}</div>
                </section>
                ${state.modules.includes('remotes') ? `
                <section class="git-sync-panel-card">
                    <h3><i class="fa-solid fa-cloud"></i> 远程仓库</h3>
                    ${remotes.length ? remotes.map(([name, remote]) => `
                        <div class="git-sync-remote-line">
                            <b>${esc(name)}</b> <span class="git-sync-muted">${esc(remote.provider === 'hosted' ? (state.hosted?.label ?? '酒馆云') : (state.providers[remote.provider]?.label ?? remote.provider))}</span>
                            ${remote.provider === 'hosted' ? '<div class="git-sync-muted">每次存档自动同步</div>' : `<div class="git-sync-path">${esc(remote.url)}</div>`}
                            <div class="git-sync-actions">
                                <button type="button" class="menu_button git-sync-small" data-pull="${esc(name)}"><i class="fa-solid fa-cloud-arrow-down"></i> 拉取</button>
                                <button type="button" class="menu_button git-sync-small" data-push="${esc(name)}"><i class="fa-solid fa-cloud-arrow-up"></i> 推送</button>
                            </div>
                        </div>`).join('') : '<div class="git-sync-muted">还没有连接远程仓库。</div><div class="git-sync-actions"><button type="button" class="menu_button" data-action="quick-online"><i class="fa-solid fa-hand-holding-heart"></i> 存到网上（跟着点）</button><button type="button" class="menu_button" data-action="add-remote"><i class="fa-solid fa-plus"></i> 自己填写…</button></div>'}
                </section>` : ''}
                ${state.modules.includes('autoBackup') ? `
                <section class="git-sync-panel-card">
                    <h3><i class="fa-solid fa-robot"></i> 自动备份</h3>
                    ${auto.enabled ? `<div>每 ${auto.intervalHours} 小时自动提交${auto.push ? `并推送到 ${esc(auto.remote)}` : ''}</div>
                        <div class="git-sync-muted">上次运行：${auto.lastRunAt ? timeAgo(auto.lastRunAt / 1000) : '还没有运行'}</div>
                        ${auto.lastError ? `<div class="git-sync-warning">${esc(auto.lastError)}</div>` : ''}`
        : '<div class="git-sync-muted">未开启</div>'}
                    <div class="git-sync-actions"><button type="button" class="menu_button git-sync-small" data-action="auto-settings"><i class="fa-solid fa-gear"></i> 设置</button></div>
                </section>` : ''}
            </div>`;

        const commit = async (push) => {
            try {
                let message = '';
                if (state.settings.smartCommit?.aiMessages && !isGenerating()) {
                    message = await app.busy('AI 正在写说明…', () => writeCommitMessage()).catch(() => '');
                }
                await app.busy('正在提交…', () => gitApi('/commit', { message, split: true }));
                if (push) {
                    const [name] = remotes[0];
                    await app.busy('正在推送…', () => gitApi('/push', { remote: name }));
                    toastr.success('已提交并推送');
                } else {
                    toastr.success('已提交');
                }
                await app.refresh();
            } catch (error) {
                showError(error);
                await app.refresh();
            }
        };
        body.querySelector('[data-action="commit"]')?.addEventListener('click', () => commit(false));
        body.querySelector('[data-action="commit-push"]')?.addEventListener('click', () => commit(true));
        body.querySelector('[data-action="review"]')?.addEventListener('click', () => app.go('changes'));
        body.querySelector('[data-action="quick-online"]')?.addEventListener('click', () => {
            renderQuickStart(body, app, { onlineOnly: true, onExit: () => app.refresh('overview') });
        });
        body.querySelector('[data-action="add-remote"]')?.addEventListener('click', () => app.go('remotes', { add: true }));
        body.querySelector('[data-action="auto-settings"]')?.addEventListener('click', () => app.go('settings'));
        body.querySelectorAll('[data-pull]').forEach(button => button.addEventListener('click', () => runMergeFlow(app, {
            route: '/pull', body: { remote: button.dataset.pull }, label: '拉取', theirsLabel: `远程 ${button.dataset.pull}`,
        })));
        body.querySelectorAll('[data-push]').forEach(button => button.addEventListener('click', async () => {
            try {
                await app.busy('正在推送…', () => gitApi('/push', { remote: button.dataset.push }));
                toastr.success('推送完成');
            } catch (error) {
                showError(error, '推送失败');
            }
        }));
    },
};

import { confirmAction, esc, finishWorkTreeChange, flushPendingSaves, gitApi, showError } from '../shared.js';
import { renderRemoteForm } from './remote-form.js';
import { renderScopeForm } from './scope-form.js';
import { renderQuickStart } from './quick-start.js';

/**
 * First run: start a new repository here, or bring one in from a remote ("clone").
 * @param {HTMLElement} body
 * @param {import('../index.js').PanelApp} app
 */
export function renderSetupWizard(body, app) {
    body.innerHTML = `
        <div class="git-sync-setup">
            <h2>欢迎使用酒馆 Git</h2>
            <button type="button" class="git-sync-card git-sync-quick-card" data-mode="quick">
                <i class="fa-solid fa-hand-holding-heart"></i><b>快速开始</b><span>跟着点就行</span>
            </button>
            <p>给你的聊天、角色卡、世界书和预设做版本管理：每次提交都是一份可以随时回去的存档，还能同步到 GitHub、GitLab、Gitee、Gitea 等任意 Git 仓库，在多个酒馆之间搬家或备份。</p>
            <div class="git-sync-warning"><i class="fa-solid fa-flask"></i> <b>测试版</b>：功能还在测试中，请<b>不要把它当作唯一的备份</b>，重要数据请继续用“备份与导出”另存一份。遇到问题欢迎反馈。</div>
            <div class="git-sync-choice-label">自己设置：</div>
            <div class="git-sync-choice">
                <button type="button" class="git-sync-card" data-mode="new">
                    <i class="fa-solid fa-seedling"></i><b>从这里开始</b><span>用当前酒馆的数据新建仓库</span>
                </button>
                <button type="button" class="git-sync-card" data-mode="clone">
                    <i class="fa-solid fa-cloud-arrow-down"></i><b>从远程仓库导入</b><span>把已有的 Git 备份恢复到这个账号</span>
                </button>
            </div>
            <div class="git-sync-setup-step"></div>
        </div>`;
    const step = body.querySelector('.git-sync-setup-step');
    body.querySelector('[data-mode="quick"]').addEventListener('click', () => {
        renderQuickStart(body, app, { onExit: () => renderSetupWizard(body, app) });
    });
    body.querySelectorAll('.git-sync-choice .git-sync-card').forEach(card => card.addEventListener('click', () => {
        body.querySelectorAll('.git-sync-choice .git-sync-card').forEach(other => other.classList.toggle('selected', other === card));
        if (card.dataset.mode === 'new') renderNew(step, app);
        else renderClone(step, app);
    }));
}

function renderNew(step, app) {
    step.innerHTML = `
        <h3>要同步哪些内容？</h3>
        <div data-scope></div>
        <label class="git-sync-inline">主分支名称 <input class="text_pole" data-field="branch" value="main" maxlength="100"></label>
        <label class="checkbox_label"><input type="checkbox" data-field="commit" checked> 创建后立即提交一次，作为第一份存档</label>
        <div class="git-sync-actions"><button type="button" class="menu_button" data-action="create"><i class="fa-solid fa-check"></i> 创建仓库</button></div>`;
    const scope = renderScopeForm(step.querySelector('[data-scope]'), app.state, app.state.settings.rules);
    step.querySelector('[data-action="create"]').addEventListener('click', async () => {
        try {
            await app.busy('正在创建仓库…', async () => {
                await gitApi('/init', { branch: step.querySelector('[data-field="branch"]').value.trim() || 'main', rules: scope.read() });
                if (step.querySelector('[data-field="commit"]').checked) {
                    await flushPendingSaves();
                    await gitApi('/commit', { message: '第一份存档' }).catch(error => {
                        if (error.status !== 409) throw error;
                    });
                }
            });
            toastr.success('酒馆 Git 仓库已创建');
            await app.refresh('overview');
        } catch (error) {
            showError(error);
        }
    });
}

function renderClone(step, app) {
    step.innerHTML = `
        <h3>远程仓库</h3>
        <div data-remote></div>
        <div class="git-sync-actions"><button type="button" class="menu_button" data-action="test"><i class="fa-solid fa-plug"></i> 连接并读取分支</button></div>
        <div data-branches></div>`;
    const form = renderRemoteForm(step.querySelector('[data-remote]'), app.state);
    step.querySelector('[data-action="test"]').addEventListener('click', async () => {
        const remote = form.read();
        try {
            const info = await app.busy('正在连接远程仓库…', async () => {
                await gitApi('/remote/save', remote);
                return gitApi('/remote/test', { name: remote.name });
            });
            const target = step.querySelector('[data-branches]');
            if (!info.branches.length) {
                target.innerHTML = '<div class="git-sync-hint">这个仓库还是空的。可以先选“从这里开始”，再在“远程”里推送上去。</div>';
                return;
            }
            target.innerHTML = `
                <h3>选择要导入的分支</h3>
                <select class="text_pole" data-field="branch">${info.branches.map(branch => `<option${branch.name === info.defaultBranch ? ' selected' : ''}>${esc(branch.name)}</option>`).join('')}</select>
                <div class="git-sync-warning"><i class="fa-solid fa-triangle-exclamation"></i> 导入会用远程仓库的内容<b>替换</b>这个账号里同类的数据（聊天、角色卡等）。替换前会自动保存一份<b>安全存档</b>，导入后不满意可以在“安全存档”里恢复。</div>
                <div class="git-sync-actions"><button type="button" class="menu_button" data-action="import"><i class="fa-solid fa-cloud-arrow-down"></i> 导入</button></div>`;
            target.querySelector('[data-action="import"]').addEventListener('click', async () => {
                const branch = target.querySelector('[data-field="branch"]').value;
                if (!await confirmAction(`确定从 <b>${esc(remote.name)}/${esc(branch)}</b> 导入并替换当前数据吗？`, { okButton: '导入', danger: true })) return;
                try {
                    await flushPendingSaves();
                    const result = await app.busy('正在下载并导入，数据多时需要一些时间…', () => gitApi('/import', { remote: remote.name, branch }));
                    finishWorkTreeChange(result, '导入完成');
                } catch (error) {
                    showError(error, '导入失败');
                }
            });
        } catch (error) {
            showError(error, '连接失败');
        }
    });
}

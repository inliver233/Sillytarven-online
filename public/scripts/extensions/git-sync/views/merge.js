import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { CATEGORY_ICONS, esc, finishWorkTreeChange, flushPendingSaves, gitApi, showError } from '../shared.js';
import { renderFileComparison } from './diff.js';

const SIDE_LABEL = { added: '新增', modified: '修改', deleted: '删除' };

/**
 * Runs a merge-like operation in two steps: fetch the plan, ask about conflicts, then apply.
 * @param {import('../index.js').PanelApp} app
 * @param {{ route: string, body: object, label: string, oursLabel?: string, theirsLabel: string }} options
 *   route '/merge' or '/pull'; body is sent with both requests
 */
export async function runMergeFlow(app, { route, body, label, oursLabel = '本地（当前分支）', theirsLabel }) {
    try {
        await flushPendingSaves();
        const plan = await app.busy(`正在分析${label}…`, () => gitApi(route, body));
        if (plan.type === 'up-to-date') {
            toastr.info(`已经是最新的，不需要${label}`);
            return false;
        }
        let choices = {};
        if (plan.type === 'merge' && plan.conflicts.length) {
            choices = await askConflicts(plan, oursLabel, theirsLabel);
            if (!choices) return false;
        } else {
            const what = plan.type === 'fast-forward' ? `将直接更新到 <b>${esc(theirsLabel)}</b> 的最新版本` : `${esc(theirsLabel)} 有 ${plan.theirsChanges} 个文件改动，没有冲突，可以自动合并`;
            const ok = await callGenericPopup(`<div>${what}。<br>当前数据会先保存为安全存档，然后被替换为合并结果，完成后酒馆会重新加载。</div>`, POPUP_TYPE.CONFIRM, '', { okButton: label, cancelButton: '取消' });
            if (ok !== POPUP_RESULT.AFFIRMATIVE) return false;
        }
        const result = await app.busy(`正在${label}…`, () => gitApi(route, { ...body, apply: true, choices }));
        finishWorkTreeChange(result, `${label}完成`);
        if (!result.reload) await app.refresh();
        return true;
    } catch (error) {
        showError(error, `${label}失败`);
        return false;
    }
}

/**
 * Asks which side to keep for each conflicting file.
 * @returns {Promise<Record<string, 'ours'|'theirs'>|null>}
 */
async function askConflicts(plan, oursLabel, theirsLabel) {
    const container = document.createElement('div');
    container.className = 'git-sync-conflicts';
    container.innerHTML = `
        <h3><i class="fa-solid fa-code-merge"></i> ${plan.conflicts.length} 个文件两边都改过</h3>
        <p>酒馆 Git 不会把两边的内容混在一起（那样会弄坏聊天和角色卡）。请为每个文件选择保留哪一边：</p>
        <div class="git-sync-bulk">
            <button type="button" class="menu_button" data-all="ours">全部保留${esc(oursLabel)}</button>
            <button type="button" class="menu_button" data-all="theirs">全部保留${esc(theirsLabel)}</button>
        </div>
        <div class="git-sync-conflict-list">
            ${plan.conflicts.map((conflict, index) => `
                <div class="git-sync-conflict" data-index="${index}">
                    <div class="git-sync-conflict-title"><i class="fa-solid ${CATEGORY_ICONS[conflict.category] ?? 'fa-file'}"></i> ${esc(conflict.categoryLabel)} · <b>${esc(conflict.item)}</b><div class="git-sync-path">${esc(conflict.path)}</div></div>
                    <label><input type="radio" name="git-sync-conflict-${index}" value="ours"> ${esc(oursLabel)}（${SIDE_LABEL[conflict.ours]}）</label>
                    <label><input type="radio" name="git-sync-conflict-${index}" value="theirs"> ${esc(theirsLabel)}（${SIDE_LABEL[conflict.theirs]}）</label>
                    <button type="button" class="menu_button git-sync-small" data-compare="${index}"><i class="fa-solid fa-code-compare"></i> 比较两边</button>
                    <div class="git-sync-conflict-compare"></div>
                </div>`).join('')}
        </div>`;
    container.querySelectorAll('[data-all]').forEach(button => button.addEventListener('click', () => {
        container.querySelectorAll(`input[value="${button.dataset.all}"]`).forEach(input => { input.checked = true; });
    }));
    container.querySelectorAll('[data-compare]').forEach(button => button.addEventListener('click', async () => {
        const conflict = plan.conflicts[Number(button.dataset.compare)];
        const target = button.nextElementSibling;
        try {
            const [ours, theirs] = await Promise.all([
                gitApi('/file', { path: conflict.path, oid: plan.ours }),
                gitApi('/file', { path: conflict.path, oid: plan.theirs }),
            ]);
            target.innerHTML = `<div class="git-sync-hint">“－”为${esc(oursLabel)}，“＋”为${esc(theirsLabel)}</div>${renderFileComparison(conflict.path, ours.after, theirs.after)}`;
        } catch (error) {
            showError(error, '读取失败');
        }
    }));

    while (true) {
        const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '按选择合并', cancelButton: '取消', wide: true, large: true, allowVerticalScrolling: true });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
        const choices = {};
        let missing = 0;
        plan.conflicts.forEach((conflict, index) => {
            const picked = container.querySelector(`input[name="git-sync-conflict-${index}"]:checked`);
            if (picked) choices[conflict.path] = picked.value;
            else missing++;
        });
        if (!missing) return choices;
        toastr.warning(`还有 ${missing} 个文件没有选择`);
    }
}

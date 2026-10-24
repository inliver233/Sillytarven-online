import { CATEGORY_ICONS, KIND_LABELS, esc, flushPendingSaves, formatSize, gitApi, showError } from '../shared.js';
import { showFileDiff } from './diff.js';

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'changes',
    label: '改动',
    icon: 'fa-pen-to-square',
    module: 'core',
    async render(body, app) {
        await flushPendingSaves();
        const status = await gitApi('/status');
        if (!status.changes.length && !status.skipped.length) {
            body.innerHTML = '<div class="git-sync-empty"><i class="fa-solid fa-circle-check"></i><p>所有改动都已提交。</p></div>';
            return;
        }
        // One row per tavern item: a chunked chat is several files (header, chunks, index, metadata)
        // that must be committed together.
        /** @type {Map<string, { category: string, categoryLabel: string, item: string, kind: string, size: number, changes: any[] }>} */
        const items = new Map();
        for (const change of status.changes) {
            const key = `${change.category}|${change.item}`;
            const entry = items.get(key) ?? { category: change.category, categoryLabel: change.categoryLabel, item: change.item, kind: change.kind, size: 0, changes: [] };
            entry.changes.push(change);
            entry.size += change.size ?? 0;
            if (entry.kind !== change.kind) entry.kind = 'modified';
            items.set(key, entry);
        }
        /** @type {Map<string, any[]>} */
        const groups = new Map();
        for (const entry of items.values()) {
            if (!groups.has(entry.category)) groups.set(entry.category, []);
            groups.get(entry.category).push(entry);
        }
        const rows = [...items.values()];
        /** The file whose diff says the most: a chat's message chunk, else the first file. */
        const primary = entry => entry.changes.find(change => /\.chunks\/\d+\.jsonl$/.test(change.path)) ?? entry.changes.find(change => change.kind !== 'untracked') ?? entry.changes[0];
        body.innerHTML = `
            <div class="git-sync-commit-box">
                <textarea class="text_pole" rows="2" data-field="message" placeholder="提交说明（可不填，会自动写成“更新聊天：… 新增角色卡：…”）"></textarea>
                <div class="git-sync-actions">
                    <label class="checkbox_label"><input type="checkbox" data-field="all" checked> 全选</label>
                    <button type="button" class="menu_button" data-action="commit"><i class="fa-solid fa-floppy-disk"></i> 提交选中的 <span data-count>${rows.length}</span> 项</button>
                </div>
            </div>
            ${[...groups].map(([category, entries]) => `
                <section class="git-sync-group">
                    <h4><label class="checkbox_label"><input type="checkbox" data-group="${esc(category)}" checked><i class="fa-solid ${CATEGORY_ICONS[category] ?? 'fa-file'}"></i> ${esc(entries[0].categoryLabel)} <span class="git-sync-muted">${entries.length}</span></label></h4>
                    ${entries.map(entry => {
        const index = rows.indexOf(entry);
        return `
                        <div class="git-sync-change ${entry.kind}">
                            <input type="checkbox" data-row="${index}" data-category="${esc(category)}" checked>
                            <span class="git-sync-kind ${entry.kind}">${KIND_LABELS[entry.kind]}</span>
                            <span class="git-sync-change-name" title="${esc(entry.changes.map(change => change.path).join('\n'))}">${esc(entry.item)}</span>
                            ${entry.size ? `<span class="git-sync-muted">${formatSize(entry.size)}</span>` : ''}
                            ${entry.kind !== 'untracked' ? `<button type="button" class="menu_button git-sync-small" data-diff="${index}" title="查看差异"><i class="fa-solid fa-code-compare"></i></button>` : ''}
                        </div>`;
    }).join('')}
                </section>`).join('')}
            ${status.skipped.length ? `
                <section class="git-sync-group skipped">
                    <h4><i class="fa-solid fa-triangle-exclamation"></i> 超过大小限制，不会同步</h4>
                    ${status.skipped.map(change => `<div class="git-sync-change"><span class="git-sync-change-name" title="${esc(change.path)}">${esc(change.categoryLabel)} · ${esc(change.item)}</span><span class="git-sync-muted">${formatSize(change.size)}</span></div>`).join('')}
                    <div class="git-sync-hint">可以在“设置 → 高级”里调整大小限制，GitHub 不接受超过 100MB 的文件。</div>
                </section>` : ''}`;

        const boxes = () => [...body.querySelectorAll('[data-row]')];
        const updateCount = () => {
            body.querySelector('[data-count]').textContent = String(boxes().filter(box => box.checked).length);
        };
        body.querySelector('[data-field="all"]').addEventListener('change', event => {
            boxes().forEach(box => { box.checked = event.target.checked; });
            body.querySelectorAll('[data-group]').forEach(box => { box.checked = event.target.checked; });
            updateCount();
        });
        body.querySelectorAll('[data-group]').forEach(group => group.addEventListener('change', () => {
            boxes().filter(box => box.dataset.category === group.dataset.group).forEach(box => { box.checked = group.checked; });
            updateCount();
        }));
        boxes().forEach(box => box.addEventListener('change', updateCount));
        body.querySelectorAll('[data-diff]').forEach(button => button.addEventListener('click', () => {
            void showFileDiff(primary(rows[Number(button.dataset.diff)]), { against: 'workdir' });
        }));
        body.querySelector('[data-action="commit"]').addEventListener('click', async () => {
            const paths = boxes().filter(box => box.checked).flatMap(box => rows[Number(box.dataset.row)].changes.map(change => change.path));
            if (!paths.length) {
                toastr.warning('没有选择要提交的改动');
                return;
            }
            try {
                const all = paths.length === status.changes.length;
                const result = await app.busy('正在提交…', () => gitApi('/commit', { message: body.querySelector('[data-field="message"]').value, paths: all ? undefined : paths }));
                toastr.success(esc(result.summary), '已提交', { escapeHtml: false });
                await app.refresh('changes');
            } catch (error) {
                showError(error, '提交失败');
            }
        });
    },
};

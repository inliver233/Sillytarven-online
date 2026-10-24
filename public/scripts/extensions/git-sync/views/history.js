import { confirmAction, esc, finishWorkTreeChange, flushPendingSaves, fullTime, gitApi, promptText, showError, timeAgo } from '../shared.js';
import { showFileDiff } from './diff.js';
import { changeGroupsHtml, wireChangeGroups } from './change-list.js';
import { runMergeFlow } from './merge.js';

const ROW = 48;
const LANE = 16;
const COLORS = ['#e8a33d', '#4aa3df', '#8bc34a', '#e05d8c', '#9c7ce0', '#3fbfad', '#d9734a', '#6f8fd8'];

/**
 * Lays out the commit graph: one lane per line of history, merges joining lanes.
 * @param {Array<{ oid: string, parents: string[] }>} commits Newest first
 */
export function layoutGraph(commits) {
    /** @type {(string|null)[]} */
    let lanes = [];
    const rows = [];
    const free = () => {
        const index = lanes.indexOf(null);
        return index === -1 ? lanes.length : index;
    };
    for (const commit of commits) {
        const before = lanes.slice();
        let lane = lanes.indexOf(commit.oid);
        if (lane === -1) lane = free();
        const merging = [];
        lanes.forEach((value, index) => {
            if (value === commit.oid && index !== lane) merging.push(index);
        });
        merging.forEach(index => { lanes[index] = null; });
        lanes[lane] = commit.parents[0] ?? null;
        for (const parent of commit.parents.slice(1)) {
            if (!lanes.includes(parent)) lanes[free()] = parent;
        }
        while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
        rows.push({ oid: commit.oid, lane, before, after: lanes.slice(), merging, parents: commit.parents });
    }
    const width = Math.max(1, ...rows.map(row => Math.max(row.before.length, row.after.length, row.lane + 1)));
    return { rows, width };
}

function graphSvg(layout) {
    const x = lane => LANE / 2 + lane * LANE;
    const color = lane => COLORS[lane % COLORS.length];
    const parts = [];
    layout.rows.forEach((row, index) => {
        const top = index * ROW;
        const mid = top + ROW / 2;
        const bottom = top + ROW;
        row.before.forEach((value, lane) => {
            if (!value) return;
            if (lane === row.lane && value === row.oid) {
                parts.push(`<path d="M${x(lane)} ${top} L${x(lane)} ${mid}" stroke="${color(lane)}"/>`);
            } else if (row.merging.includes(lane)) {
                parts.push(`<path d="M${x(lane)} ${top} C${x(lane)} ${mid} ${x(row.lane)} ${top} ${x(row.lane)} ${mid}" stroke="${color(lane)}"/>`);
            } else if (row.after[lane] === value) {
                parts.push(`<path d="M${x(lane)} ${top} L${x(lane)} ${bottom}" stroke="${color(lane)}"/>`);
            }
        });
        row.parents.forEach(parent => {
            const lane = row.after.indexOf(parent);
            if (lane === -1) return;
            parts.push(lane === row.lane
                ? `<path d="M${x(lane)} ${mid} L${x(lane)} ${bottom}" stroke="${color(lane)}"/>`
                : `<path d="M${x(row.lane)} ${mid} C${x(row.lane)} ${bottom} ${x(lane)} ${mid} ${x(lane)} ${bottom}" stroke="${color(lane)}"/>`);
        });
        parts.push(`<circle cx="${x(row.lane)}" cy="${mid}" r="${row.parents.length > 1 ? 6 : 5}" fill="${color(row.lane)}"/>`);
    });
    const width = layout.width * LANE;
    return `<svg class="git-sync-graph" width="${width}" height="${layout.rows.length * ROW}" viewBox="0 0 ${width} ${layout.rows.length * ROW}" fill="none" stroke-width="2" aria-hidden="true">${parts.join('')}</svg>`;
}

/** Groups a commit's changed files by tavern item, like the changes tab. */
function groupChanges(changes) {
    const items = new Map();
    for (const change of changes) {
        const key = `${change.category}|${change.item}`;
        const entry = items.get(key) ?? { ...change, changes: [] };
        entry.changes.push(change);
        if (entry.kind !== change.kind) entry.kind = 'modified';
        items.set(key, entry);
    }
    return [...items.values()];
}

const primary = entry => entry.changes.find(change => /\.chunks\/\d+\.jsonl$/.test(change.path)) ?? entry.changes.find(change => change.kind !== 'deleted') ?? entry.changes[0];

/** @type {{ id: string, label: string, icon: string, module: string, render: Function }} */
export default {
    id: 'history',
    label: '历史',
    icon: 'fa-clock-rotate-left',
    module: 'history',
    async render(body, app) {
        const data = await gitApi('/log', { limit: 300 });
        if (!data.commits.length) {
            body.innerHTML = '<div class="git-sync-empty"><i class="fa-regular fa-clock"></i><p>还没有提交。</p></div>';
            return;
        }
        const labels = new Map();
        for (const ref of data.refs) {
            if (!labels.has(ref.oid)) labels.set(ref.oid, []);
            labels.get(ref.oid).push(ref);
        }
        const layout = layoutGraph(data.commits);
        body.innerHTML = `
            <div class="git-sync-history">
                <div class="git-sync-history-list">
                    <div class="git-sync-graph-wrap" style="--git-sync-graph-width:${layout.width * LANE}px">
                        ${graphSvg(layout)}
                        <div class="git-sync-commits">
                            ${data.commits.map(commit => `
                                <button type="button" class="git-sync-commit-row${commit.oid === data.head ? ' head' : ''}" data-oid="${esc(commit.oid)}" style="height:${ROW}px">
                                    <span class="git-sync-commit-title">
                                        ${commit.oid === data.head ? '<span class="git-sync-ref head">当前</span>' : ''}
                                        ${(labels.get(commit.oid) ?? []).map(ref => `<span class="git-sync-ref ${ref.type}"><i class="fa-solid ${ref.type === 'tag' ? 'fa-bookmark' : ref.type === 'remote' ? 'fa-cloud' : 'fa-code-branch'}"></i>${esc(ref.name)}</span>`).join('')}
                                        ${esc(commit.title)}
                                    </span>
                                    <span class="git-sync-muted">${esc(commit.author)} · <span title="${esc(fullTime(commit.timestamp))}">${timeAgo(commit.timestamp)}</span> · <code>${esc(commit.oid.slice(0, 7))}</code></span>
                                </button>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="git-sync-history-detail"><div class="git-sync-muted">点一个提交查看它改了什么。</div></div>
            </div>`;
        const detail = body.querySelector('.git-sync-history-detail');
        body.querySelectorAll('.git-sync-commit-row').forEach(row => row.addEventListener('click', async () => {
            body.querySelectorAll('.git-sync-commit-row').forEach(other => other.classList.toggle('selected', other === row));
            await renderDetail(detail, app, row.dataset.oid, data);
        }));
        const initial = app.params.oid ?? data.head;
        body.querySelector(`.git-sync-commit-row[data-oid="${CSS.escape(initial ?? '')}"]`)?.click();
    },
};

async function renderDetail(detail, app, oid, data) {
    detail.innerHTML = '<div class="git-sync-loading"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    let info;
    try {
        info = await gitApi('/commit/detail', { oid });
    } catch (error) {
        detail.innerHTML = `<div class="git-sync-error-box">${esc(error.message)}</div>`;
        return;
    }
    const [title, ...rest] = info.message.split('\n');
    const entries = groupChanges(info.changes);
    const modules = app.state.modules;
    detail.innerHTML = `
        <h3>${esc(title)}</h3>
        ${rest.join('\n').trim() ? `<div class="git-sync-commit-body${rest.join('\n').trim().length > 120 ? ' clamp' : ''}" title="点一下展开/收起">${esc(rest.join('\n').trim())}</div>` : ''}
        <div class="git-sync-muted">${esc(info.author.name)} · ${esc(fullTime(info.author.timestamp))} · <code>${esc(info.oid.slice(0, 10))}</code>${info.parents.length > 1 ? ' · 合并提交' : ''}</div>
        <div class="git-sync-actions">
            <button type="button" class="menu_button git-sync-small" data-action="reset"><i class="fa-solid fa-backward"></i> 回到这个版本</button>
            ${modules.includes('branches') ? '<button type="button" class="menu_button git-sync-small" data-action="branch"><i class="fa-solid fa-code-branch"></i> 从这里建分支</button>' : ''}
            ${modules.includes('tags') ? '<button type="button" class="menu_button git-sync-small" data-action="tag"><i class="fa-solid fa-bookmark"></i> 设为存档点</button>' : ''}
            ${modules.includes('branches') && oid !== data.head ? '<button type="button" class="menu_button git-sync-small" data-action="merge"><i class="fa-solid fa-code-merge"></i> 合并到当前</button>' : ''}
        </div>
        <h4>改动了 ${entries.length} 项 <small class="git-sync-muted">勾选后可以只恢复这几项</small></h4>
        <div class="git-sync-detail-changes">${changeGroupsHtml(entries)}</div>
        ${entries.length ? '<div class="git-sync-actions"><button type="button" class="menu_button git-sync-small" data-action="restore"><i class="fa-solid fa-rotate-left"></i> 把勾选的恢复成这个版本</button></div>' : ''}`;

    wireChangeGroups(detail);
    detail.querySelector('.git-sync-commit-body.clamp')?.addEventListener('click', event => event.currentTarget.classList.toggle('expanded'));
    detail.querySelectorAll('[data-diff]').forEach(button => button.addEventListener('click', () => {
        void showFileDiff(primary(entries[Number(button.dataset.diff)]), { oid });
    }));
    detail.querySelector('[data-action="restore"]')?.addEventListener('click', async () => {
        const picked = [...detail.querySelectorAll('[data-entry]:checked')].map(box => entries[Number(box.dataset.entry)]);
        if (!picked.length) {
            toastr.warning('先勾选要恢复的项目');
            return;
        }
        const paths = picked.flatMap(entry => entry.changes.filter(change => change.kind !== 'deleted').map(change => change.path));
        if (!await confirmAction(`把 ${picked.length} 项恢复成 <code>${esc(oid.slice(0, 7))}</code> 时的样子？<br>当前数据会先保存为安全存档。`, { okButton: '恢复' })) return;
        try {
            await flushPendingSaves();
            finishWorkTreeChange(await app.busy('正在恢复…', () => gitApi('/restore-files', { oid, paths })), '已恢复');
        } catch (error) {
            showError(error, '恢复失败');
        }
    });
    detail.querySelector('[data-action="reset"]').addEventListener('click', async () => {
        if (!await confirmAction(`把当前分支和所有同步的数据回到 <code>${esc(oid.slice(0, 7))}</code>「${esc(title)}」？<br>之后的提交仍在历史里（或在安全存档里），随时可以再回来。`, { okButton: '回到这个版本', danger: true })) return;
        try {
            await flushPendingSaves();
            finishWorkTreeChange(await app.busy('正在切换版本…', () => gitApi('/reset', { oid })), '已回到这个版本');
        } catch (error) {
            showError(error, '操作失败');
        }
    });
    detail.querySelector('[data-action="branch"]')?.addEventListener('click', async () => {
        const name = await promptText('新分支名称（例如：另一条故事线）');
        if (!name) return;
        const checkout = await confirmAction(`分支 <b>${esc(name)}</b> 创建后，要立即切换过去吗？`, { okButton: '创建并切换' });
        try {
            if (checkout) await flushPendingSaves();
            const result = await app.busy('正在创建分支…', () => gitApi('/branch/create', { name, from: oid, checkout }));
            if (!finishWorkTreeChange(result, `已创建分支 ${name}`)) await app.refresh('history');
        } catch (error) {
            showError(error, '创建分支失败');
        }
    });
    detail.querySelector('[data-action="tag"]')?.addEventListener('click', async () => {
        const name = await promptText('存档点名称（例如：第一章完结）');
        if (!name) return;
        try {
            await gitApi('/tag/create', { name, oid });
            toastr.success(`已创建存档点 ${esc(name)}`, '', { escapeHtml: false });
            await app.refresh('history');
        } catch (error) {
            showError(error, '创建存档点失败');
        }
    });
    detail.querySelector('[data-action="merge"]')?.addEventListener('click', () => runMergeFlow(app, {
        route: '/merge', body: { from: oid }, label: '合并', theirsLabel: `提交 ${oid.slice(0, 7)}`,
    }));
}

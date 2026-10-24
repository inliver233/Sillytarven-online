import { CATEGORY_ICONS, KIND_LABELS, esc } from '../shared.js';

/** Groups with more items than this start folded, so a first save is not a wall of rows. */
const OPEN_LIMIT = 5;

/**
 * Changed items folded by kind of data ("预设 · 新增 85 项 ▸"), each row with a checkbox
 * (`data-entry` = index into `entries`) and a diff button (`data-diff`).
 * @param {{ category: string, categoryLabel: string, item: string, kind: string, changes: any[] }[]} entries
 */
export function changeGroupsHtml(entries) {
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    entries.forEach((entry, index) => {
        if (!groups.has(entry.category)) groups.set(entry.category, []);
        groups.get(entry.category).push(index);
    });
    const open = groups.size === 1 || entries.length <= OPEN_LIMIT * 2;
    return [...groups].map(([category, indexes]) => {
        const kinds = new Map();
        for (const index of indexes) kinds.set(entries[index].kind, (kinds.get(entries[index].kind) ?? 0) + 1);
        const counts = [...kinds].map(([kind, count]) => `${KIND_LABELS[kind]} ${count}`).join(' · ');
        return `
            <details class="git-sync-fold"${open || indexes.length <= OPEN_LIMIT ? ' open' : ''}>
                <summary>
                    <input type="checkbox" data-fold="${esc(category)}" title="全选这一类">
                    <i class="fa-solid ${CATEGORY_ICONS[category] ?? 'fa-file'}"></i>
                    <b>${esc(entries[indexes[0]].categoryLabel)}</b>
                    <span class="git-sync-muted">${esc(counts)}</span>
                    <i class="fa-solid fa-chevron-down git-sync-fold-arrow"></i>
                </summary>
                ${indexes.map(index => {
        const entry = entries[index];
        return `
                <div class="git-sync-change ${entry.kind}">
                    <input type="checkbox" data-entry="${index}" data-category="${esc(category)}">
                    <span class="git-sync-kind ${entry.kind}">${KIND_LABELS[entry.kind]}</span>
                    <span class="git-sync-change-name" title="${esc(entry.changes.map(change => change.path).join('\n'))}">${esc(entry.item)}</span>
                    <button type="button" class="menu_button git-sync-small" data-diff="${index}" title="看看改了什么"><i class="fa-solid fa-code-compare"></i></button>
                </div>`;
    }).join('')}
            </details>`;
    }).join('');
}

/**
 * Makes a group's checkbox tick its rows (clicking it does not fold the group).
 * @param {HTMLElement} root
 */
export function wireChangeGroups(root) {
    root.querySelectorAll('[data-fold]').forEach(box => {
        box.addEventListener('click', event => event.stopPropagation());
        box.addEventListener('change', () => {
            root.querySelectorAll(`[data-entry][data-category="${CSS.escape(box.dataset.fold)}"]`).forEach(row => { row.checked = box.checked; });
        });
    });
}

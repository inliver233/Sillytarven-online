import { CATEGORY_ICONS, esc } from '../shared.js';

/**
 * Checkboxes for what the repository tracks, plus extra ignore rules and the file size limit.
 * @param {HTMLElement} container
 * @param {any} state /state response
 * @param {any} rules Current tracking rules
 * @returns {{ read: () => any }}
 */
export function renderScopeForm(container, state, rules) {
    container.innerHTML = `
        <div class="git-sync-scope">
            ${state.categories.map(category => `
                <label class="git-sync-scope-item">
                    <input type="checkbox" data-category="${esc(category.id)}"${rules.categories[category.id] ? ' checked' : ''}>
                    <i class="fa-solid ${CATEGORY_ICONS[category.id] ?? 'fa-file'}"></i>
                    <span>${esc(category.label)}${category.hint ? `<small>${esc(category.hint)}</small>` : ''}</span>
                </label>`).join('')}
        </div>
        <details class="git-sync-advanced">
            <summary>高级：额外忽略规则与大小限制</summary>
            <label>额外忽略（每行一条，gitignore 写法，例如 <code>chats/某角色/</code> 或 <code>*.webm</code>）
                <textarea class="text_pole" rows="4" data-field="ignore" spellcheck="false">${esc(rules.ignore.join('\n'))}</textarea>
            </label>
            <label>跳过大于此大小的文件（MB）
                <input class="text_pole" type="number" min="1" max="2000" data-field="maxFileSizeMiB" value="${esc(rules.maxFileSizeMiB)}">
                <small>GitHub 不接受超过 100MB 的单个文件。</small>
            </label>
            <div class="git-sync-hint">始终不会同步：${state.hardExcludes.map(item => `<code>${esc(item)}</code>`).join(' ')}（API 密钥、备份、缩略图等）</div>
        </details>`;
    return {
        read: () => ({
            categories: Object.fromEntries([...container.querySelectorAll('[data-category]')].map(input => [input.dataset.category, input.checked])),
            ignore: container.querySelector('[data-field="ignore"]').value.split('\n').map(line => line.trim()).filter(Boolean),
            maxFileSizeMiB: Number(container.querySelector('[data-field="maxFileSizeMiB"]').value) || 95,
        }),
    };
}

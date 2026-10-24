import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { esc, formatSize, gitApi, showError } from '../shared.js';

const MAX_DIFF_LINES = 4000;

/**
 * Line diff (Myers would be faster; an LCS table is fine for the sizes shown here).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{ type: ' '|'+'|'-', line: string }>}
 */
function diffLines(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const result = a.slice(0, start).map(line => ({ type: ' ', line }));
    if (midA.length * midB.length > 4_000_000) {
        midA.forEach(line => result.push({ type: '-', line }));
        midB.forEach(line => result.push({ type: '+', line }));
    } else {
        const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
        for (let i = midA.length - 1; i >= 0; i--) {
            for (let j = midB.length - 1; j >= 0; j--) {
                table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < midA.length && j < midB.length) {
            if (midA[i] === midB[j]) { result.push({ type: ' ', line: midA[i] }); i++; j++; }
            else if (table[i + 1][j] >= table[i][j + 1]) result.push({ type: '-', line: midA[i++] });
            else result.push({ type: '+', line: midB[j++] });
        }
        while (i < midA.length) result.push({ type: '-', line: midA[i++] });
        while (j < midB.length) result.push({ type: '+', line: midB[j++] });
    }
    a.slice(endA).forEach(line => result.push({ type: ' ', line }));
    return result;
}

/** Renders a unified diff, folding long unchanged runs. */
function renderLineDiff(before, after) {
    const a = before.split('\n').slice(0, MAX_DIFF_LINES);
    const b = after.split('\n').slice(0, MAX_DIFF_LINES);
    const rows = diffLines(a, b);
    const out = [];
    let unchanged = [];
    const flush = (isEnd) => {
        if (unchanged.length > 6) {
            const head = out.length ? unchanged.slice(0, 3) : [];
            const tail = isEnd ? [] : unchanged.slice(-3);
            head.forEach(line => out.push(`<div class="git-sync-line"> ${esc(line)}</div>`));
            out.push(`<div class="git-sync-line fold">… ${unchanged.length - head.length - tail.length} 行未改动 …</div>`);
            tail.forEach(line => out.push(`<div class="git-sync-line"> ${esc(line)}</div>`));
        } else {
            unchanged.forEach(line => out.push(`<div class="git-sync-line"> ${esc(line)}</div>`));
        }
        unchanged = [];
    };
    for (const row of rows) {
        if (row.type === ' ') { unchanged.push(row.line); continue; }
        flush(false);
        out.push(`<div class="git-sync-line ${row.type === '+' ? 'add' : 'del'}">${row.type}${esc(row.line)}</div>`);
    }
    flush(true);
    const truncated = before.split('\n').length > MAX_DIFF_LINES || after.split('\n').length > MAX_DIFF_LINES;
    return `<pre class="git-sync-diff">${out.join('')}</pre>${truncated ? '<div class="git-sync-hint">文件较长，只比较了前 4000 行。</div>' : ''}`;
}

/** Chat files (.jsonl): compare message by message and show who said what. */
function renderChatDiff(before, after) {
    const parse = text => text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const a = parse(before);
    const b = parse(after);
    const messages = list => list.filter(entry => typeof entry.mes === 'string');
    const key = entry => JSON.stringify([entry.name, entry.mes, entry.swipe_id ?? 0]);
    const rows = diffLines(messages(a).map(key), messages(b).map(key));
    const items = rows.filter(row => row.type !== ' ').map(row => {
        const [name, mes] = JSON.parse(row.line);
        const text = String(mes).replace(/\s+/g, ' ');
        return `<div class="git-sync-chat-row ${row.type === '+' ? 'add' : 'del'}"><b>${row.type === '+' ? '＋' : '－'} ${esc(name)}</b><span>${esc(text.slice(0, 240))}${text.length > 240 ? '…' : ''}</span></div>`;
    });
    const summary = `消息 ${messages(a).length} → ${messages(b).length} 条`;
    if (!items.length) return `<div class="git-sync-hint">${summary}，消息内容没有变化（改动在聊天信息或元数据里）。</div>`;
    return `<div class="git-sync-hint">${summary}</div><div class="git-sync-chat-diff">${items.slice(0, 300).join('')}</div>${items.length > 300 ? `<div class="git-sync-hint">还有 ${items.length - 300} 处改动未显示。</div>` : ''}`;
}

/** Pretty-prints JSON so settings and presets diff by field. */
function prettyJson(text) {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}

/**
 * Builds the HTML comparing two versions of a file.
 * @param {string} filepath
 * @param {{ exists: boolean, size?: number, binary?: boolean, text?: string|null }} before
 * @param {{ exists: boolean, size?: number, binary?: boolean, text?: string|null }} after
 */
export function renderFileComparison(filepath, before, after) {
    if (!before.exists && !after.exists) return '<div class="git-sync-hint">两边都没有这个文件。</div>';
    const textual = side => !side.exists || (side.text !== null && side.text !== undefined);
    if (!textual(before) || !textual(after)) {
        const label = side => (side.exists ? `${side.binary ? '二进制文件' : '文本文件'}，${formatSize(side.size)}` : '不存在');
        return `<div class="git-sync-compare-meta"><div><b>之前</b> ${label(before)}</div><div><b>之后</b> ${label(after)}</div></div>
            <div class="git-sync-hint">图片、角色卡等二进制文件或超过 512KB 的文件不显示具体内容。</div>`;
    }
    const a = before.text ?? '';
    const b = after.text ?? '';
    if (/\.jsonl$/i.test(filepath) || /\.chunks\/\d+\.jsonl$/i.test(filepath)) return renderChatDiff(a, b);
    if (/\.json$/i.test(filepath)) return renderLineDiff(prettyJson(a), prettyJson(b));
    return renderLineDiff(a, b);
}

/**
 * Opens a popup comparing a file in a commit with its parent, or the current data with the last commit.
 * @param {{ path: string, item?: string, categoryLabel?: string }} change
 * @param {{ oid?: string, against?: 'workdir' }} source
 */
export async function showFileDiff(change, source) {
    try {
        const result = await gitApi('/file', { path: change.path, ...source });
        const title = `${change.categoryLabel ? `${esc(change.categoryLabel)} · ` : ''}${esc(change.item || change.path)}`;
        await callGenericPopup(`<div class="git-sync-diff-popup"><h3>${title}</h3><div class="git-sync-path">${esc(change.path)}</div>${renderFileComparison(change.path, result.before, result.after)}</div>`, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
    } catch (error) {
        showError(error, '读取差异失败');
    }
}

import { esc, flushPendingSaves, gitApi, promptText, showError, timeAgo } from './shared.js';
import { isGenerating, writeCommitMessage } from './ai-commit.js';

/**
 * 酒馆 Git quick menu, opened from the chat bar's extensions menu: save now, mark a save point,
 * start a parallel storyline, history, and the full panel, with a status line on top.
 */

let menu = null;

/** "10月25日-0215": a readable default name that is valid for branches and save points. */
function stamp() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getMonth() + 1}月${now.getDate()}日-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Above the chat bar, lined up with the button that opened it. */
function place(anchor) {
    const bar = document.getElementById('send_form')?.getBoundingClientRect();
    const button = document.getElementById('extensionsMenuButton')?.getBoundingClientRect() ?? anchor?.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(button?.left ?? 8, window.innerWidth - menu.offsetWidth - 8))}px`;
    // top, not bottom: on phones the tavern transforms <html>, which then anchors fixed elements
    // to a zero-height box (the same reason the panel sets its size explicitly).
    const barTop = bar ? bar.top : window.innerHeight - 64;
    menu.style.top = `${Math.max(8, barTop - menu.offsetHeight - 6)}px`;
}

function close() {
    menu?.remove();
    menu = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
}

function onOutside(event) {
    if (menu && !menu.contains(/** @type {Node} */ (event.target))) close();
}

function onKey(event) {
    if (event.key === 'Escape') close();
}

/** Where saves go and how many changes are not saved yet. */
async function fillStatus(line, state) {
    const cloud = state.settings.remotes?.cloud?.provider === 'hosted';
    const other = Object.entries(state.settings.remotes ?? {}).find(([, remote]) => remote.provider !== 'hosted');
    const pushed = state.hosted?.status?.lastPushAt;
    const where = cloud ? `<i class="fa-solid fa-cloud"></i> ${esc(state.hosted.label)}${pushed ? ` · ${timeAgo(pushed / 1000)}同步` : ''}`
        : other ? `<i class="fa-solid fa-cloud-arrow-up"></i> ${esc(state.providers?.[other[1].provider]?.label ?? other[0])}`
            : '<i class="fa-solid fa-house"></i> 只在本地';
    line.innerHTML = `${where} · <span data-unsaved>…</span>`;
    try {
        const status = await gitApi('/status');
        line.querySelector('[data-unsaved]').textContent = status.changes.length ? `${status.changes.length} 项没存` : '都存好了';
    } catch {
        line.querySelector('[data-unsaved]').textContent = '';
    }
}

/** Saves everything (one commit per kind of data); "nothing to save" is fine. */
async function saveNow(state, { quiet = false } = {}) {
    await flushPendingSaves();
    let message = '';
    if (state.settings.smartCommit?.aiMessages && !isGenerating()) {
        message = await writeCommitMessage().catch(() => '');
    }
    try {
        const result = await gitApi('/commit', { split: true, message });
        if (!quiet) {
            const where = result.cloud?.scheduled ? '，稍后传到酒馆云' : '';
            toastr.success(esc((message || result.summary).split('\n')[0]), `已存档${where}`, { escapeHtml: false });
        }
        return result;
    } catch (error) {
        if (error.status === 409) {
            if (!quiet) toastr.info('没有新的改动，已经是最新的了');
            return null;
        }
        throw error;
    }
}

/**
 * @param {HTMLElement} anchor The menu item that was clicked
 * @param {(tab?: string) => void} openPanel
 */
export async function openQuickMenu(anchor, openPanel) {
    if (menu) return close();
    menu = document.createElement('div');
    menu.className = 'git-sync-quick';
    menu.innerHTML = '<div class="git-sync-quick-status"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    document.body.appendChild(menu);
    place(anchor);
    setTimeout(() => {
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    });

    let state;
    try {
        state = await gitApi('/state');
    } catch (error) {
        close();
        showError(error, '读取酒馆 Git 失败');
        return;
    }
    if (!menu) return;
    if (!state.exists) {
        menu.innerHTML = `
            <div class="git-sync-quick-status"><i class="fa-brands fa-git-alt"></i> 还没开始用酒馆 Git</div>
            <button type="button" data-q="open"><i class="fa-solid fa-hand-holding-heart"></i><span><b>开始</b><small>跟着点就行，自动帮你存聊天</small></span></button>`;
    } else {
        menu.innerHTML = `
            <div class="git-sync-quick-status"></div>
            <button type="button" data-q="save"><i class="fa-solid fa-floppy-disk"></i><span><b>马上存一份</b><small>把现在的改动都存下来</small></span></button>
            <button type="button" data-q="tag"><i class="fa-solid fa-bookmark"></i><span><b>存档点</b><small>给现在起个名字，以后好找</small></span></button>
            <button type="button" data-q="branch"><i class="fa-solid fa-code-branch"></i><span><b>开个平行世界</b><small>从这里分出一条新剧情线</small></span></button>
            <button type="button" data-q="history"><i class="fa-solid fa-clock-rotate-left"></i><span><b>历史</b><small>回到以前的某个时候</small></span></button>
            <button type="button" data-q="open" class="git-sync-quick-more"><i class="fa-brands fa-git-alt"></i><span><b>打开酒馆 Git</b></span></button>`;
        void fillStatus(menu.querySelector('.git-sync-quick-status'), state);
    }
    place(anchor);
    menu.querySelectorAll('[data-q]').forEach(button => button.addEventListener('click', () => run(button.dataset.q, state, openPanel)));
}

async function run(action, state, openPanel) {
    close();
    try {
        if (action === 'open') return openPanel();
        if (action === 'history') return openPanel('history');
        if (action === 'save') {
            await saveNow(state);
            return;
        }
        if (action === 'tag') {
            const name = await promptText('<h3><i class="fa-solid fa-bookmark"></i> 存档点叫什么？</h3><small>比如“第一章结束”“表白前”。会先把现在的改动存一份。</small>', stamp());
            if (!name) return;
            await saveNow(state, { quiet: true });
            await gitApi('/tag/create', { name: name.replace(/\s+/g, '-') });
            toastr.success(esc(name), '已设为存档点', { escapeHtml: false });
            return;
        }
        if (action === 'branch') {
            const name = await promptText('<h3><i class="fa-solid fa-code-branch"></i> 平行世界叫什么？</h3><small>之后的存档都记在这条线上；原来那条线随时能在“分支”里切回去。会先把现在的改动存一份。</small>', `支线-${stamp()}`);
            if (!name) return;
            await saveNow(state, { quiet: true });
            const result = await gitApi('/branch/create', { name: name.replace(/\s+/g, '-'), checkout: true });
            // The new line starts from what was just saved, so the page's data is already right.
            toastr.success(`现在在「${esc(result.name)}」这条线上`, '已开平行世界', { escapeHtml: false });
        }
    } catch (error) {
        showError(error);
    }
}

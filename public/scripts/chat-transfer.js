// 对话导入 / 导出 / 备份恢复面板
import {
    characters,
    this_chid,
    name1,
    getRequestHeaders,
    getCharacters,
    getCurrentChatId,
    saveChatConditional,
} from '../script.js';
import { groups, selected_group, editGroup } from './group-chats.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { timestampToMoment } from './utils.js';

const TABS = Object.freeze(['export', 'import', 'restore']);
const SCOPES = Object.freeze(['current', 'target', 'selection', 'all']);
const IMPORT_EXTENSIONS = Object.freeze(['jsonl', 'json']);

const PANEL_HTML = `
<div class="chatTransfer">
    <div class="chatTransfer-head">
        <div class="chatTransfer-title">
            <i class="fa-solid fa-right-left"></i>
            <span>对话导入 / 导出</span>
        </div>
        <div class="chatTransfer-tabs" role="tablist">
            <button type="button" class="chatTransfer-tab" role="tab" data-tab="export">
                <i class="fa-solid fa-file-export"></i><span>导出</span>
            </button>
            <button type="button" class="chatTransfer-tab" role="tab" data-tab="import">
                <i class="fa-solid fa-file-import"></i><span>导入</span>
            </button>
            <button type="button" class="chatTransfer-tab" role="tab" data-tab="restore">
                <i class="fa-solid fa-clock-rotate-left"></i><span>从备份恢复</span>
            </button>
        </div>
    </div>

    <section class="chatTransfer-panel" data-panel="export">
        <div class="chatTransfer-field">
            <div class="chatTransfer-label">导出范围</div>
            <div class="chatTransfer-choices">
                <label class="chatTransfer-choice" data-scope="current">
                    <input type="radio" name="chatTransferScope" value="current">
                    <i class="fa-solid fa-comment-dots"></i>
                    <span class="chatTransfer-choiceText"><b>当前对话</b><small>正在进行的这一段对话</small></span>
                </label>
                <label class="chatTransfer-choice" data-scope="target">
                    <input type="radio" name="chatTransferScope" value="target">
                    <i class="fa-solid fa-user"></i>
                    <span class="chatTransfer-choiceText"><b>某个角色的全部对话</b><small data-role="target-summary">选择角色或群聊</small></span>
                </label>
                <label class="chatTransfer-choice" data-scope="selection">
                    <input type="radio" name="chatTransferScope" value="selection">
                    <i class="fa-solid fa-list-check"></i>
                    <span class="chatTransfer-choiceText"><b>手动挑选</b><small>勾选需要导出的对话</small></span>
                </label>
                <label class="chatTransfer-choice" data-scope="all">
                    <input type="radio" name="chatTransferScope" value="all">
                    <i class="fa-solid fa-box-archive"></i>
                    <span class="chatTransfer-choiceText"><b>账号内全部对话</b><small>所有角色与群聊，适合换设备或迁移</small></span>
                </label>
            </div>
        </div>

        <div class="chatTransfer-field" data-role="export-target-field">
            <label class="chatTransfer-label" for="chatTransferExportTarget">角色 / 群聊</label>
            <select id="chatTransferExportTarget" class="text_pole" data-role="export-target"></select>
        </div>

        <div class="chatTransfer-field" data-role="chat-picker">
            <div class="chatTransfer-pickerBar">
                <input type="search" class="text_pole" data-role="chat-search" placeholder="搜索对话…" autocomplete="off">
                <button type="button" class="menu_button" data-action="select-all">全选</button>
                <button type="button" class="menu_button" data-action="select-none">清空</button>
            </div>
            <div class="chatTransfer-chatList" data-role="chat-list" role="listbox" aria-multiselectable="true"></div>
            <div class="chatTransfer-muted" data-role="selection-count"></div>
        </div>

        <div class="chatTransfer-field">
            <div class="chatTransfer-label">文件格式</div>
            <div class="chatTransfer-segmented">
                <label>
                    <input type="radio" name="chatTransferFormat" value="jsonl" checked>
                    <span><b>JSONL</b><small>完整数据，可重新导入</small></span>
                </label>
                <label>
                    <input type="radio" name="chatTransferFormat" value="txt">
                    <span><b>TXT</b><small>纯文本，方便阅读</small></span>
                </label>
            </div>
        </div>

        <label class="checkbox_label chatTransfer-check" data-role="include-cards">
            <input type="checkbox" checked>
            <span>同时打包角色卡和群组设置<small>在新账号或新服务器上恢复时需要</small></span>
        </label>

        <div class="chatTransfer-actions">
            <span class="chatTransfer-muted" data-role="export-hint"></span>
            <button type="button" class="menu_button chatTransfer-primary" data-action="export">
                <i class="fa-solid fa-download"></i><span>导出</span>
            </button>
        </div>
    </section>

    <section class="chatTransfer-panel" data-panel="import">
        <div class="chatTransfer-field">
            <label class="chatTransfer-label" for="chatTransferImportTarget">导入到</label>
            <select id="chatTransferImportTarget" class="text_pole" data-role="import-target"></select>
        </div>
        <div class="chatTransfer-drop" data-role="import-drop" tabindex="0" role="button">
            <i class="fa-solid fa-file-circle-plus"></i>
            <b>拖入或点击选择聊天文件</b>
            <small>可一次选择多个文件。支持 SillyTavern (.jsonl)，以及 Chub、Agnai、CAI Tools、Oobabooga、Kobold Lite、RisuAI 导出的 .json</small>
            <input type="file" data-role="import-input" accept=".jsonl,.json" multiple hidden>
        </div>
        <ul class="chatTransfer-results" data-role="import-results"></ul>
    </section>

    <section class="chatTransfer-panel" data-panel="restore">
        <div class="chatTransfer-note">
            <i class="fa-solid fa-circle-info"></i>
            <div>
                <p>支持两种 ZIP 文件：本面板「导出」得到的对话包，以及个人资料中「下载备份」得到的完整备份。</p>
                <ul>
                    <li>只恢复对话、群聊和角色卡，不会改动设置、API 密钥等其他数据。</li>
                    <li>不会覆盖或删除现有内容：完全相同的对话会自动跳过，同名但内容不同的另存为「(restored)」。</li>
                </ul>
            </div>
        </div>
        <label class="checkbox_label chatTransfer-check" data-role="include-characters">
            <input type="checkbox" checked>
            <span>同时恢复本账号缺少的角色卡<small>已存在的角色卡不会被替换</small></span>
        </label>
        <div class="chatTransfer-drop" data-role="restore-drop" tabindex="0" role="button">
            <i class="fa-solid fa-file-zipper"></i>
            <b>拖入或点击选择 ZIP 文件</b>
            <small>文件会上传到服务器处理，大小受服务器上传限制约束</small>
            <input type="file" data-role="restore-input" accept=".zip,application/zip" hidden>
        </div>
        <div class="chatTransfer-file" data-role="restore-file" hidden>
            <i class="fa-solid fa-file-zipper"></i>
            <div class="chatTransfer-fileInfo">
                <b data-role="restore-file-name"></b>
                <small data-role="restore-file-size"></small>
            </div>
            <button type="button" class="menu_button" data-action="restore-change">重新选择</button>
            <button type="button" class="menu_button chatTransfer-primary" data-action="restore-start">
                <i class="fa-solid fa-rotate-left"></i><span>开始恢复</span>
            </button>
        </div>
        <div class="chatTransfer-progress" data-role="restore-progress" hidden>
            <div class="chatTransfer-progressBar"><div data-role="restore-progress-bar"></div></div>
            <small data-role="restore-progress-text"></small>
        </div>
        <div class="chatTransfer-summary" data-role="restore-summary" hidden></div>
    </section>
</div>`;

/**
 * @typedef {{key: string, type: 'character'|'group', name: string, avatar?: string, id?: string}} TransferTarget
 * @typedef {{file: string, title: string, count?: number, size?: string, lastMes?: any}} TransferChat
 */

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function getDateStamp() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function toSafeFileName(name) {
    return String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'chat';
}

/**
 * Mirrors the server's file name sanitizing, so chat ids can be matched to stored files.
 * @param {string} chatId Chat id
 * @returns {string}
 */
function toStoredChatName(chatId) {
    return String(chatId)
        .replace(/[/?<>\\:*|"]/g, '')
        .replace(/[\u0000-\u001f\u0080-\u009f]/g, '')
        .replace(/[. ]+$/, '');
}

function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function readErrorMessage(response, fallback) {
    try {
        const data = await response.json();
        if (data?.error === 'upload_file_too_large') {
            return '文件超过服务器允许的上传大小';
        }
        return data?.message || fallback;
    } catch {
        return fallback;
    }
}

/**
 * @returns {TransferTarget[]}
 */
function getTargets() {
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const nameCounts = new Map();
    for (const character of characters) {
        nameCounts.set(character.name, (nameCounts.get(character.name) ?? 0) + 1);
    }
    const characterTargets = characters
        .filter(character => character?.avatar)
        .map(character => ({
            key: `char:${character.avatar}`,
            type: /** @type {const} */ ('character'),
            avatar: character.avatar,
            name: nameCounts.get(character.name) > 1 ? `${character.name}（${character.avatar}）` : String(character.name),
        }))
        .sort((a, b) => collator.compare(a.name, b.name));
    const groupTargets = groups
        .map(group => ({
            key: `group:${group.id}`,
            type: /** @type {const} */ ('group'),
            id: String(group.id),
            name: String(group.name || group.id),
        }))
        .sort((a, b) => collator.compare(a.name, b.name));
    return [...characterTargets, ...groupTargets];
}

function getActiveTargetKey() {
    if (selected_group) {
        return `group:${selected_group}`;
    }
    const character = this_chid !== undefined ? characters[this_chid] : null;
    return character?.avatar ? `char:${character.avatar}` : null;
}

function fillTargetSelect(select, targets, selectedKey) {
    select.replaceChildren();
    const characterGroup = document.createElement('optgroup');
    characterGroup.label = '角色';
    const groupGroup = document.createElement('optgroup');
    groupGroup.label = '群聊';
    for (const target of targets) {
        const option = document.createElement('option');
        option.value = target.key;
        option.textContent = target.name;
        (target.type === 'group' ? groupGroup : characterGroup).append(option);
    }
    if (characterGroup.children.length) select.append(characterGroup);
    if (groupGroup.children.length) select.append(groupGroup);
    if (selectedKey && targets.some(target => target.key === selectedKey)) {
        select.value = selectedKey;
    }
}

/**
 * @param {TransferTarget} target
 * @returns {Promise<TransferChat[]>}
 */
async function fetchTargetChats(target) {
    if (target.type === 'group') {
        const group = groups.find(item => String(item.id) === target.id);
        return (Array.isArray(group?.chats) ? group.chats : [])
            .map(String)
            .reverse()
            .map(id => ({ file: `${id}.jsonl`, title: id }));
    }

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: target.avatar }),
    });
    if (!response.ok) {
        throw new Error(await readErrorMessage(response, '无法读取对话列表'));
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
        return [];
    }
    return data
        .filter(chat => typeof chat?.file_name === 'string')
        .map(chat => ({
            file: chat.file_name,
            title: chat.file_name.replace(/\.jsonl$/, ''),
            count: Number(chat.chat_items) || 0,
            size: chat.file_size,
            lastMes: chat.last_mes,
        }))
        .sort((a, b) => (timestampToMoment(b.lastMes).valueOf() || 0) - (timestampToMoment(a.lastMes).valueOf() || 0));
}

class ChatTransferPanel {
    /**
     * @param {{tab?: string, scope?: string, targetKey?: string|null}} options
     */
    constructor({ tab = 'export', scope, targetKey } = {}) {
        this.root = /** @type {HTMLElement} */ (new DOMParser().parseFromString(PANEL_HTML, 'text/html').body.firstElementChild);
        this.targets = getTargets();
        this.activeKey = getActiveTargetKey();
        this.currentChatId = this.activeKey ? getCurrentChatId() : null;
        this.targetKey = targetKey ?? this.activeKey ?? this.targets[0]?.key ?? null;
        this.scope = SCOPES.includes(scope) ? scope : (this.currentChatId ? 'current' : this.targetKey ? 'target' : 'all');
        this.chats = /** @type {TransferChat[]} */ ([]);
        this.selectedFiles = new Set();
        this.chatListRequest = 0;
        this.busy = false;
        this.restoreFile = /** @type {File|null} */ (null);
        this.dataChanged = false;

        this.bind();
        this.renderTargets();
        this.setTab(TABS.includes(tab) ? tab : 'export');
        this.setScope(this.scope);
        void this.loadChats();
    }

    $(role) {
        return this.root.querySelector(`[data-role="${role}"]`);
    }

    get format() {
        return /** @type {HTMLInputElement} */ (this.root.querySelector('input[name="chatTransferFormat"]:checked'))?.value === 'txt' ? 'txt' : 'jsonl';
    }

    get target() {
        return this.targets.find(target => target.key === this.targetKey) ?? null;
    }

    bind() {
        this.root.querySelectorAll('.chatTransfer-tab').forEach(button => {
            button.addEventListener('click', () => this.setTab(button.getAttribute('data-tab')));
        });
        this.root.querySelectorAll('input[name="chatTransferScope"]').forEach(input => {
            input.addEventListener('change', () => this.setScope(/** @type {HTMLInputElement} */ (input).value));
        });
        this.root.querySelectorAll('input[name="chatTransferFormat"]').forEach(input => {
            input.addEventListener('change', () => this.updateExportState());
        });

        const exportTarget = /** @type {HTMLSelectElement} */ (this.$('export-target'));
        exportTarget.addEventListener('change', () => {
            this.targetKey = exportTarget.value;
            /** @type {HTMLSelectElement} */ (this.$('import-target')).value = exportTarget.value;
            void this.loadChats();
        });
        const importTarget = /** @type {HTMLSelectElement} */ (this.$('import-target'));
        importTarget.addEventListener('change', () => {
            this.targetKey = importTarget.value;
            exportTarget.value = importTarget.value;
            void this.loadChats();
        });

        this.$('chat-search').addEventListener('input', () => this.renderChatList());
        this.root.querySelector('[data-action="select-all"]').addEventListener('click', () => {
            this.getVisibleChats().forEach(chat => this.selectedFiles.add(chat.file));
            this.renderChatList();
        });
        this.root.querySelector('[data-action="select-none"]').addEventListener('click', () => {
            this.selectedFiles.clear();
            this.renderChatList();
        });
        this.root.querySelector('[data-action="export"]').addEventListener('click', () => void this.runExport());

        this.bindDropZone(this.$('import-drop'), /** @type {HTMLInputElement} */ (this.$('import-input')), files => void this.runImport(files));
        this.bindDropZone(this.$('restore-drop'), /** @type {HTMLInputElement} */ (this.$('restore-input')), files => this.chooseRestoreFile(files[0]));
        this.root.querySelector('[data-action="restore-change"]').addEventListener('click', () => /** @type {HTMLInputElement} */ (this.$('restore-input')).click());
        this.root.querySelector('[data-action="restore-start"]').addEventListener('click', () => void this.runRestore());
    }

    /**
     * @param {HTMLElement} zone
     * @param {HTMLInputElement} input
     * @param {(files: File[]) => void} onFiles
     */
    bindDropZone(zone, input, onFiles) {
        const open = () => {
            if (!this.busy) input.click();
        };
        zone.addEventListener('click', open);
        zone.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
            }
        });
        input.addEventListener('click', event => event.stopPropagation());
        input.addEventListener('change', () => {
            const files = Array.from(input.files ?? []);
            input.value = '';
            if (files.length) onFiles(files);
        });
        zone.addEventListener('dragover', event => {
            event.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', event => {
            event.preventDefault();
            zone.classList.remove('dragover');
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (files.length && !this.busy) onFiles(files);
        });
    }

    setTab(tab) {
        this.tab = tab;
        this.root.querySelectorAll('.chatTransfer-tab').forEach(button => {
            const active = button.getAttribute('data-tab') === tab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        this.root.querySelectorAll('.chatTransfer-panel').forEach(panel => {
            panel.toggleAttribute('hidden', panel.getAttribute('data-panel') !== tab);
        });
    }

    setScope(scope) {
        this.scope = scope;
        const input = /** @type {HTMLInputElement} */ (this.root.querySelector(`input[name="chatTransferScope"][value="${scope}"]`));
        if (input) input.checked = true;
        this.updateExportState();
    }

    renderTargets() {
        fillTargetSelect(/** @type {HTMLSelectElement} */ (this.$('export-target')), this.targets, this.targetKey);
        fillTargetSelect(/** @type {HTMLSelectElement} */ (this.$('import-target')), this.targets, this.targetKey);
        const hasTargets = this.targets.length > 0;
        for (const scope of ['target', 'selection']) {
            this.toggleChoice(scope, hasTargets);
        }
        this.toggleChoice('current', Boolean(this.currentChatId));
        if (!hasTargets) {
            const drop = this.$('import-drop');
            drop.classList.add('disabled');
            drop.querySelector('b').textContent = '还没有角色或群聊，请先创建或导入角色卡';
        }
    }

    toggleChoice(scope, enabled) {
        const choice = this.root.querySelector(`.chatTransfer-choice[data-scope="${scope}"]`);
        choice.classList.toggle('disabled', !enabled);
        choice.querySelector('input').disabled = !enabled;
    }

    async loadChats() {
        const target = this.target;
        const requestId = ++this.chatListRequest;
        this.chats = [];
        this.selectedFiles.clear();
        this.$('target-summary').textContent = target ? `${target.name} · 正在统计…` : '选择角色或群聊';
        this.renderChatList(true);
        this.updateExportState();
        if (!target) return;

        try {
            const chats = await fetchTargetChats(target);
            if (requestId !== this.chatListRequest) return;
            this.chats = chats;
        } catch (error) {
            if (requestId !== this.chatListRequest) return;
            console.error('Failed to load chats for transfer panel', error);
            toastr.error(error.message || '无法读取对话列表');
        }
        this.$('target-summary').textContent = `${target.name} · 共 ${this.chats.length} 段对话`;
        this.renderChatList();
        this.updateExportState();
    }

    getVisibleChats() {
        const query = /** @type {HTMLInputElement} */ (this.$('chat-search')).value.trim().toLowerCase();
        return query ? this.chats.filter(chat => chat.title.toLowerCase().includes(query)) : this.chats;
    }

    renderChatList(loading = false) {
        const list = this.$('chat-list');
        list.replaceChildren();
        if (loading) {
            list.append(this.createEmptyState('fa-spinner fa-spin', '正在加载…'));
        } else if (this.chats.length === 0) {
            list.append(this.createEmptyState('fa-comment-slash', '这个角色还没有对话'));
        } else {
            const visible = this.getVisibleChats();
            if (visible.length === 0) {
                list.append(this.createEmptyState('fa-magnifying-glass', '没有匹配的对话'));
            }
            for (const chat of visible) {
                list.append(this.createChatRow(chat));
            }
        }
        this.$('selection-count').textContent = this.chats.length ? `已选 ${this.selectedFiles.size} / ${this.chats.length}` : '';
        this.updateExportState();
    }

    createEmptyState(icon, text) {
        const empty = document.createElement('div');
        empty.className = 'chatTransfer-empty';
        const iconElement = document.createElement('i');
        iconElement.className = `fa-solid ${icon}`;
        const label = document.createElement('span');
        label.textContent = text;
        empty.append(iconElement, label);
        return empty;
    }

    /**
     * @param {TransferChat} chat
     */
    createChatRow(chat) {
        const row = document.createElement('label');
        row.className = 'chatTransfer-chat';
        row.setAttribute('role', 'option');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.selectedFiles.has(chat.file);
        row.setAttribute('aria-selected', String(checkbox.checked));
        row.classList.toggle('selected', checkbox.checked);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                this.selectedFiles.add(chat.file);
            } else {
                this.selectedFiles.delete(chat.file);
            }
            row.classList.toggle('selected', checkbox.checked);
            row.setAttribute('aria-selected', String(checkbox.checked));
            this.$('selection-count').textContent = `已选 ${this.selectedFiles.size} / ${this.chats.length}`;
            this.updateExportState();
        });

        const text = document.createElement('span');
        text.className = 'chatTransfer-chatText';
        const title = document.createElement('b');
        title.textContent = chat.title;
        text.append(title);

        const meta = [];
        if (Number.isFinite(chat.count)) meta.push(`${chat.count} 条消息`);
        if (chat.size) meta.push(String(chat.size).toUpperCase());
        const date = chat.lastMes ? timestampToMoment(chat.lastMes) : null;
        if (date?.isValid()) meta.push(date.format('YYYY-MM-DD HH:mm'));
        if (meta.length) {
            const small = document.createElement('small');
            small.textContent = meta.join(' · ');
            text.append(small);
        }
        if (this.activeKey === this.targetKey && this.currentChatId && chat.title === toStoredChatName(this.currentChatId)) {
            const badge = document.createElement('span');
            badge.className = 'chatTransfer-badge';
            badge.textContent = '当前';
            title.append(badge);
        }

        row.append(checkbox, text);
        return row;
    }

    /**
     * Resolves the chats to export for the current scope.
     * @returns {{kind: 'single', target: TransferTarget, file: string} | {kind: 'bundle', body: object, name: string} | null}
     */
    getExportPlan() {
        const target = this.target;
        switch (this.scope) {
            case 'current': {
                const active = this.targets.find(item => item.key === this.activeKey);
                return active && this.currentChatId ? { kind: 'single', target: active, file: `${this.currentChatId}.jsonl` } : null;
            }
            case 'target':
            case 'selection': {
                if (!target) return null;
                const files = this.scope === 'target'
                    ? this.chats.map(chat => chat.file)
                    : this.chats.filter(chat => this.selectedFiles.has(chat.file)).map(chat => chat.file);
                if (files.length === 0) return null;
                if (files.length === 1) return { kind: 'single', target, file: files[0] };
                const targetBody = target.type === 'group'
                    ? { type: 'group', id: target.id, files }
                    : { type: 'character', avatar: target.avatar, files };
                return { kind: 'bundle', body: { scope: 'selection', targets: [targetBody] }, name: target.name };
            }
            case 'all':
                return { kind: 'bundle', body: { scope: 'all' }, name: '全部对话' };
        }
        return null;
    }

    updateExportState() {
        const scopeNeedsTarget = this.scope === 'target' || this.scope === 'selection';
        this.$('export-target-field').hidden = !scopeNeedsTarget;
        this.$('chat-picker').hidden = this.scope !== 'selection';

        const plan = this.getExportPlan();
        const includeCards = this.$('include-cards');
        includeCards.hidden = this.format !== 'jsonl' || !plan || plan.kind !== 'bundle';

        let hint = '';
        if (this.scope === 'all') {
            hint = '将打包为一个 ZIP 文件';
        } else if (scopeNeedsTarget && !this.chatListRequestPending() && this.chats.length === 0) {
            hint = '没有可导出的对话';
        } else if (this.scope === 'selection' && this.selectedFiles.size === 0) {
            hint = '请至少勾选一段对话';
        } else if (plan?.kind === 'single') {
            hint = `将下载 1 个 .${this.format} 文件`;
        } else if (plan?.kind === 'bundle') {
            const count = this.scope === 'target' ? this.chats.length : this.selectedFiles.size;
            hint = `将 ${count} 段对话打包为 ZIP`;
        }
        this.$('export-hint').textContent = hint;

        const button = /** @type {HTMLButtonElement} */ (this.root.querySelector('[data-action="export"]'));
        button.classList.toggle('disabled', this.busy || !plan);
        button.toggleAttribute('disabled', this.busy || !plan);
    }

    chatListRequestPending() {
        return this.$('chat-list').querySelector('.fa-spinner') !== null;
    }

    setBusy(busy, button = null, label = null) {
        this.busy = busy;
        this.root.classList.toggle('busy', busy);
        if (button) {
            const icon = button.querySelector('i');
            const text = button.querySelector('span');
            if (busy) {
                button.dataset.icon = icon?.className ?? '';
                button.dataset.label = text?.textContent ?? '';
                if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
                if (text && label) text.textContent = label;
            } else {
                if (icon) icon.className = button.dataset.icon || icon.className;
                if (text) text.textContent = button.dataset.label || text.textContent;
            }
        }
        this.updateExportState();
    }

    async runExport() {
        const plan = this.getExportPlan();
        if (!plan || this.busy) return;
        const button = /** @type {HTMLButtonElement} */ (this.root.querySelector('[data-action="export"]'));
        const format = this.format;
        this.setBusy(true, button, '正在导出…');
        try {
            await saveChatConditional();
            if (plan.kind === 'single') {
                await this.exportSingle(plan.target, plan.file, format);
            } else {
                await this.exportBundle(plan.body, plan.name, format);
            }
        } catch (error) {
            console.error('Chat export failed', error);
            toastr.error(error.message || '导出失败');
        } finally {
            this.setBusy(false, button);
        }
    }

    async exportSingle(target, file, format) {
        const baseName = file.replace(/\.jsonl$/, '');
        const response = await fetch('/api/chats/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                is_group: target.type === 'group',
                avatar_url: target.avatar,
                file,
                exportfilename: `${baseName}.${format}`,
                format,
            }),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response, '导出失败'));
        }
        const data = await response.json();
        const type = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-ndjson;charset=utf-8';
        downloadBlob(new Blob([data.result ?? ''], { type }), `${toSafeFileName(baseName)}.${format}`);
        toastr.success('对话已导出');
    }

    async exportBundle(body, name, format) {
        const includeCards = format === 'jsonl' && /** @type {HTMLInputElement} */ (this.$('include-cards').querySelector('input')).checked;
        const response = await fetch('/api/chats/export-bundle', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...body, format, include_cards: includeCards }),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response, '导出失败'));
        }
        const blob = await response.blob();
        downloadBlob(blob, `${toSafeFileName(name)}-${format.toUpperCase()}-${getDateStamp()}.zip`);
        toastr.success(`已导出 ZIP（${formatBytes(blob.size)}）`);
    }

    /**
     * @param {File[]} files
     */
    async runImport(files) {
        const target = this.targets.find(item => item.key === /** @type {HTMLSelectElement} */ (this.$('import-target')).value);
        if (!target || this.busy) return;

        const zip = files.find(file => /\.zip$/i.test(file.name));
        if (zip) {
            this.setTab('restore');
            this.chooseRestoreFile(zip);
            toastr.info('ZIP 文件请使用「从备份恢复」');
            return;
        }

        const results = this.$('import-results');
        results.replaceChildren();
        this.setBusy(true);
        let imported = 0;
        try {
            await saveChatConditional();
            for (const file of files) {
                const row = this.createResultRow(file.name);
                results.append(row);
                try {
                    const names = await this.importFile(target, file);
                    imported += names.length;
                    this.setResult(row, 'success', names.length > 1 ? `已导入 ${names.length} 段对话` : '已导入');
                } catch (error) {
                    this.setResult(row, 'error', error.message || '导入失败');
                }
            }
        } finally {
            this.setBusy(false);
        }

        if (imported > 0) {
            this.dataChanged = true;
            toastr.success(`已导入 ${imported} 段对话到「${target.name}」`);
            void this.loadChats();
        }
    }

    /**
     * @param {TransferTarget} target
     * @param {File} file
     * @returns {Promise<string[]>} Imported chat names
     */
    async importFile(target, file) {
        const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (!IMPORT_EXTENSIONS.includes(extension)) {
            throw new Error('只支持 .jsonl 或 .json 文件');
        }
        if (target.type === 'group' && extension !== 'jsonl') {
            throw new Error('群聊只支持导入 SillyTavern 的 .jsonl 文件');
        }

        const formData = new FormData();
        formData.set('avatar', file);
        formData.set('file_type', extension);
        formData.set('user_name', name1);
        if (target.type === 'character') {
            const character = characters.find(item => item.avatar === target.avatar);
            formData.set('avatar_url', target.avatar);
            formData.set('character_name', character?.name ?? target.name);
        }

        const response = await fetch(target.type === 'group' ? '/api/chats/group/import' : '/api/chats/import', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response, '导入失败'));
        }
        const data = await response.json();
        if (data?.error) {
            throw new Error('无法识别的聊天文件格式');
        }

        if (target.type === 'group') {
            const group = groups.find(item => String(item.id) === target.id);
            if (!group || !data.res) {
                throw new Error('群聊不存在');
            }
            group.chats.push(String(data.res));
            await editGroup(group.id, true, false);
            return [String(data.res)];
        }
        return Array.isArray(data.fileNames) ? data.fileNames : [];
    }

    createResultRow(fileName) {
        const row = document.createElement('li');
        row.className = 'is-pending';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-spinner fa-spin';
        const name = document.createElement('span');
        name.className = 'chatTransfer-resultName';
        name.textContent = fileName;
        const status = document.createElement('small');
        status.textContent = '正在导入…';
        row.append(icon, name, status);
        return row;
    }

    setResult(row, state, message) {
        row.className = `is-${state}`;
        row.querySelector('i').className = state === 'success' ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-xmark';
        row.querySelector('small').textContent = message;
    }

    /**
     * @param {File} file
     */
    chooseRestoreFile(file) {
        if (!file || this.busy) return;
        if (!/\.zip$/i.test(file.name)) {
            toastr.warning('请选择 .zip 文件');
            return;
        }
        this.restoreFile = file;
        this.$('restore-file-name').textContent = file.name;
        this.$('restore-file-size').textContent = formatBytes(file.size);
        this.$('restore-file').hidden = false;
        this.$('restore-drop').hidden = true;
        this.$('restore-summary').hidden = true;
        this.$('restore-progress').hidden = true;
    }

    async runRestore() {
        if (!this.restoreFile || this.busy) return;
        const button = /** @type {HTMLButtonElement} */ (this.root.querySelector('[data-action="restore-start"]'));
        const includeCharacters = /** @type {HTMLInputElement} */ (this.$('include-characters').querySelector('input')).checked;
        const progress = this.$('restore-progress');
        const bar = /** @type {HTMLElement} */ (this.$('restore-progress-bar'));
        const progressText = this.$('restore-progress-text');
        progress.hidden = false;
        progress.classList.remove('indeterminate');
        bar.style.width = '0%';
        progressText.textContent = '正在上传…';
        this.$('restore-summary').hidden = true;
        this.setBusy(true, button, '正在恢复…');

        try {
            await saveChatConditional();
            const formData = new FormData();
            formData.set('avatar', this.restoreFile);
            formData.set('include_characters', String(includeCharacters));
            const result = await this.uploadWithProgress('/api/chats/import-archive', formData, fraction => {
                if (fraction < 1) {
                    bar.style.width = `${Math.round(fraction * 100)}%`;
                    progressText.textContent = `正在上传… ${Math.round(fraction * 100)}%`;
                } else {
                    progress.classList.add('indeterminate');
                    bar.style.width = '100%';
                    progressText.textContent = '上传完成，正在恢复数据…';
                }
            });
            progress.hidden = true;
            this.renderRestoreSummary(result.summary);
            this.dataChanged = true;
            this.restoreFile = null;
            this.$('restore-file').hidden = true;
            this.$('restore-drop').hidden = false;
            await getCharacters();
            this.targets = getTargets();
            this.renderTargets();
            void this.loadChats();
            toastr.success('恢复完成');
        } catch (error) {
            console.error('Chat restore failed', error);
            progress.hidden = true;
            toastr.error(error.message || '恢复失败');
        } finally {
            this.setBusy(false, button);
        }
    }

    /**
     * @param {string} url
     * @param {FormData} formData
     * @param {(fraction: number) => void} onProgress
     * @returns {Promise<any>}
     */
    uploadWithProgress(url, formData, onProgress) {
        return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open('POST', url);
            for (const [header, value] of Object.entries(getRequestHeaders({ omitContentType: true }))) {
                request.setRequestHeader(header, String(value));
            }
            request.upload.addEventListener('progress', event => {
                if (event.lengthComputable) onProgress(event.loaded / event.total);
            });
            request.upload.addEventListener('load', () => onProgress(1));
            request.addEventListener('load', () => {
                let data = null;
                try {
                    data = JSON.parse(request.responseText);
                } catch {
                    // Non-JSON error bodies fall through to the generic message.
                }
                if (request.status >= 200 && request.status < 300 && data?.ok) {
                    resolve(data);
                } else if (data?.error === 'upload_file_too_large') {
                    reject(new Error('文件超过服务器允许的上传大小'));
                } else {
                    reject(new Error(data?.message || data?.error || `恢复失败（HTTP ${request.status}）`));
                }
            });
            request.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
            request.addEventListener('abort', () => reject(new Error('上传已取消')));
            request.send(formData);
        });
    }

    renderRestoreSummary(summary) {
        const container = this.$('restore-summary');
        container.replaceChildren();
        const title = document.createElement('div');
        title.className = 'chatTransfer-summaryTitle';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-check';
        const titleText = document.createElement('span');
        titleText.textContent = '恢复完成';
        title.append(icon, titleText);
        container.append(title);

        const addRow = (label, parts) => {
            const text = parts.filter(([count]) => count > 0).map(([count, word]) => `${word} ${count}`).join('，');
            if (!text) return;
            const row = document.createElement('div');
            row.className = 'chatTransfer-summaryRow';
            const name = document.createElement('span');
            name.textContent = label;
            const value = document.createElement('b');
            value.textContent = text;
            row.append(name, value);
            container.append(row);
        };

        addRow('角色对话', [[summary.chats.imported, '新增'], [summary.chats.renamed, '另存副本'], [summary.chats.skipped, '已存在跳过']]);
        addRow('群聊对话', [[summary.groupChats.imported, '新增'], [summary.groupChats.renamed, '另存副本'], [summary.groupChats.skipped, '已存在跳过'], [summary.groupChats.orphaned, '找不到所属群组']]);
        addRow('群组', [[summary.groups.created, '新建'], [summary.groups.updated, '补充对话']]);
        addRow('角色卡', [[summary.characters.imported, '新增'], [summary.characters.skipped, '已存在'], [summary.characters.notSelected, '未勾选恢复'], [summary.characters.invalid, '无效']]);
        if (summary.invalidLines > 0) {
            addRow('损坏的消息行', [[summary.invalidLines, '已忽略']]);
        }
        if (container.querySelectorAll('.chatTransfer-summaryRow').length === 0) {
            const empty = document.createElement('div');
            empty.className = 'chatTransfer-muted';
            empty.textContent = '压缩包中的内容都已存在，没有需要恢复的数据。';
            container.append(empty);
        }

        if (Array.isArray(summary.missingCharacters) && summary.missingCharacters.length > 0) {
            const warning = document.createElement('div');
            warning.className = 'chatTransfer-warning';
            const warningIcon = document.createElement('i');
            warningIcon.className = 'fa-solid fa-triangle-exclamation';
            const warningText = document.createElement('span');
            warningText.textContent = `以下角色在本账号中不存在，对应对话已保存，导入同名角色卡后即可看到：${summary.missingCharacters.join('、')}`;
            warning.append(warningIcon, warningText);
            container.append(warning);
        }
        container.hidden = false;
    }
}

/**
 * Opens the chat import / export panel.
 * @param {{tab?: 'export'|'import'|'restore', scope?: 'current'|'target'|'selection'|'all', targetKey?: string}} [options]
 * @returns {Promise<void>}
 */
export async function openChatTransferPanel(options = {}) {
    const panel = new ChatTransferPanel(options);
    await callGenericPopup(panel.root, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: false,
        allowVerticalScrolling: true,
        leftAlign: true,
        okButton: '关闭',
        onClosing: () => {
            if (panel.busy) {
                toastr.info('正在处理，请稍候完成后再关闭');
                return false;
            }
            return true;
        },
    });
}

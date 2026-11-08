import {
    addOneMessage,
    characters,
    chat,
    deleteCharacterChatByName,
    displayVersion,
    doNewChat,
    event_types,
    eventSource,
    getCharacters,
    getCurrentChatId,
    getRequestHeaders,
    getSystemMessageByType,
    getThumbnailUrl,
    is_send_press,
    neutralCharacterName,
    newAssistantChat,
    openCharacterChat,
    printCharactersDebounced,
    renameGroupOrCharacterChat,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
    system_avatar,
    system_message_types,
    this_chid,
    unshallowCharacter,
    updateRemoteChatName,
} from '../script.js';
import { getRegexedString, regex_placement } from './extensions/regex/engine.js';
import { deleteGroupChatByName, getGroupAvatar, groups, is_group_generating, openGroupById, openGroupChat } from './group-chats.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';
import { accountStorage } from './util/AccountStorage.js';
import { sortMoments, timestampToMoment, clamp, flashHighlight, isElementInViewport } from './utils.js';
import { cleanupLegacyWelcomeImageCache, loadWelcomeCharacterImage } from './welcome-image-loader.js';
import { cancelWelcomeMotion, runRecentChatTransition, runShowMoreTransition } from './welcome-motion.js';

const assistantAvatarKey = 'assistant';
const pinnedChatsKey = 'pinnedChats';
const recentChatsSettingsKey = 'recentChatsSettings';
const defaultAssistantAvatar = 'default_Assistant.png';

const DEFAULT_MAX_DISPLAYED = 15;
const DEFAULT_COLLAPSED_DISPLAYED = 3;

/**
 * Gets the current recent chats settings from account storage.
 * @returns {{ maxDisplayed: number, collapsedDisplayed: number }}
 */
function getRecentChatsSettings() {
    const value = accountStorage.getItem(recentChatsSettingsKey);
    if (value) {
        try {
            const parsed = JSON.parse(value);
            return {
                maxDisplayed: Math.max(1, parseInt(parsed.maxDisplayed) || DEFAULT_MAX_DISPLAYED),
                collapsedDisplayed: Math.max(1, parseInt(parsed.collapsedDisplayed) || DEFAULT_COLLAPSED_DISPLAYED),
            };
        } catch {
            // Ignore parse errors
        }
    }
    return { maxDisplayed: DEFAULT_MAX_DISPLAYED, collapsedDisplayed: DEFAULT_COLLAPSED_DISPLAYED };
}

/**
 * Saves recent chats settings to account storage.
 * @param {{ maxDisplayed: number, collapsedDisplayed: number }} settings
 */
function saveRecentChatsSettings(settings) {
    accountStorage.setItem(recentChatsSettingsKey, JSON.stringify(settings));
}

/**
 * @typedef {Pick<RecentChat, 'group' | 'avatar' | 'file_name'>} PinnedChat
 */

/**
 * Manages pinned chat storage and operations.
 */
class PinnedChatsManager {
    /** @type {Record<string, PinnedChat> | null} */
    static #cachedState = null;

    /**
     * Initializes the cached state from storage.
     * Should be called once on app init.
     */
    static init() {
        this.#cachedState = this.#loadFromStorage();
    }

    /**
     * Loads state from storage.
     * @returns {Record<string, PinnedChat>}
     */
    static #loadFromStorage() {
        const pinnedState = /** @type {Record<string, PinnedChat>} */ ({});
        const value = accountStorage.getItem(pinnedChatsKey);
        if (value) {
            try {
                Object.assign(pinnedState, JSON.parse(value));
            } catch (error) {
                console.warn('Failed to parse pinned chats from storage.', error);
            }
        }
        return pinnedState;
    }

    /**
     * Generates a key for pinned chat storage.
     * @param {Partial<RecentChat>} recentChat Recent chat data
     * @returns {string} Key for pinned chat storage
     */
    static getKey(recentChat) {
        return `${recentChat.group ? 'group_' + recentChat.group : ''}${recentChat.avatar ? 'char_' + recentChat.avatar : ''}_${recentChat.file_name}`;
    }

    /**
     * Gets the pinned chat state from cache.
     * @returns {Record<string, PinnedChat>}
     */
    static getState() {
        if (this.#cachedState === null) {
            this.#cachedState = this.#loadFromStorage();
        }
        return this.#cachedState;
    }

    /**
     * Saves the pinned chat state to storage and updates cache.
     * @param {Record<string, PinnedChat>} state The state to save
     */
    static #saveState(state) {
        this.#cachedState = state;
        accountStorage.setItem(pinnedChatsKey, JSON.stringify(state));
    }

    /**
     * Checks if a chat is pinned.
     * @param {RecentChat} recentChat Recent chat data
     * @returns {boolean} True if the chat is pinned, false otherwise
     */
    static isPinned(recentChat) {
        const pinKey = this.getKey(recentChat);
        const pinState = this.getState();
        return pinKey in pinState;
    }

    /**
     * Toggles the pinned state of a chat.
     * @param {RecentChat} recentChat Recent chat data
     * @param {boolean} pinned New pinned state
     */
    static toggle(recentChat, pinned) {
        const pinKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (pinned) {
            pinState[pinKey] = {
                group: recentChat.group,
                avatar: recentChat.avatar,
                file_name: recentChat.file_name,
            };
        } else {
            delete pinState[pinKey];
        }
        this.#saveState(pinState);
    }

    /**
     * Migrates pinned state when a chat is renamed.
     * @param {Partial<RecentChat>} recentChat Recent chat data (with original file_name)
     * @param {string} newFileName New file name after rename
     */
    static rename(recentChat, newFileName) {
        const oldKey = this.getKey(recentChat);
        const pinState = { ...this.getState() };
        if (!(oldKey in pinState)) {
            return;
        }
        const updatedChat = { ...recentChat, file_name: newFileName };
        const newKey = this.getKey(updatedChat);
        pinState[newKey] = {
            group: recentChat.group,
            avatar: recentChat.avatar,
            file_name: newFileName,
        };
        delete pinState[oldKey];
        this.#saveState(pinState);
    }

    /**
     * Gets all pinned chats.
     * @returns {PinnedChat[]}
     */
    static getAll() {
        const pinState = this.getState();
        return Object.values(pinState);
    }
}

// 角色卡分页配置
const CHARACTERS_PER_PAGE = 5;  // 每页显示5张，减少网络压力
let welcomeCharactersCurrentPage = 1;

let legacyImageCacheCleanupScheduled = false;

export function getPermanentAssistantAvatar() {
    const assistantAvatar = accountStorage.getItem(assistantAvatarKey);
    if (assistantAvatar === null) {
        return defaultAssistantAvatar;
    }

    const character = characters.find(x => x.avatar === assistantAvatar);
    if (character === undefined) {
        accountStorage.removeItem(assistantAvatarKey);
        return defaultAssistantAvatar;
    }

    return assistantAvatar;
}

/**
 * Opens a welcome screen if no chat is currently active.
 * @param {object} param Additional parameters
 * @param {boolean} [param.force] If true, forces clearing of the welcome screen.
 * @param {boolean} [param.expand] If true, expands the recent chats section.
 * @returns {Promise<void>}
 */
export async function openWelcomeScreen({ force = false, expand = false } = {}) {
    cancelWelcomeMotion();
    const currentChatId = getCurrentChatId();
    if (currentChatId !== undefined || (chat.length > 0 && !force)) {
        return;
    }

    const recentChats = await getRecentChats();
    const chatAfterFetch = getCurrentChatId();
    if (chatAfterFetch !== currentChatId) {
        console.debug('Chat changed while fetching recent chats.');
        return;
    }

    if (chatAfterFetch === undefined && force) {
        console.debug('Forcing welcome screen open.');
        chat.splice(0, chat.length);
        $('#chat').empty();
    }

    await sendWelcomePanel(recentChats, expand);
}

/**
 * Makes sure the assistant character has all data loaded.
 * @returns {Promise<void>}
 */
async function unshallowPermanentAssistant() {
    const assistantAvatar = getPermanentAssistantAvatar();
    const characterId = characters.findIndex(x => x.avatar === assistantAvatar);
    if (characterId === -1) {
        return;
    }

    await unshallowCharacter(String(characterId));
}

/**
 * Returns a greeting message for the assistant based on the character.
 * @param {Character} character Character data
 * @returns {string} Greeting message
*/
function getAssistantGreeting(character) {
    const defaultGreeting = t`If you're connected to an API, try asking me something!` + '\n***\n' + t`**Hint:** Set any character as your welcome page assistant from their "More..." menu.`;

    if (!character) {
        return defaultGreeting;
    }

    return getRegexedString(character.first_mes || '', regex_placement.AI_OUTPUT, { depth: 0 }) || defaultGreeting;
}

function sendAssistantMessage() {
    const currentAssistantAvatar = getPermanentAssistantAvatar();
    const character = characters.find(x => x.avatar === currentAssistantAvatar);
    const name = character ? character.name : neutralCharacterName;
    const avatar = character ? getThumbnailUrl('avatar', character.avatar) : system_avatar;
    const greeting = getAssistantGreeting(character);

    const message = {
        name: name,
        force_avatar: avatar,
        mes: greeting,
        is_system: false,
        is_user: false,
        send_date: getMessageTimeStamp(),
        extra: {
            type: system_message_types.ASSISTANT_MESSAGE,
            swipeable: false,
        },
    };

    chat.push(message);
    addOneMessage(message, { scroll: false });
}

function sendWelcomePrompt() {
    const message = getSystemMessageByType(system_message_types.WELCOME_PROMPT);
    chat.push(message);
    addOneMessage(message, { scroll: false });
}

/**
 * Gets character data for welcome panel display
 * @param {number} page Current page number (1-based)
 * @returns {object} Character display data
 */
function getWelcomeCharactersData(page = 1) {
    const totalCharacters = characters.length;
    const totalPages = Math.ceil(totalCharacters / CHARACTERS_PER_PAGE) || 1;
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (currentPage - 1) * CHARACTERS_PER_PAGE;
    const endIndex = Math.min(startIndex + CHARACTERS_PER_PAGE, totalCharacters);

    const displayCharacters = characters.slice(startIndex, endIndex).map((char, idx) => ({
        index: startIndex + idx,
        avatar: char.avatar,
        name: char.name,
        // 卡片尺寸的缩略图（默认 360×540）：高清屏也清晰，原图动辄几 MB，国内加载很慢
        avatarUrl: char.avatar && char.avatar !== 'none' ? getThumbnailUrl('card', char.avatar) : '/img/default-expressions/neutral.png',
    }));

    return {
        displayCharacters,
        characterCount: totalCharacters,
        noCharacters: totalCharacters === 0,
        hasMorePages: totalPages > 1,
        currentPage,
        totalPages,
        canGoPrev: currentPage > 1,
        canGoNext: currentPage < totalPages,
    };
}

/**
 * 仅刷新角色卡网格与分页控件 DOM（零 API 请求，单帧内完成）。
 * 用于角色卡翻页，避免整页重建与 /api/chats/recent 全量磁盘扫描。
 * DOM 结构与 welcomePanel 模板保持一致，并复用现有懒加载机制。
 */
function renderCharactersGridOnly() {
    const gridContainer = document.getElementById('welcomeCharactersGrid');
    if (!gridContainer) {
        return;
    }

    const { displayCharacters, noCharacters, totalPages, canGoPrev, canGoNext, currentPage } = getWelcomeCharactersData(welcomeCharactersCurrentPage);

    // 清空旧网格
    gridContainer.innerHTML = '';

    // 使用 DOM API 构建（避免角色名等用户可控数据造成 XSS）
    if (noCharacters) {
        const empty = document.createElement('div');
        empty.className = 'noCharacters';

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-user-plus';

        const span = document.createElement('span');
        span.textContent = '暂无角色卡';

        const small = document.createElement('small');
        small.textContent = '从角色管理页面创建或导入角色卡';

        empty.append(icon, span, small);
        gridContainer.append(empty);
    } else {
        const fragment = document.createDocumentFragment();
        displayCharacters.forEach((char) => {
            const card = document.createElement('div');
            card.className = 'welcomeCharacterCard';
            card.setAttribute('data-chid', String(char.index));
            card.setAttribute('data-avatar', char.avatar || '');
            card.setAttribute('title', char.name);

            const avatarWrap = document.createElement('div');
            avatarWrap.className = 'welcomeCharacterAvatar';

            const img = document.createElement('img');
            img.className = 'characterImage lazy-load';
            img.setAttribute('data-src', char.avatarUrl);
            img.loading = 'lazy';
            img.decoding = 'async';
            img.fetchPriority = 'low';
            img.width = 96;
            img.height = 144;
            img.alt = char.name;
            img.src = '/img/default-expressions/neutral.png';
            img.onerror = function () { this.onerror = null; this.src = '/img/default-expressions/neutral.png'; };

            const placeholder = document.createElement('div');
            placeholder.className = 'imagePlaceholder';
            const placeholderIcon = document.createElement('i');
            placeholderIcon.className = 'fa-solid fa-image';
            placeholder.append(placeholderIcon);

            avatarWrap.append(img, placeholder);

            const nameEl = document.createElement('div');
            nameEl.className = 'welcomeCharacterName';
            nameEl.textContent = char.name;

            card.append(avatarWrap, nameEl);
            fragment.append(card);
        });
        gridContainer.append(fragment);
    }

    // 重新绑定点击卡片进入聊天事件
    gridContainer.querySelectorAll('.welcomeCharacterCard').forEach((card) => {
        card.addEventListener('click', async () => {
            const chid = card.getAttribute('data-chid');
            if (chid !== null) {
                await selectCharacterById(Number(chid));
            }
        });
    });

    // 重新初始化懒加载（IntersectionObserver + HTTP 缓存，零额外 API）
    initLazyLoadCharacters(gridContainer);

    // 更新分页按钮禁用状态与页码文本
    const prevBtn = document.querySelector('.characterPagePrev');
    const nextBtn = document.querySelector('.characterPageNext');
    const pageInfo = document.querySelector('.characterPageInfo');
    if (prevBtn) prevBtn.disabled = !canGoPrev;
    if (nextBtn) nextBtn.disabled = !canGoNext;
    if (pageInfo) pageInfo.textContent = `${currentPage} / ${totalPages}`;
}

/** 欢迎页可以收起的两块：「最近聊天」「我的角色卡」（按账号记住；角色卡收起时不加载图片） */
const COLLAPSIBLE_SECTIONS = [
    { selector: '.welcomeRecent', key: 'WelcomePage_RecentCollapsed' },
    { selector: '.welcomeCharacters', key: 'WelcomePage_CharactersCollapsed' },
];

/**
 * 点标题或右边的箭头收起/展开，收起后只留标题行。
 * @param {Element} root 欢迎面板
 */
function initCollapsibleSections(root) {
    for (const { selector, key } of COLLAPSIBLE_SECTIONS) {
        const section = root.querySelector(selector);
        if (!section) {
            continue;
        }
        const toggle = section.querySelector('.welcomeSectionToggle');
        const apply = (collapsed) => {
            section.classList.toggle('collapsed', collapsed);
            toggle?.setAttribute('aria-expanded', String(!collapsed));
            toggle?.setAttribute('title', collapsed ? '展开' : '收起');
        };
        const flip = () => {
            const collapsed = !section.classList.contains('collapsed');
            apply(collapsed);
            accountStorage.setItem(key, String(collapsed));
        };
        apply(accountStorage.getItem(key) === 'true');
        toggle?.addEventListener('click', (event) => {
            event.stopPropagation();
            flip();
        });
        section.querySelector('.welcomeSectionTitle')?.addEventListener('click', flip);
    }
}

/**
 * Sends the welcome panel to the chat.
 * @param {RecentChat[]} chats List of recent chats
 * @param {boolean} [expand=false] If true, expands the recent chats section
 */
async function sendWelcomePanel(chats, expand = false) {
    try {
        const chatElement = document.getElementById('chat');
        const sendTextArea = document.getElementById('send_textarea');
        if (!chatElement) {
            console.error('Chat element not found');
            return;
        }

        // 获取角色卡数据
        const charactersData = getWelcomeCharactersData(welcomeCharactersCurrentPage);

        const templateData = {
            chats,
            empty: !chats.length,
            version: displayVersion,
            more: chats.some(chat => chat.hidden),
            ...charactersData,
        };
        const template = await renderTemplateAsync('welcomePanel', templateData);
        const fragment = document.createRange().createContextualFragment(template);
        fragment.querySelectorAll('.welcomePanel').forEach((root) => {
            initCollapsibleSections(root);
            root.querySelectorAll('.recentChatsSettings').forEach((button) => {
                button.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    await openRecentChatsSettingsPopup();
                });
            });
        });
        fragment.querySelectorAll('.recentChat').forEach((item) => {
            item.addEventListener('click', () => {
                const avatarId = item.getAttribute('data-avatar');
                const groupId = item.getAttribute('data-group');
                const fileName = item.getAttribute('data-file');
                if (!fileName || (!avatarId && !groupId)) {
                    return;
                }
                void runRecentChatTransition({
                    card: item,
                    openChat: () => avatarId
                        ? openRecentCharacterChat(avatarId, fileName)
                        : openRecentGroupChat(groupId, fileName),
                    getTarget: getRecentChatMotionTarget,
                });
            });
        });
        const hiddenChats = fragment.querySelectorAll('.recentChat.hidden');
        fragment.querySelectorAll('button.showMoreChats').forEach((button) => {
            const showRecentChatsTitle = t`Show more recent chats`;
            const hideRecentChatsTitle = t`Show less recent chats`;

            button.setAttribute('title', showRecentChatsTitle);
            button.addEventListener('click', () => {
                const expanded = !button.classList.contains('rotated');
                button.classList.toggle('rotated', expanded);
                button.setAttribute('title', expanded ? hideRecentChatsTitle : showRecentChatsTitle);
                void runShowMoreTransition({ items: hiddenChats, expanded });
            });
        });
        fragment.querySelectorAll('button.openTemporaryChat').forEach((button) => {
            button.addEventListener('click', async () => {
                await newAssistantChat({ temporary: true });
                if (sendTextArea instanceof HTMLTextAreaElement) {
                    sendTextArea.focus();
                }
            });
        });

        // 角色卡点击事件 - 点击后直接进入聊天
        fragment.querySelectorAll('.welcomeCharacterCard').forEach((card) => {
            card.addEventListener('click', async () => {
                const chid = card.getAttribute('data-chid');
                if (chid !== null) {
                    await selectCharacterById(Number(chid));
                }
            });
        });

        // 初始化角色卡延迟加载
        initLazyLoadCharacters(fragment);

        // 角色卡分页事件
        fragment.querySelectorAll('.characterPagePrev').forEach((button) => {
            button.addEventListener('click', async () => {
                if (welcomeCharactersCurrentPage > 1) {
                    welcomeCharactersCurrentPage--;
                    renderCharactersGridOnly();
                }
            });
        });

        fragment.querySelectorAll('.characterPageNext').forEach((button) => {
            button.addEventListener('click', async () => {
                const totalPages = Math.ceil(characters.length / CHARACTERS_PER_PAGE) || 1;
                if (welcomeCharactersCurrentPage < totalPages) {
                    welcomeCharactersCurrentPage++;
                    renderCharactersGridOnly();
                }
            });
        });
        fragment.querySelectorAll('.recentChat.group').forEach((groupChat) => {
            const groupId = groupChat.getAttribute('data-group');
            const group = groups.find(x => x.id === groupId);
            if (group) {
                const avatar = groupChat.querySelector('.avatar');
                if (!avatar) {
                    return;
                }
                const groupAvatar = getGroupAvatar(group);
                $(avatar).replaceWith(groupAvatar);
            }
        });
        fragment.querySelectorAll('.recentChat .renameChat').forEach((renameButton) => {
            renameButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = renameButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                if (avatarId && fileName) {
                    void renameRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void renameRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('.recentChat .deleteChat').forEach((deleteButton) => {
            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                const chatItem = deleteButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                if (avatarId && fileName) {
                    void deleteRecentCharacterChat(avatarId, fileName);
                }
                if (groupId && fileName) {
                    void deleteRecentGroupChat(groupId, fileName);
                }
            });
        });
        fragment.querySelectorAll('.recentChat .pinChat').forEach((pinButton) => {
            pinButton.addEventListener('click', async (event) => {
                event.stopPropagation();
                const chatItem = pinButton.closest('.recentChat');
                if (!chatItem) {
                    return;
                }
                const avatarId = chatItem.getAttribute('data-avatar');
                const groupId = chatItem.getAttribute('data-group');
                const fileName = chatItem.getAttribute('data-file');
                const recentChat = chats.find(c => c.chat_name === fileName && ((c.is_group && c.group === groupId) || (!c.is_group && c.avatar === avatarId)));
                if (!recentChat) {
                    console.error('Recent chat not found for pinning.');
                    return;
                }
                const currentlyPinned = PinnedChatsManager.isPinned(recentChat);
                PinnedChatsManager.toggle(recentChat, !currentlyPinned);
                await refreshWelcomeScreen({ flashChat: recentChat });
            });
        });
        chatElement.append(fragment.firstChild);
        if (expand) {
            chatElement.querySelectorAll('button.showMoreChats').forEach((button) => {
                if (button instanceof HTMLButtonElement) {
                    button.click();
                }
            });
        }
    } catch (error) {
        console.error('Welcome screen error:', error);
    }
}

function getRecentChatMotionTarget() {
    const messages = [...document.querySelectorAll('#chat > .mes')];
    const targetMessage = messages.reverse().find(message => message.getAttribute('is_user') !== 'true');
    if (!targetMessage) {
        return null;
    }
    return {
        avatar: targetMessage.querySelector('.avatar'),
        name: targetMessage.querySelector('.name_text'),
    };
}

/**
 * Opens a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function openRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }

    try {
        await selectCharacterById(characterId);
        setActiveCharacter(avatarId);
        saveSettingsDebounced();
        const currentChatId = getCurrentChatId();
        if (currentChatId === fileName) {
            console.debug(`Chat ${fileName} is already open.`);
            return;
        }
        await openCharacterChat(fileName);
    } catch (error) {
        console.error('Error opening recent chat:', error);
        toastr.error(t`Failed to open recent chat. See console for details.`);
    }
}

/**
 * Opens a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function openRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }

    try {
        await openGroupById(groupId);
        setActiveGroup(groupId);
        saveSettingsDebounced();
        const currentChatId = getCurrentChatId();
        if (currentChatId === fileName) {
            console.debug(`Chat ${fileName} is already open.`);
            return;
        }
        await openGroupChat(groupId, fileName);
    } catch (error) {
        console.error('Error opening recent group chat:', error);
        toastr.error(t`Failed to open recent group chat. See console for details.`);
    }
}

/**
 * Renames a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function renameRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, fileName);
        if (!newName || typeof newName !== 'string' || newName === fileName) {
            console.log('No new name provided, aborting');
            return;
        }
        await renameGroupOrCharacterChat({
            characterId: String(characterId),
            oldFileName: fileName,
            newFileName: newName,
            loader: false,
        });
        await updateRemoteChatName(characterId, newName);
        await refreshWelcomeScreen();
        toastr.success(t`Chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent character chat:', error);
        toastr.error(t`Failed to rename recent chat. See console for details.`);
    }
}

/**
 * Renames a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function renameRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }
    try {
        const popupText = await renderTemplateAsync('chatRename');
        const newName = await callGenericPopup(popupText, POPUP_TYPE.INPUT, fileName);
        if (!newName || newName === fileName) {
            console.log('No new name provided, aborting');
            return;
        }
        await renameGroupOrCharacterChat({
            groupId: String(groupId),
            oldFileName: fileName,
            newFileName: String(newName),
            loader: false,
        });
        await refreshWelcomeScreen();
        toastr.success(t`Group chat renamed.`);
    } catch (error) {
        console.error('Error renaming recent group chat:', error);
        toastr.error(t`Failed to rename recent group chat. See console for details.`);
    }
}

/**
 * Deletes a recent character chat.
 * @param {string} avatarId Avatar file name
 * @param {string} fileName Chat file name
 */
async function deleteRecentCharacterChat(avatarId, fileName) {
    const characterId = characters.findIndex(x => x.avatar === avatarId);
    if (characterId === -1) {
        console.error(`Character not found for avatar ID: ${avatarId}`);
        return;
    }
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            console.log('Deletion cancelled by user');
            return;
        }
        await deleteCharacterChatByName(String(characterId), fileName);
        await refreshWelcomeScreen();
        toastr.success(t`Chat deleted.`);
    } catch (error) {
        console.error('Error deleting recent character chat:', error);
        toastr.error(t`Failed to delete recent chat. See console for details.`);
    }
}

/**
 * Deletes a recent group chat.
 * @param {string} groupId Group ID
 * @param {string} fileName Chat file name
 */
async function deleteRecentGroupChat(groupId, fileName) {
    const group = groups.find(x => x.id === groupId);
    if (!group) {
        console.error(`Group not found for ID: ${groupId}`);
        return;
    }
    try {
        const confirm = await callGenericPopup(t`Delete the Chat File?`, POPUP_TYPE.CONFIRM);
        if (!confirm) {
            console.log('Deletion cancelled by user');
            return;
        }
        await deleteGroupChatByName(groupId, fileName);
        await refreshWelcomeScreen();
        toastr.success(t`Group chat deleted.`);
    } catch (error) {
        console.error('Error deleting recent group chat:', error);
        toastr.error(t`Failed to delete recent group chat. See console for details.`);
    }
}

/**
 * Reopens the welcome screen and restores the scroll position.
 * @param {object} param Additional parameters
 * @param {RecentChat} [param.flashChat] Recent chat to flash (if any)
 * @returns {Promise<void>}
 */
async function refreshWelcomeScreen({ flashChat = null } = {}) {
    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        console.error('Chat element not found');
        return;
    }

    const scrollTop = chatElement.scrollTop;
    const scrollHeight = chatElement.scrollHeight;
    const expand = chatElement.querySelectorAll('button.showMoreChats.rotated').length > 0;

    await openWelcomeScreen({ force: true, expand });

    // Restore scroll position or flash specific chat
    if (flashChat) {
        const recentChats = Array.from(chatElement.querySelectorAll('.recentChat'));
        const chatToFlash = recentChats.find(el => {
            const file = el.getAttribute('data-file');
            const group = el.getAttribute('data-group');
            const avatar = el.getAttribute('data-avatar');
            return file === flashChat.chat_name &&
                ((flashChat.is_group && group === flashChat.group) || (!flashChat.is_group && avatar === flashChat.avatar));
        });
        if (chatToFlash instanceof HTMLElement) {
            if (!isElementInViewport(chatToFlash)) {
                chatElement.scrollTop = chatToFlash.offsetTop - chatElement.offsetTop - (chatToFlash.clientHeight / 2);
            }
            flashHighlight($(chatToFlash), 1000);
        }
    } else {
        // Restore scroll position
        chatElement.scrollTop = scrollTop + (chatElement.scrollHeight - scrollHeight);
    }
}

/**
 * Opens a popup to configure recent chats settings.
 */
async function openRecentChatsSettingsPopup() {
    const settings = getRecentChatsSettings();

    const MIN_CHATS = 1;
    const MAX_CHATS = 1000;

    /** @type {import('./popup.js').CustomPopupInput} */
    const maxRecentChatsInput = {
        id: 'maxRecentChats',
        type: 'number',
        label: t`Max recent chats`,
        tooltip: t`${MIN_CHATS} - ${MAX_CHATS}`,
        defaultState: String(settings.maxDisplayed),
        min: MIN_CHATS,
        max: MAX_CHATS,
        step: 1,
    };

    /** @type {import('./popup.js').CustomPopupInput} */
    const collapsedRecentChatsInput = {
        id: 'collapsedRecentChats',
        type: 'number',
        label: t`Collapsed recent chats`,
        tooltip: t`${MIN_CHATS} - ${MAX_CHATS}`,
        defaultState: String(settings.collapsedDisplayed),
        min: MIN_CHATS,
        max: MAX_CHATS,
        step: 1,
    };

    await callGenericPopup(t`Recent Chats Settings`, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        customInputs: [maxRecentChatsInput, collapsedRecentChatsInput],
        onClose: (popup) => {
            if (!popup.result) {
                return;
            }

            const maxInputValue = popup.inputResults.get(maxRecentChatsInput.id)?.toString() ?? String(DEFAULT_MAX_DISPLAYED);
            const collapsedInputValue = popup.inputResults.get(collapsedRecentChatsInput.id)?.toString() ?? String(DEFAULT_COLLAPSED_DISPLAYED);

            const newMax = clamp(parseInt(maxInputValue) || DEFAULT_MAX_DISPLAYED, maxRecentChatsInput.min, maxRecentChatsInput.max);
            const newCollapsed = clamp(parseInt(collapsedInputValue) || DEFAULT_COLLAPSED_DISPLAYED, collapsedRecentChatsInput.min, newMax);

            saveRecentChatsSettings({ maxDisplayed: newMax, collapsedDisplayed: newCollapsed });
        },
    });

    await refreshWelcomeScreen();
}

/**
 * Gets the list of recent chats from the server.
 * @returns {Promise<RecentChat[]>} List of recent chats
 *
 * @typedef {object} RecentChat
 * @property {string} file_name Name of the chat file
 * @property {string} chat_name Name of the chat (without extension)
 * @property {string} file_size Size of the chat file
 * @property {number} chat_items Number of items in the chat
 * @property {string} mes Last message content
 * @property {string} last_mes Timestamp of the last message
 * @property {string} avatar Avatar URL
 * @property {string} char_thumbnail Thumbnail URL
 * @property {string} char_name Character or group name
 * @property {string} date_short Date in short format
 * @property {string} date_long Date in long format
 * @property {string} group Group ID (if applicable)
 * @property {boolean} is_group Indicates if the chat is a group chat
 * @property {boolean} hidden Chat will be hidden by default
 * @property {boolean} pinned Indicates if the chat is pinned
 */
async function getRecentChats() {
    const settings = getRecentChatsSettings();
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ max: settings.maxDisplayed, pinned: PinnedChatsManager.getAll() }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        console.warn('Failed to fetch recent character chats');
        return [];
    }

    /** @type {RecentChat[]} */
    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        return [];
    }

    const dataWithEntities = data
        .map(chat => ({ chat, character: characters.find(x => x.avatar === chat.avatar), group: groups.find(x => x.id === chat.group) }))
        .filter(t => t.character || t.group)
        .sort((a, b) => {
            const isAPinned = PinnedChatsManager.isPinned(a.chat);
            const isBPinned = PinnedChatsManager.isPinned(b.chat);
            const momentComparison = sortMoments(timestampToMoment(a.chat.last_mes), timestampToMoment(b.chat.last_mes));

            if (isAPinned && !isBPinned) {
                return -1;
            }
            if (!isAPinned && isBPinned) {
                return 1;
            }

            return momentComparison;
        });

    dataWithEntities.forEach(({ chat, character, group }, index) => {
        const chatTimestamp = timestampToMoment(chat.last_mes);
        chat.char_name = character?.name || group?.name || '';
        chat.date_short = chatTimestamp.format('l');
        chat.date_long = chatTimestamp.format('LL LT');
        chat.chat_name = chat.file_name.replace('.jsonl', '');
        chat.char_thumbnail = character ? getThumbnailUrl('avatar', character.avatar) : system_avatar;
        chat.is_group = !!group;
        chat.hidden = index >= settings.collapsedDisplayed;
        chat.avatar = chat.avatar || '';
        chat.group = chat.group || '';
        chat.pinned = PinnedChatsManager.isPinned(chat);
    });

    return dataWithEntities.map(t => t.chat);
}

export async function openPermanentAssistantChat({ tryCreate = true, created = false } = {}) {
    const avatar = getPermanentAssistantAvatar();
    const characterId = characters.findIndex(x => x.avatar === avatar);
    if (characterId === -1) {
        if (!tryCreate) {
            console.error(`Character not found for avatar ID: ${avatar}. Cannot create.`);
            return;
        }

        try {
            console.log(`Character not found for avatar ID: ${avatar}. Creating new assistant.`);
            await createPermanentAssistant();
            return openPermanentAssistantChat({ tryCreate: false, created: true });
        } catch (error) {
            console.error('Error creating permanent assistant:', error);
            toastr.error(t`Failed to create ${neutralCharacterName}. See console for details.`);
            return;
        }
    }

    try {
        await selectCharacterById(characterId);
        if (!created) {
            await doNewChat({ deleteCurrentChat: false });
        }
        console.log(`Opened permanent assistant chat for ${neutralCharacterName}.`, getCurrentChatId());
    } catch (error) {
        console.error('Error opening permanent assistant chat:', error);
        toastr.error(t`Failed to open permanent assistant chat. See console for details.`);
    }
}

async function createPermanentAssistant() {
    if (is_group_generating || is_send_press) {
        throw new Error(t`Cannot create while generating.`);
    }

    const formData = new FormData();
    formData.append('ch_name', neutralCharacterName);
    formData.append('file_name', defaultAssistantAvatar.replace('.png', ''));
    formData.append('creator_notes', t`Automatically created character. Feel free to edit.`);

    try {
        const avatarResponse = await fetch(system_avatar);
        const avatarBlob = await avatarResponse.blob();
        formData.append('avatar', avatarBlob, defaultAssistantAvatar);
    } catch (error) {
        console.warn('Error fetching system avatar. Fallback image will be used.', error);
    }

    const fetchResult = await fetch('/api/characters/create', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (!fetchResult.ok) {
        throw new Error(t`Creation request did not succeed.`);
    }

    await getCharacters();
}

export async function openPermanentAssistantCard() {
    const avatar = getPermanentAssistantAvatar();
    const characterId = characters.findIndex(x => x.avatar === avatar);
    if (characterId === -1) {
        toastr.info(t`Assistant not found. Try sending a chat message.`);
        return;
    }

    await selectCharacterById(characterId);
}

/**
 * Assigns a character as the assistant.
 * @param {string?} characterId Character ID
 */
export function assignCharacterAsAssistant(characterId) {
    if (characterId === undefined) {
        return;
    }
    /** @type {Character} */
    const character = characters[characterId];
    if (!character) {
        return;
    }

    const currentAssistantAvatar = getPermanentAssistantAvatar();
    if (currentAssistantAvatar === character.avatar) {
        if (character.avatar === defaultAssistantAvatar) {
            toastr.info(t`${character.name} is a system assistant. Choose another character.`);
            return;
        }

        toastr.info(t`${character.name} is no longer your assistant.`);
        accountStorage.removeItem(assistantAvatarKey);
        return;
    }

    accountStorage.setItem(assistantAvatarKey, character.avatar);
    printCharactersDebounced();
    toastr.success(t`Set ${character.name} as your assistant.`);
}

function scheduleLegacyImageCacheCleanup() {
    if (legacyImageCacheCleanupScheduled) {
        return;
    }
    legacyImageCacheCleanupScheduled = true;

    const run = () => cleanupLegacyWelcomeImageCache()
        .catch(error => console.warn('Failed to remove legacy character image cache:', error));
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(run, { timeout: 2000 });
    } else {
        setTimeout(run, 0);
    }
}

/**
 * 初始化角色卡延迟加载（使用浏览器私有 HTTP 缓存）
 * @param {DocumentFragment} fragment 模板片段
 */
function initLazyLoadCharacters(fragment) {
    const lazyImages = fragment.querySelectorAll('.characterImage.lazy-load');

    if (lazyImages.length === 0) {
        return;
    }

    if (typeof IntersectionObserver !== 'function') {
        lazyImages.forEach((img) => {
            if (img instanceof HTMLImageElement) {
                loadWelcomeCharacterImage(img, img.getAttribute('data-src'));
            }
        });
        return;
    }

    // 使用 Intersection Observer API 实现延迟加载
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                const img = entry.target;
                if (!(img instanceof HTMLImageElement)) {
                    return;
                }
                const dataSrc = img.getAttribute('data-src');

                if (dataSrc) {
                    loadWelcomeCharacterImage(img, dataSrc);
                    observer.unobserve(img);
                }
            }
        });
    }, {
        // 提前一小段视口加载，兼顾移动端滚动与网络预算。
        rootMargin: '400px 0px 600px 0px',
        threshold: 0.01,
    });

    // 观察所有需要延迟加载的图片
    lazyImages.forEach((img) => {
        imageObserver.observe(img);
    });

    // 角色卡那块收起着：一张都不先加载，展开后按视口再加载
    if (lazyImages[0].closest('.welcomeCharacters.collapsed')) {
        return;
    }

    // 前几张图片立即开始加载（分批避免阻塞）
    const immediateLoadCount = 5;  // 一页5张全部预加载
    lazyImages.forEach((img, index) => {
        if (index < immediateLoadCount && img instanceof HTMLImageElement) {
            // 分批加载，每张间隔50ms，避免阻塞
            setTimeout(() => {
                const dataSrc = img.getAttribute('data-src');
                if (dataSrc && img.classList.contains('lazy-load')) {
                    loadWelcomeCharacterImage(img, dataSrc);
                    imageObserver.unobserve(img);
                }
            }, 50 * index); // 第一张立即加载，后续每张延迟50ms
        }
    });
}

export function initWelcomeScreen() {
    PinnedChatsManager.init();
    scheduleLegacyImageCacheCleanup();

    const events = [event_types.CHAT_CHANGED, event_types.APP_READY];
    for (const event of events) {
        eventSource.makeFirst(event, openWelcomeScreen);
    }

    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (target) => {
        if (target !== 'set_as_assistant') {
            return;
        }
        assignCharacterAsAssistant(this_chid);
    });

    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        if (oldAvatar === getPermanentAssistantAvatar()) {
            accountStorage.setItem(assistantAvatarKey, newAvatar);
        }
    });

    eventSource.on(event_types.CHAT_RENAMED, async ({ avatarId, groupId, oldFileName, newFileName }) => {
        PinnedChatsManager.rename({ avatar: avatarId, group: groupId, file_name: oldFileName }, newFileName);
    });
}

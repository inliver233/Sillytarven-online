// 公告弹窗功能
import { renderAnnouncementMarkdownInto } from './announcement-markdown.js';
import { parseSeen, SEEN_ANNOUNCEMENTS_KEY, serializeSeen, unseenAnnouncements } from './announcement-seen.js';
import { eventSource, event_types } from './events.js';
import { accountStorage } from './util/AccountStorage.js';

let announcementsChecked = false; // 防止重复检查
/** 当前启用的公告和这次弹出的公告，点「我知道了」时记下 */
let currentAnnouncements = [];
let shownAnnouncements = [];

// 初始化公告系统：等设置加载完（APP_READY）才知道用户看过哪些
function initializeAnnouncements() {
    eventSource.on(event_types.APP_READY, () => {
        if (announcementsChecked) {
            return;
        }
        announcementsChecked = true;
        checkDailyAnnouncements();
    });
}

// 检查并显示公告：没确认过当前版本的才弹
async function checkDailyAnnouncements() {
    try {
        // 每次都获取并显示公告，不再检查时间限制
        await fetchAndShowAnnouncements();
    } catch (error) {
        console.error('Error checking announcements:', error);
    }
}

// 获取并显示公告
async function loadEnabledAnnouncements() {
    const response = await fetch('/api/announcements/current', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch announcements: ${response.status}`);
    }

    const announcements = await response.json();
    // 筛选有效的公告（仅检查启用状态）
    return announcements.filter(announcement => announcement.enabled);
}

/** ☰ 菜单 →「系统公告」：显示全部公告，已经确认过的也显示 */
export async function openAnnouncements() {
    try {
        const validAnnouncements = await loadEnabledAnnouncements();
        if (validAnnouncements.length === 0) {
            toastr.info('暂时没有公告');
            return;
        }
        currentAnnouncements = validAnnouncements;
        shownAnnouncements = validAnnouncements;
        showAnnouncementsPopup(validAnnouncements);
    } catch (error) {
        console.error('Error opening announcements:', error);
        toastr.error('公告加载失败，请稍后再试');
    }
}

async function fetchAndShowAnnouncements() {
    try {
        const validAnnouncements = await loadEnabledAnnouncements();
        const unseen = unseenAnnouncements(validAnnouncements, parseSeen(accountStorage.getItem(SEEN_ANNOUNCEMENTS_KEY)));

        if (unseen.length > 0) {
            currentAnnouncements = validAnnouncements;
            shownAnnouncements = unseen;
            showAnnouncementsPopup(unseen);
        }
    } catch (error) {
        console.error('Error fetching announcements:', error);
    }
}

// 显示公告弹窗
function showAnnouncementsPopup(announcements) {
    // 如果已经有公告弹窗，直接返回，避免重复显示
    const existingPopup = document.getElementById('announcementsPopup');
    if (existingPopup) {
        return;
    }

    // 创建弹窗HTML
    const popupHtml = createAnnouncementsPopupHtml(announcements);

    // 添加到页面
    document.body.insertAdjacentHTML('beforeend', popupHtml);

    // 渲染 Markdown 内容
    document.querySelectorAll('#announcementsPopup .announcement-content').forEach((element, index) => {
        renderAnnouncementMarkdownInto(element, announcements[index]?.content);
        pinTrailingButtons(element);
        element.addEventListener('scroll', () => updateScrollFade(element), { passive: true });
    });

    // 绑定事件
    bindAnnouncementPopupEvents();

    // 显示弹窗
    const popup = document.getElementById('announcementsPopup');
    if (popup) {
        popup.style.display = 'flex';
        // 全部默认收起（按钮仍可见），点标题展开
        popup.querySelectorAll('.announcement-item').forEach(item => setAnnouncementExpanded(item, false));
        fitAnnouncementsToPopup(popup);
        refreshScrollFades(popup);
        // 添加动画效果
        setTimeout(() => {
            popup.classList.add('show');
        }, 10);
    }
}

// 创建公告弹窗HTML
function createAnnouncementsPopupHtml(announcements) {
    // 默认全部展开；放不下时由 fitAnnouncementsToPopup 把较早的收成一行标题。
    const announcementsHtml = announcements.map((announcement) => `
        <div class="announcement-item">
            <button type="button" class="announcement-header" aria-expanded="true">
                <span class="announcement-title">${escapeHtml(announcement.title)}</span>
                <small class="announcement-time">${new Date(announcement.createdAt).toLocaleDateString('zh-CN')}</small>
                <i class="fa-solid fa-chevron-down announcement-chevron" aria-hidden="true"></i>
            </button>
            <div class="announcement-content"></div>
        </div>
    `).join('');

    return `
        <div id="announcementsPopup" class="announcements-popup-overlay">
            <div class="announcements-popup">
                <div class="announcements-popup-header">
                    <h2><i class="fa-solid fa-bullhorn"></i> 系统公告</h2>
                    <button type="button" class="announcements-close-btn" id="closeAnnouncementsPopup">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="announcements-popup-content">
                    ${announcementsHtml}
                </div>
                <div class="announcements-popup-footer">
                    <button type="button" class="announcements-confirm-btn" id="confirmAnnouncementsPopup">
                        我知道了
                    </button>
                    <small class="announcements-confirm-hint">内容更新后会再提醒你</small>
                </div>
            </div>
        </div>
    `;
}

/**
 * 公告末尾只有按钮的那一段移到正文外、固定在卡片底部：正文需要滚动时按钮也始终可见。
 * @param {HTMLElement} content 公告正文容器
 */
function pinTrailingButtons(content) {
    const last = content.lastElementChild;
    if (!last || last.tagName !== 'P') {
        return;
    }
    const buttons = [...last.querySelectorAll('a.announcement-button')];
    const onlyButtons = buttons.length > 0 && [...last.childNodes].every(node =>
        buttons.includes(node) || (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) || node.nodeName === 'BR');
    if (!onlyButtons) {
        return;
    }
    const actions = document.createElement('div');
    actions.className = 'announcement-actions announcement-markdown';
    actions.append(...buttons);
    last.remove();
    content.after(actions);
}

function refreshScrollFades(popup) {
    popup.querySelectorAll('.announcement-content').forEach(updateScrollFade);
}

/** 正文还能往下滚时在底部加一层渐隐，提示还有内容。 */
function updateScrollFade(content) {
    const more = content.scrollHeight - content.clientHeight - content.scrollTop > 4;
    content.classList.toggle('has-more', more);
}

function setAnnouncementExpanded(item, expanded) {
    item.classList.toggle('collapsed', !expanded);
    item.querySelector('.announcement-header')?.setAttribute('aria-expanded', String(expanded));
}

/** 所有展开的公告都完整显示（没有被压缩成需要滚动），且整体没有溢出。 */
function announcementsFit(popup) {
    const body = popup.querySelector('.announcements-popup-content');
    if (!body || body.scrollHeight > body.clientHeight + 1) {
        return false;
    }
    return [...popup.querySelectorAll('.announcement-item:not(.collapsed) .announcement-content')]
        .every(content => content.scrollHeight <= content.clientHeight + 1);
}

/** 放不下时从最早的公告开始收起，最新一条始终展开。 */
function fitAnnouncementsToPopup(popup) {
    const items = [...popup.querySelectorAll('.announcement-item')];
    for (let index = items.length - 1; index > 0 && !announcementsFit(popup); index--) {
        setAnnouncementExpanded(items[index], false);
    }
}

// 绑定公告弹窗事件
function bindAnnouncementPopupEvents() {
    const popup = document.getElementById('announcementsPopup');
    const closeBtn = document.getElementById('closeAnnouncementsPopup');
    const confirmBtn = document.getElementById('confirmAnnouncementsPopup');

    if (closeBtn) {
        closeBtn.addEventListener('click', closeAnnouncementsPopup);
    }

    // 「我知道了」记住看过的版本；✕、点外面、Esc 只关这一次，下次还弹
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            markAnnouncementsSeen();
            closeAnnouncementsPopup();
        });
    }

    // 点击标题展开/收起；展开后放不下时，把其他展开的公告收起，保证内容完整可读
    const headers = popup ? [...popup.querySelectorAll('.announcement-header')] : [];
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const item = header.closest('.announcement-item');
            const expand = item.classList.contains('collapsed');
            setAnnouncementExpanded(item, expand);
            if (expand && !announcementsFit(popup)) {
                for (const other of popup.querySelectorAll('.announcement-item:not(.collapsed)')) {
                    if (other !== item) {
                        setAnnouncementExpanded(other, false);
                    }
                }
            }
            refreshScrollFades(popup);
        });
    });

    // 点击遮罩层关闭
    if (popup) {
        popup.addEventListener('click', function(e) {
            if (e.target === popup) {
                closeAnnouncementsPopup();
            }
        });
    }

    // ESC键关闭
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.getElementById('announcementsPopup')) {
            closeAnnouncementsPopup();
        }
    });
}

function markAnnouncementsSeen() {
    const seen = parseSeen(accountStorage.getItem(SEEN_ANNOUNCEMENTS_KEY));
    accountStorage.setItem(SEEN_ANNOUNCEMENTS_KEY, serializeSeen(currentAnnouncements, seen, shownAnnouncements));
}

// 关闭公告弹窗
function closeAnnouncementsPopup() {
    const popup = document.getElementById('announcementsPopup');
    if (popup) {
        popup.classList.remove('show');
        setTimeout(() => {
            popup.remove();
        }, 300);
    }
}

// HTML转义函数
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// 导出函数到全局作用域
if (typeof window !== 'undefined') {
    window.checkDailyAnnouncements = checkDailyAnnouncements;
    window.fetchAndShowAnnouncements = fetchAndShowAnnouncements;
}

// 自动初始化
initializeAnnouncements();

// 公告弹窗功能
import { renderAnnouncementMarkdownInto } from './announcement-markdown.js';

let announcementsChecked = false; // 防止重复检查

// 初始化公告系统
function initializeAnnouncements() {
    // 如果已经检查过，直接返回
    if (announcementsChecked) {
        return;
    }

    // 检查用户是否已登录并显示公告
    const checkUserAndAnnouncements = () => {
        // 检查多种登录状态指示器
        const isLoggedIn = document.querySelector('#logout_button') ||
                          document.querySelector('#account_controls') ||
                          window.currentUser;

        if (isLoggedIn) {
            announcementsChecked = true; // 标记已检查
            checkDailyAnnouncements();
        } else {
            // 如果用户状态还未加载，继续重试（但限制重试次数）
            setTimeout(checkUserAndAnnouncements, 1000);
        }
    };

    // 页面加载完成后检查公告
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            // 延迟执行，等待用户状态加载完成
            setTimeout(checkUserAndAnnouncements, 1000);
        });
    } else {
        // 页面已加载完成，立即执行
        setTimeout(checkUserAndAnnouncements, 500);
    }
}

// 检查并显示公告（每次登录都显示）
async function checkDailyAnnouncements() {
    try {
        // 每次都获取并显示公告，不再检查时间限制
        await fetchAndShowAnnouncements();
    } catch (error) {
        console.error('Error checking announcements:', error);
    }
}

// 获取并显示公告
async function fetchAndShowAnnouncements() {
    try {
        const response = await fetch('/api/announcements/current', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            console.error('Failed to fetch announcements:', response.status);
            return;
        }

        const announcements = await response.json();

        // 筛选有效的公告（仅检查启用状态）
        const validAnnouncements = announcements.filter(announcement => {
            return announcement.enabled;
        });

        if (validAnnouncements.length > 0) {
            showAnnouncementsPopup(validAnnouncements);
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
    });

    // 绑定事件
    bindAnnouncementPopupEvents();

    // 显示弹窗
    const popup = document.getElementById('announcementsPopup');
    if (popup) {
        popup.style.display = 'flex';
        // 添加动画效果
        setTimeout(() => {
            popup.classList.add('show');
        }, 10);
    }
}

// 创建公告弹窗HTML
function createAnnouncementsPopupHtml(announcements) {
    const announcementsHtml = announcements.map(announcement => `
        <div class="announcement-item">
            <div class="announcement-header">
                <h3 class="announcement-title">${escapeHtml(announcement.title)}</h3>
            </div>
            <div class="announcement-content"></div>
            <div class="announcement-footer">
                <small class="announcement-time">
                    发布时间: ${new Date(announcement.createdAt).toLocaleString('zh-CN')}
                </small>
            </div>
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
                </div>
            </div>
        </div>
    `;
}

// 绑定公告弹窗事件
function bindAnnouncementPopupEvents() {
    const popup = document.getElementById('announcementsPopup');
    const closeBtn = document.getElementById('closeAnnouncementsPopup');
    const confirmBtn = document.getElementById('confirmAnnouncementsPopup');

    if (closeBtn) {
        closeBtn.addEventListener('click', closeAnnouncementsPopup);
    }

    if (confirmBtn) {
        confirmBtn.addEventListener('click', closeAnnouncementsPopup);
    }

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

import { getRequestHeaders } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { ensureImageFormatSupported, getBase64Async, humanFileSize } from './utils.js';

/**
 * @type {import('../../src/users.js').UserViewModel} Logged in user
 */
export let currentUser = null;
export let accountsEnabled = false;

// Extend the session every 10 minutes
const SESSION_EXTEND_INTERVAL = 10 * 60 * 1000;
const DEFAULT_INACTIVE_DAYS = 60;
const INACTIVE_USER_DAY_OPTIONS = [
    { label: '1周 (7天)', value: 7 },
    { label: '半个月 (15天)', value: 15 },
    { label: '1个月 (30天)', value: 30 },
    { label: '2个月 (60天)', value: 60 },
];

// Lightweight online presence indicator
// Note: window.isUserOnline and window.userHeartbeat are defined in user-heartbeat.js
window.isUserOnline = false;

/**
 * Enable or disable user account controls in the UI.
 * @param {boolean} isEnabled User account controls enabled
 * @returns {Promise<void>}
 */
export async function setUserControls(isEnabled) {
    accountsEnabled = isEnabled;

    if (!isEnabled) {
        $('#logout_button').hide();
        $('#admin_button').hide();
        return;
    }

    $('#logout_button').show();
    await getCurrentUser();
}

/**
 * Check if the current user is an admin.
 * @returns {boolean} True if the current user is an admin
 */
export function isAdmin() {
    if (!accountsEnabled) {
        return true;
    }

    if (!currentUser) {
        return false;
    }

    return Boolean(currentUser.admin);
}

/**
 * Gets the handle string of the current user.
 * @returns {string} User handle
 */
export function getCurrentUserHandle() {
    return currentUser?.handle || 'default-user';
}

/**
 * Get the current user.
 * @returns {Promise<void>}
 */
async function getCurrentUser() {
    try {
        const response = await fetch('/api/users/me', {
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Failed to get current user');
        }

        currentUser = await response.json();
        $('#admin_button').toggle(accountsEnabled && isAdmin());

        // 启动用户心跳
        if (typeof window.userHeartbeat !== 'undefined' && window.userHeartbeat.forceStart) {
            setTimeout(() => {
                // 检查CSRF token是否可用
                const hasToken = window.token || window.csrfToken;
                if (hasToken) {
                    window.userHeartbeat.forceStart();
                    console.log('User heartbeat force started after getCurrentUser with token');
                } else {
                    console.warn('CSRF token not available, delaying heartbeat start');
                    // 再延迟一次
                    setTimeout(() => {
                        window.userHeartbeat.forceStart();
                        console.log('User heartbeat force started after token delay');
                    }, 2000);
                }
            }, 1000);
        }


    } catch (error) {
        console.error('Error getting current user:', error);
    }
}

/**
 * Get a list of all users.
 * @param {boolean} includeStorageSize - 是否包含存储大小信息（默认false以提高性能）
 * @returns {Promise<import('../../src/users.js').UserViewModel[]>} Users
 */
async function getUsers(includeStorageSize = false) {
    try {
        const response = await fetch('/api/users/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ includeStorageSize }),
        });

        if (!response.ok) {
            throw new Error('Failed to get users');
        }

        return response.json();
    } catch (error) {
        console.error('Error getting users:', error);
    }
}

/**
 * 批量获取用户的存储占用大小
 * @param {string[]} handles - 用户句柄数组
 * @returns {Promise<Object.<string, {storageSize?: number, error?: string}>>} 用户存储大小映射
 */
async function getUsersStorageSize(handles) {
    try {
        const response = await fetch('/api/users/storage-size', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handles }),
        });

        if (!response.ok) {
            throw new Error('Failed to get users storage size');
        }

        return response.json();
    } catch (error) {
        console.error('Error getting users storage size:', error);
        return {};
    }
}

/**
 * Enable a user account.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function enableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/enable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to enable user');
            throw new Error('Failed to enable user');
        }

        callback();
    } catch (error) {
        console.error('Error enabling user:', error);
    }
}

async function disableUser(handle, callback) {
    try {
        const response = await fetch('/api/users/disable', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data?.error || 'Unknown error', 'Failed to disable user');
            throw new Error('Failed to disable user');
        }

        callback();
    } catch (error) {
        console.error('Error disabling user:', error);
    }
}

/**
 * Promote a user to admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function promoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/promote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to promote user');
            throw new Error('Failed to promote user');
        }

        callback();
    } catch (error) {
        console.error('Error promoting user:', error);
    }
}

/**
 * Demote a user from admin.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function demoteUser(handle, callback) {
    try {
        const response = await fetch('/api/users/demote', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to demote user');
            throw new Error('Failed to demote user');
        }

        callback();
    } catch (error) {
        console.error('Error demoting user:', error);
    }
}

/**
 * Create a new user.
 * @param {HTMLFormElement} form Form element
 */
async function createUser(form, callback) {
    const errors = [];
    const formData = new FormData(form);

    if (!formData.get('handle')) {
        errors.push('Handle is required');
    }

    if (formData.get('password') !== formData.get('confirm')) {
        errors.push('Passwords do not match');
    }

    if (errors.length) {
        toastr.error(errors.join(', '), 'Failed to create user');
        return;
    }

    const body = {};
    formData.forEach(function (value, key) {
        if (key === 'confirm') {
            return;
        }
        if (key.startsWith('_')) {
            key = key.substring(1);
        }
        body[key] = value;
    });

    try {
        const response = await fetch('/api/users/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to create user');
            throw new Error('Failed to create user');
        }

        form.reset();
        callback();
    } catch (error) {
        console.error('Error creating user:', error);
    }
}

/**
 * Backup a user's data.
 * @param {string} handle Handle of the user to backup
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function backupUserData(handle, callback) {
    try {
        toastr.info('Please wait for the download to start.', 'Backup Requested');
        const response = await fetch('/api/users/backup', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to backup user data');
            throw new Error('Failed to backup user data');
        }

        const blob = await response.blob();
        const header = response.headers.get('Content-Disposition');
        const parts = header.split(';');
        const filename = parts[1].split('=')[1].replaceAll('"', '');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        callback();
    } catch (error) {
        console.error('Error backing up user data:', error);
    }
}

/**
 * Shows a popup to change a user's password.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function changePassword(handle, callback) {
    try {
        await getCurrentUser();
        const template = $(await renderTemplateAsync('changePassword'));

        // 如果是管理员，或者用户没有密码（OAuth 用户首次设置），隐藏当前密码输入框
        const hasPassword = currentUser && currentUser.password;
        const needOldPassword = !isAdmin() && hasPassword;
        template.find('.currentPasswordBlock').toggle(needOldPassword);

        // 如果是 OAuth 用户首次设置密码，显示提示信息
        if (!hasPassword && currentUser.oauthProvider) {
            const hint = $('<div class="oauth-password-hint" style="margin-bottom: 10px; padding: 10px; background: #e8f4f8; border-radius: 5px; font-size: 0.9em;">');
            hint.html(`<i class="fa-solid fa-info-circle"></i> 您通过 <strong>${currentUser.oauthProvider}</strong> 注册，当前没有密码。设置密码后，您可以使用用户名密码登录或继续使用 ${currentUser.oauthProvider} 登录。`);
            template.prepend(hint);
        }

        let newPassword = '';
        let confirmPassword = '';
        let oldPassword = '';
        template.find('input[name="current"]').on('input', function () {
            oldPassword = String($(this).val());
        });
        template.find('input[name="password"]').on('input', function () {
            newPassword = String($(this).val());
        });
        template.find('input[name="confirm"]').on('input', function () {
            confirmPassword = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });
        if (result === POPUP_RESULT.CANCELLED || result === POPUP_RESULT.NEGATIVE) {
            throw new Error('Change password cancelled');
        }

        if (newPassword !== confirmPassword) {
            toastr.error('Passwords do not match', 'Failed to change password');
            throw new Error('Passwords do not match');
        }

        const response = await fetch('/api/users/change-password', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, newPassword, oldPassword }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change password');
            throw new Error('Failed to change password');
        }

        if (!hasPassword) {
            toastr.success('密码设置成功！现在您可以使用用户名密码登录了', 'Password Set');
        } else {
            toastr.success('Password changed successfully', 'Password Changed');
        }
        callback();
    }
    catch (error) {
        console.error('Error changing password:', error);
    }
}

/**
 * Clear backups for a user.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function clearUserBackups(handle, callback) {
    try {
        const template = $(await renderTemplateAsync('clearUserBackups'));
        template.find('#clearUserName').text(handle);

        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: '清理', cancelButton: '取消', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Clear backups cancelled');
        }

        toastr.info('正在清理备份文件，请稍候...', '清理中');

        const response = await fetch('/api/users/clear-backups', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', '清理失败');
            throw new Error('Failed to clear backups');
        }

        const data = await response.json();
        toastr.success(data.message, '清理成功');
        callback();
    } catch (error) {
        console.error('Error clearing backups:', error);
    }
}

/**
 * Clear backups for all users.
 * @param {function} callback Success callback
 */
async function clearAllBackups(callback) {
    try {
        const confirm = await callGenericPopup(
            '确定要清理所有用户的备份文件吗？此操作不可恢复！',
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: '确认清理', cancelButton: '取消', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Clear all backups cancelled');
        }

        toastr.info('正在清理所有用户的备份文件，请稍候...', '清理中');

        const response = await fetch('/api/users/clear-all-backups', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', '清理失败');
            throw new Error('Failed to clear all backups');
        }

        const data = await response.json();
        toastr.success(data.message, '清理成功');
        callback();
    } catch (error) {
        console.error('Error clearing all backups:', error);
    }
}

function formatMaxStorageMiB(maxStorageMiB) {
    if (!Number.isFinite(maxStorageMiB)) {
        return null;
    }

    const rounded = Math.round(maxStorageMiB * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function buildInactiveUserFilterText(inactiveDays, maxStorageMiB) {
    const maxStorageLabel = formatMaxStorageMiB(maxStorageMiB);
    if (maxStorageLabel) {
        return `超过 ${inactiveDays} 天未登录且存储占用不超过 ${maxStorageLabel} MiB`;
    }

    return `超过 ${inactiveDays} 天未登录`;
}

async function promptInactiveUserCleanupOptions() {
    const template = $(`
        <div class="flex-container flexFlowColumn flexGap10">
            <div class="flex-container flexFlowColumn flexGap5">
                <label>未登录时长</label>
                <select class="text_pole inactiveUsersDaysSelect"></select>
            </div>
            <div class="flex-container flexFlowColumn flexGap5">
                <label>最大存储占用 (MiB)</label>
                <input type="number" class="text_pole inactiveUsersMaxStorageInput" min="0" step="0.1" placeholder="例如: 10">
                <small style="opacity: 0.8;">留空或 0 表示不限制</small>
            </div>
        </div>
    `);

    const select = template.find('.inactiveUsersDaysSelect');
    for (const option of INACTIVE_USER_DAY_OPTIONS) {
        select.append(`<option value="${option.value}">${option.label}</option>`);
    }
    select.val(String(DEFAULT_INACTIVE_DAYS));

    const result = await callGenericPopup(
        template,
        POPUP_TYPE.CONFIRM,
        '选择删除条件',
        { okButton: '下一步', cancelButton: '取消', wide: false, large: false },
    );

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        throw new Error('Delete inactive users cancelled');
    }

    const inactiveDays = Number.parseInt(String(select.val() ?? ''), 10) || DEFAULT_INACTIVE_DAYS;
    const maxStorageRaw = String(template.find('.inactiveUsersMaxStorageInput').val()).trim();
    const maxStorageMiBValue = Number.parseFloat(maxStorageRaw);
    const maxStorageMiB = Number.isFinite(maxStorageMiBValue) && maxStorageMiBValue > 0 ? maxStorageMiBValue : null;

    return { inactiveDays, maxStorageMiB };
}

/**
 * Delete inactive users who haven't logged in for a chosen time period.
 * @param {function} callback Success callback
 */
async function deleteInactiveUsers(callback) {
    try {
        const { inactiveDays, maxStorageMiB } = await promptInactiveUserCleanupOptions();
        const filterLabel = buildInactiveUserFilterText(inactiveDays, maxStorageMiB);

        // 第一步：预览将要删除的用户
        toastr.info('正在扫描不活跃用户，请稍候...', '扫描中');

        const previewResponse = await fetch('/api/users/delete-inactive-users', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ dryRun: true, inactiveDays, maxStorageMiB }),
        });

        if (!previewResponse.ok) {
            const data = await previewResponse.json();
            toastr.error(data.error || 'Unknown error', '扫描失败');
            throw new Error('Failed to preview inactive users');
        }

        const previewData = await previewResponse.json();

        if (previewData.totalUsers === 0) {
            toastr.info(`没有发现${filterLabel}的用户`, '无需清理');
            return;
        }

        // 构建用户列表HTML
        let userListHtml = '<div class="flex-container flexFlowColumn flexGap5" style="max-height: 800px; overflow-y: auto;">';
        userListHtml += '<p style="margin: 10px 0;">以下用户将被删除（包括所有数据）：</p>';
        userListHtml += `<p style="margin: 10px 0; font-size: 0.9em; opacity: 0.8;">筛选条件：${filterLabel}</p>`;
        userListHtml += '<ul style="text-align: left; margin: 10px 0;">';

        for (const user of previewData.inactiveUsers) {
            const sizeLabel = humanFileSize(user.storageSize, false, 2);
            userListHtml += `<li style="margin: 5px 0; padding: 5px; background: rgba(255,0,0,0.1); border-radius: 3px;">`;
            userListHtml += `<strong>${user.name}</strong> (${user.handle})<br>`;
            userListHtml += `<small>最后登录: ${user.lastActivityFormatted} (${user.daysSinceLastActivity}天前)</small><br>`;
            userListHtml += `<small>存储占用: ${sizeLabel}</small>`;
            userListHtml += `</li>`;
        }

        userListHtml += '</ul>';
        userListHtml += `<p style="margin: 10px 0; font-weight: bold; color: red;">`;
        userListHtml += `共 ${previewData.totalUsers} 个用户，总计 ${humanFileSize(previewData.totalSize, false, 2)}`;
        userListHtml += `</p>`;
        userListHtml += '<p style="margin: 10px 0; color: orange;"><strong>⚠️ 警告：此操作不可恢复！</strong></p>';
        userListHtml += '</div>';

        const confirmTemplate = $(userListHtml);

        const confirm = await callGenericPopup(
            confirmTemplate,
            POPUP_TYPE.CONFIRM,
            `确认删除${filterLabel}的用户`,
            { okButton: '确认删除', cancelButton: '取消', wide: true, large: false, allowVerticalScrolling: true },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Delete inactive users cancelled');
        }

        // 第二步：确认后执行删除
        toastr.info('正在删除不活跃用户，请稍候...', '删除中');

        const deleteResponse = await fetch('/api/users/delete-inactive-users', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ dryRun: false, inactiveDays, maxStorageMiB }),
        });

        if (!deleteResponse.ok) {
            const data = await deleteResponse.json();
            toastr.error(data.error || 'Unknown error', '删除失败');
            throw new Error('Failed to delete inactive users');
        }

        const deleteData = await deleteResponse.json();

        // 显示详细结果
        let resultMessage = deleteData.message;
        if (deleteData.failedUsers && deleteData.failedUsers.length > 0) {
            resultMessage += `\n失败 ${deleteData.failedUsers.length} 个用户`;
        }

        toastr.success(resultMessage, '删除完成');
        callback();
    } catch (error) {
        if (error.message !== 'Delete inactive users cancelled') {
            console.error('Error deleting inactive users:', error);
        }
    }
}

/**
 * Delete a user.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function deleteUser(handle, callback) {
    try {
        if (handle === currentUser.handle) {
            toastr.error('Cannot delete yourself', 'Failed to delete user');
            throw new Error('Cannot delete yourself');
        }

        let purge = false;
        let confirmHandle = '';

        const template = $(await renderTemplateAsync('deleteUser'));
        template.find('#deleteUserName').text(handle);
        template.find('input[name="deleteUserData"]').on('input', function () {
            purge = $(this).is(':checked');
        });
        template.find('input[name="deleteUserHandle"]').on('input', function () {
            confirmHandle = String($(this).val());
        });

        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Delete user cancelled');
        }

        if (handle !== confirmHandle) {
            toastr.error('Handles do not match', 'Failed to delete user');
            throw new Error('Handles do not match');
        }

        const response = await fetch('/api/users/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, purge }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to delete user');
            throw new Error('Failed to delete user');
        }

        toastr.success('User deleted successfully', 'User Deleted');
        callback();
    } catch (error) {
        console.error('Error deleting user:', error);
    }
}

/**
 * Reset a user's settings.
 * @param {string} handle User handle
 * @param {function} callback Success callback
 */
async function resetSettings(handle, callback) {
    try {
        let password = '';
        const template = $(await renderTemplateAsync('resetSettings'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        const result = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false });

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset settings cancelled');
        }

        const response = await fetch('/api/users/reset-settings', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, password }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset settings');
            throw new Error('Failed to reset settings');
        }

        toastr.success('Settings reset successfully', 'Settings Reset');
        callback();
    } catch (error) {
        console.error('Error resetting settings:', error);
    }
}

/**
 * Change a user's display name.
 * @param {string} handle User handle
 * @param {string} name Current name
 * @param {function} callback Success callback
 */
async function changeName(handle, name, callback) {
    try {
        const template = $(await renderTemplateAsync('changeName'));
        const result = await callGenericPopup(template, POPUP_TYPE.INPUT, name, { okButton: 'Change', cancelButton: 'Cancel', wide: false, large: false });

        if (!result) {
            throw new Error('Change name cancelled');
        }

        name = String(result);

        const response = await fetch('/api/users/change-name', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle, name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change name');
            throw new Error('Failed to change name');
        }

        toastr.success('Name changed successfully', 'Name Changed');
        callback();

    } catch (error) {
        console.error('Error changing name:', error);
    }
}

/**
 * Restore a settings snapshot.
 * @param {string} name Snapshot name
 * @param {function} callback Success callback
 */
async function restoreSnapshot(name, callback) {
    try {
        const confirm = await callGenericPopup(
            `Are you sure you want to restore the settings from "${name}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Restore', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Restore snapshot cancelled');
        }

        const response = await fetch('/api/settings/restore-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to restore snapshot');
            throw new Error('Failed to restore snapshot');
        }

        callback();
    } catch (error) {
        console.error('Error restoring snapshot:', error);
    }

}

/**
 * Load the content of a settings snapshot.
 * @param {string} name Snapshot name
 * @returns {Promise<string>} Snapshot content
 */
async function loadSnapshotContent(name) {
    try {
        const response = await fetch('/api/settings/load-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to load snapshot content');
            throw new Error('Failed to load snapshot content');
        }

        return response.text();
    } catch (error) {
        console.error('Error loading snapshot content:', error);
    }
}

/**
 * Gets a list of settings snapshots.
 * @returns {Promise<Snapshot[]>} List of snapshots
 * @typedef {Object} Snapshot
 * @property {string} name Snapshot name
 * @property {number} date Date in milliseconds
 * @property {number} size File size in bytes
 */
async function getSnapshots() {
    try {
        const response = await fetch('/api/settings/get-snapshots', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to get settings snapshots');
            throw new Error('Failed to get settings snapshots');
        }

        const snapshots = await response.json();
        return snapshots;
    } catch (error) {
        console.error('Error getting settings snapshots:', error);
        return [];
    }
}

/**
 * Make a snapshot of the current settings.
 * @param {function} callback Success callback
 * @returns {Promise<void>}
 */
async function makeSnapshot(callback) {
    try {
        const response = await fetch('/api/settings/make-snapshot', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to make snapshot');
            throw new Error('Failed to make snapshot');
        }

        toastr.success('Snapshot created successfully', 'Snapshot Created');
        callback();
    } catch (error) {
        console.error('Error making snapshot:', error);
    }
}

/**
 * Open the settings snapshots view.
 */
async function viewSettingsSnapshots() {
    const template = $(await renderTemplateAsync('snapshotsView'));
    async function renderSnapshots() {
        const snapshots = await getSnapshots();
        template.find('.snapshotList').empty();

        for (const snapshot of snapshots.sort((a, b) => b.date - a.date)) {
            const snapshotBlock = template.find('.snapshotTemplate .snapshot').clone();
            snapshotBlock.find('.snapshotName').text(snapshot.name);
            snapshotBlock.find('.snapshotDate').text(new Date(snapshot.date).toLocaleString());
            snapshotBlock.find('.snapshotSize').text(humanFileSize(snapshot.size));
            snapshotBlock.find('.snapshotRestoreButton').on('click', async (e) => {
                e.stopPropagation();
                restoreSnapshot(snapshot.name, () => location.reload());
            });
            snapshotBlock.find('.inline-drawer-toggle').on('click', async () => {
                const contentBlock = snapshotBlock.find('.snapshotContent');
                if (!contentBlock.val()) {
                    const content = await loadSnapshotContent(snapshot.name);
                    contentBlock.val(content);
                }

            });
            template.find('.snapshotList').append(snapshotBlock);
        }
    }

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: false, large: false, allowVerticalScrolling: true });
    template.find('.makeSnapshotButton').on('click', () => makeSnapshot(renderSnapshots));
    renderSnapshots();
}

/**
 * Reset everything to default.
 * @param {function} callback Success callback
 */
async function resetEverything(callback) {
    try {
        const step1Response = await fetch('/api/users/reset-step1', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!step1Response.ok) {
            const data = await step1Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        let password = '';
        let code = '';

        const template = $(await renderTemplateAsync('userReset'));
        template.find('input[name="password"]').on('input', function () {
            password = String($(this).val());
        });
        template.find('input[name="code"]').on('input', function () {
            code = String($(this).val());
        });
        const confirm = await callGenericPopup(
            template,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Reset', cancelButton: 'Cancel', wide: false, large: false },
        );

        if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
            throw new Error('Reset everything cancelled');
        }

        const step2Response = await fetch('/api/users/reset-step2', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ password, code }),
        });

        if (!step2Response.ok) {
            const data = await step2Response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to reset');
            throw new Error('Failed to reset everything');
        }

        toastr.success('Everything reset successfully', 'Reset Everything');
        callback();
    } catch (error) {
        console.error('Error resetting everything:', error);
    }

}

function formatStorageMiB(value) {
    if (!Number.isFinite(value)) {
        return '0';
    }

    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

async function loadUserStorageStatus(template) {
    try {
        const response = await fetch('/api/user-storage/status', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Failed to load storage status');
        }

        const status = await response.json();
        const storageBlocks = template.find('.userStorageBlock, .userStorageActions, .userStorageWarning');

        if (!status.enabled) {
            storageBlocks.hide();
            return;
        }

        storageBlocks.show();
        const usedLabel = `${formatStorageMiB(status.usedMiB)} MiB`;
        const limitLabel = `${formatStorageMiB(status.limitMiB)} MiB`;
        const remainingLabel = `${formatStorageMiB(status.remainingMiB)} MiB`;
        template.find('.userStorageUsage').text(`${usedLabel} / ${limitLabel}`);
        template.find('.userStorageRemaining').text(remainingLabel);

        const warning = template.find('.userStorageWarning');
        if (Number(status.remainingBytes) <= 0) {
            warning.text('空间已用完，无法继续新增聊天或角色卡。请删除内容或使用激活码扩容。');
            warning.show();
        } else {
            warning.hide();
        }

        const checkInButton = template.find('.userStorageCheckInButton');
        if (Number(status.checkInRewardMiB) > 0) {
            checkInButton.show();
        } else {
            checkInButton.hide();
        }

        if (status.canCheckIn) {
            checkInButton.removeClass('disabled');
        } else {
            checkInButton.addClass('disabled');
        }
    } catch (error) {
        console.error('Error loading storage status:', error);
        template.find('.userStorageBlock, .userStorageActions, .userStorageWarning').hide();
    }
}

async function openUserProfile() {
    await getCurrentUser();

    const template = $(await renderTemplateAsync('userProfile'));
    template.find('.userName').text(currentUser.name);
    template.find('.userHandle').text(currentUser.handle);
    template.find('.avatar img').attr('src', currentUser.avatar);
    template.find('.userRole').text(currentUser.admin ? 'Admin' : 'User');
    template.find('.userCreated').text(new Date(currentUser.created).toLocaleString());
    template.find('.hasPassword').toggle(currentUser.password);
    template.find('.noPassword').toggle(!currentUser.password);

    // 显示 OAuth 提供商信息
    if (currentUser.oauthProvider) {
        const providerNames = {
            'github': 'GitHub',
            'discord': 'Discord',
            'linuxdo': 'Linux.do'
        };
        const providerName = providerNames[currentUser.oauthProvider] || currentUser.oauthProvider;
        template.find('.oauthProviderBlock').show();
        template.find('.oauthProvider').text(providerName);
    } else {
        template.find('.oauthProviderBlock').hide();
    }

    // 显示邮箱信息（如果没有绑定则显示为空）
    const userEmail = currentUser.email || '';
    template.find('.userEmail').text(userEmail);

    // 显示到期时间
    if (currentUser.expiresAt) {
        const expiresDate = new Date(currentUser.expiresAt);
        const now = new Date();
        const daysLeft = Math.ceil((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        let expiresText = expiresDate.toLocaleString();
        if (daysLeft > 0) {
            expiresText += ` (剩余${daysLeft}天)`;
        } else {
            expiresText += ' (已过期)';
        }
        template.find('.userExpiresAt').text(expiresText);
        if (daysLeft <= 7 && daysLeft > 0) {
            template.find('.userExpiresAt').css('color', 'orange');
        } else if (daysLeft <= 0) {
            template.find('.userExpiresAt').css('color', 'red');
        }
    } else {
        template.find('.userExpiresAt').text('永久');
        template.find('.userExpiresAt').css('color', 'green');
    }

    template.find('.userSettingsSnapshotsButton').on('click', () => viewSettingsSnapshots());
    template.find('.userChangeNameButton').on('click', async () => changeName(currentUser.handle, currentUser.name, async () => {
        await getCurrentUser();
        template.find('.userName').text(currentUser.name);
    }));
    template.find('.userChangePasswordButton').on('click', () => changePassword(currentUser.handle, async () => {
        await getCurrentUser();
        template.find('.hasPassword').toggle(currentUser.password);
        template.find('.noPassword').toggle(!currentUser.password);
    }));

    // 续费按钮事件
    template.find('.userRenewButton').on('click', async () => {
        // 获取购买链接
        let purchaseLink = '';
        try {
            const linkResponse = await fetch('/api/invitation-codes/purchase-link', {
                method: 'GET',
                headers: getRequestHeaders()
            });
            if (linkResponse.ok) {
                const linkData = await linkResponse.json();
                purchaseLink = linkData.purchaseLink || '';
            }
        } catch (error) {
            console.error('获取购买链接失败:', error);
        }

        // 构建提示信息
        let promptMessage = '请输入续费码';
        if (purchaseLink) {
            promptMessage = `请输入续费码\n\n如需购买续费码，请访问：\n${purchaseLink}`;
        }

        const code = await callGenericPopup(promptMessage, POPUP_TYPE.INPUT, '', { okButton: '确认', cancelButton: '取消' });

        if (!code) {
            return;
        }

        try {
            const response = await fetch('/api/users/renew', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ invitationCode: code })
            });

            const data = await response.json();

            if (!response.ok) {
                toastr.error(data.error || '续费失败', '错误');
                return;
            }

            toastr.success(data.message || '续费成功', '成功');

            // 刷新用户信息
            await getCurrentUser();
            if (currentUser.expiresAt) {
                const expiresDate = new Date(currentUser.expiresAt);
                const now = new Date();
                const daysLeft = Math.ceil((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                let expiresText = expiresDate.toLocaleString();
                if (daysLeft > 0) {
                    expiresText += ` (剩余${daysLeft}天)`;
                }
                template.find('.userExpiresAt').text(expiresText);
                template.find('.userExpiresAt').css('color', daysLeft <= 7 ? 'orange' : '');
            } else {
                template.find('.userExpiresAt').text('永久');
                template.find('.userExpiresAt').css('color', 'green');
            }
        } catch (error) {
            console.error('续费错误:', error);
            toastr.error('续费失败，请稍后重试', '错误');
        }
    });

    template.find('.userBackupButton').on('click', function () {
        $(this).addClass('disabled');
        backupUserData(currentUser.handle, () => {
            $(this).removeClass('disabled');
        });
    });
    template.find('.userStorageRedeemButton').on('click', async () => {
        const code = await callGenericPopup('请输入扩容激活码', POPUP_TYPE.INPUT, '', { okButton: '确认', cancelButton: '取消' });
        if (!code) {
            return;
        }

        try {
            const response = await fetch('/api/user-storage/redeem', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ code }),
            });
            const data = await response.json();

            if (!response.ok) {
                toastr.error(data.error || '激活码无效', '扩容失败');
                return;
            }

            toastr.success(`扩容成功，增加 ${data.addedMiB} MiB`, '扩容成功');
            await loadUserStorageStatus(template);
        } catch (error) {
            console.error('Storage redeem failed:', error);
            toastr.error('激活码使用失败，请稍后重试', '扩容失败');
        }
    });

    template.find('.userStorageCheckInButton').on('click', async function () {
        const button = $(this);
        if (button.hasClass('disabled')) {
            return;
        }

        try {
            const response = await fetch('/api/user-storage/check-in', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            const data = await response.json();

            if (!response.ok) {
                toastr.error(data.error || '签到失败', '签到失败');
                return;
            }

            toastr.success(`签到成功，增加 ${data.addedMiB} MiB`, '签到成功');
            await loadUserStorageStatus(template);
        } catch (error) {
            console.error('Storage check-in failed:', error);
            toastr.error('签到失败，请稍后重试', '签到失败');
        }
    });
    template.find('.userResetSettingsButton').on('click', () => resetSettings(currentUser.handle, () => location.reload()));
    template.find('.userResetAllButton').on('click', () => resetEverything(() => location.reload()));
    template.find('.userAvatarChange').on('click', () => template.find('.avatarUpload').trigger('click'));
    template.find('.avatarUpload').on('change', async function () {
        if (!(this instanceof HTMLInputElement)) {
            return;
        }

        const file = this.files[0];
        if (!file) {
            return;
        }

        await cropAndUploadAvatar(currentUser.handle, file);
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });
    template.find('.userAvatarRemove').on('click', async function () {
        await changeAvatar(currentUser.handle, '');
        await getCurrentUser();
        template.find('.avatar img').attr('src', currentUser.avatar);
    });

    if (!accountsEnabled) {
        template.find('[data-require-accounts]').hide();
        template.find('.accountsDisabledHint').show();
    }

    await loadUserStorageStatus(template);

    const popupOptions = {
        okButton: 'Close',
        wide: false,
        large: false,
        allowVerticalScrolling: true,
        allowHorizontalScrolling: false,
    };
    callGenericPopup(template, POPUP_TYPE.TEXT, '', popupOptions);
}

/**
 * Crop and upload an avatar image.
 * @param {string} handle User handle
 * @param {File} file Avatar file
 * @returns {Promise<string>}
 */
async function cropAndUploadAvatar(handle, file) {
    const dataUrl = await getBase64Async(await ensureImageFormatSupported(file));
    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: dataUrl });
    if (!croppedImage) {
        return;
    }

    await changeAvatar(handle, String(croppedImage));

    return String(croppedImage);
}

/**
 * Change the avatar of the user.
 * @param {string} handle User handle
 * @param {string} avatar File to upload or base64 string
 * @returns {Promise<void>} Avatar URL
 */
async function changeAvatar(handle, avatar) {
    try {
        const response = await fetch('/api/users/change-avatar', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, handle }),
        });

        if (!response.ok) {
            const data = await response.json();
            toastr.error(data.error || 'Unknown error', 'Failed to change avatar');
            return;
        }
    } catch (error) {
        console.error('Error changing avatar:', error);
    }
}

async function openAdminPanel() {
    // 用户列表分页相关变量
    let currentUserPage = 1;
    const usersPerPage = 20; // 每页显示20个用户
    let userSearchTerm = '';
    let allUsers = []; // 存储所有用户数据

    async function renderUsers() {
        // 先快速加载用户列表（不包含存储大小）
        const users = await getUsers(false);
        allUsers = users; // 保存所有用户数据

        // 应用搜索过滤
        let filteredUsers = users;
        if (userSearchTerm) {
            filteredUsers = users.filter(user =>
                user.name.toLowerCase().includes(userSearchTerm.toLowerCase()) ||
                user.handle.toLowerCase().includes(userSearchTerm.toLowerCase())
            );
        }

        // 计算分页
        const totalPages = Math.ceil(filteredUsers.length / usersPerPage);

        // 如果当前页超出范围，自动调整到最后一页
        if (currentUserPage > totalPages && totalPages > 0) {
            currentUserPage = totalPages;
        } else if (totalPages === 0) {
            currentUserPage = 1;
        }

        const startIndex = (currentUserPage - 1) * usersPerPage;
        const endIndex = startIndex + usersPerPage;
        const pageUsers = filteredUsers.slice(startIndex, endIndex);

        // 清除旧的用户卡片
        template.find('.navTab.usersList .userAccount').remove();

        // 确保有用户列表容器
        let usersListContainer = template.find('.navTab.usersList .usersListContainer');
        if (usersListContainer.length === 0) {
            usersListContainer = $('<div class="usersListContainer"></div>');
            template.find('.navTab.usersList').append(usersListContainer);
        }

        // 存储用户块的引用，用于后续更新存储大小
        const userBlocks = new Map();

        // 添加搜索框和统计信息（确保在 navTab 内部）
        let controlsHtml = template.find('.navTab.usersList .usersListControls');
        if (controlsHtml.length === 0) {
            controlsHtml = $(`
                <div class="usersListControls" style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px; padding: 10px; background: var(--SmartThemeBlurTintColor); border-radius: 10px;">
                    <input type="text" id="userSearchInput" placeholder="搜索用户名或句柄..." value="" class="text_pole" style="flex: 1;">
                    <span class="userCount" style="white-space: nowrap; opacity: 0.7; font-size: 0.9em; padding: 5px 10px; background: var(--black30a); border-radius: 5px;"></span>
                </div>
            `);
            // 插入到 navTab.usersList 的开头（在已有按钮之后）
            const navTab = template.find('.navTab.usersList');
            const existingButtons = navTab.find('.flex-container.justifyCenter').first();
            if (existingButtons.length > 0) {
                existingButtons.after(controlsHtml);
            } else {
                navTab.prepend(controlsHtml);
            }
        }

        controlsHtml.find('#userSearchInput').val(userSearchTerm);
        controlsHtml.find('.userCount').text(`显示 ${startIndex + 1}-${Math.min(endIndex, filteredUsers.length)} / ${filteredUsers.length} 个用户`);

        // 绑定搜索事件（使用防抖）
        controlsHtml.find('#userSearchInput').off('input').on('input', debounceSearch(function() {
            userSearchTerm = String($(this).val() ?? '').trim();
            currentUserPage = 1; // 重置到第一页
            renderUsers();
        }, 300));

        // 如果没有用户，显示提示
        if (filteredUsers.length === 0) {
            const emptyMessage = userSearchTerm
                ? `<div style="text-align: center; padding: 40px; opacity: 0.7;">没有找到匹配的用户</div>`
                : `<div style="text-align: center; padding: 40px; opacity: 0.7;">暂无用户</div>`;
            usersListContainer.append(emptyMessage);
            return;
        }

        for (const user of pageUsers) {
            const userBlock = template.find('.userAccountTemplate .userAccount').clone();
            userBlock.find('.userName').text(user.name);
            userBlock.find('.userHandle').text(user.handle);
            const userEmail = user.email || '';
            userBlock.find('.userEmail').text(userEmail);
            userBlock.find('.userStatus').text(user.enabled ? 'Enabled' : 'Disabled');
            userBlock.find('.userRole').text(user.admin ? 'Admin' : 'User');
            userBlock.find('.avatar img').attr('src', user.avatar);
            userBlock.find('.hasPassword').toggle(user.password);
            userBlock.find('.noPassword').toggle(!user.password);
            userBlock.find('.userCreated').text(new Date(user.created).toLocaleString());

            // 初始显示"加载中..."
            userBlock.find('.userStorageSize').text('加载中...');

            // 保存userBlock引用
            userBlocks.set(user.handle, userBlock);

            // 显示到期时间
            if (user.expiresAt) {
                const expiresDate = new Date(user.expiresAt);
                const now = new Date();
                const daysLeft = Math.ceil((expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                let expiresText = expiresDate.toLocaleString();
                if (daysLeft > 0) {
                    expiresText += ` (剩余${daysLeft}天)`;
                } else {
                    expiresText += ' (已过期)';
                }
                userBlock.find('.userExpiresAt').text(expiresText);
                if (daysLeft <= 7 && daysLeft > 0) {
                    userBlock.find('.userExpiresAt').css('color', 'orange');
                } else if (daysLeft <= 0) {
                    userBlock.find('.userExpiresAt').css('color', 'red');
                }
            } else {
                userBlock.find('.userExpiresAt').text('永久');
                userBlock.find('.userExpiresAt').css('color', 'green');
            }

            userBlock.find('.userEnableButton').toggle(!user.enabled).on('click', () => enableUser(user.handle, renderUsers));
            userBlock.find('.userDisableButton').toggle(user.enabled).on('click', () => disableUser(user.handle, renderUsers));
            userBlock.find('.userPromoteButton').toggle(!user.admin).on('click', () => promoteUser(user.handle, renderUsers));
            userBlock.find('.userDemoteButton').toggle(user.admin).on('click', () => demoteUser(user.handle, renderUsers));
            userBlock.find('.userChangePasswordButton').on('click', () => changePassword(user.handle, renderUsers));
            userBlock.find('.userClearBackupsButton').on('click', () => clearUserBackups(user.handle, renderUsers));
            userBlock.find('.userDelete').on('click', () => deleteUser(user.handle, renderUsers));
            userBlock.find('.userChangeNameButton').on('click', async () => changeName(user.handle, user.name, renderUsers));
            userBlock.find('.userBackupButton').on('click', function () {
                $(this).addClass('disabled').off('click');
                backupUserData(user.handle, renderUsers);
            });
            userBlock.find('.userAvatarChange').on('click', () => userBlock.find('.avatarUpload').trigger('click'));
            userBlock.find('.avatarUpload').on('change', async function () {
                if (!(this instanceof HTMLInputElement)) {
                    return;
                }

                const file = this.files[0];
                if (!file) {
                    return;
                }

                await cropAndUploadAvatar(user.handle, file);
                renderUsers();
            });
            userBlock.find('.userAvatarRemove').on('click', async function () {
                await changeAvatar(user.handle, '');
                renderUsers();
            });
            usersListContainer.append(userBlock);
        }

        // 添加底部分页控件（添加到 .navTab.usersList 内部，而不是外部）
        let paginationBottom = template.find('.navTab.usersList .usersPaginationBottom');
        if (paginationBottom.length === 0) {
            paginationBottom = $('<div class="usersPaginationBottom"></div>');
            template.find('.navTab.usersList').append(paginationBottom);
        }
        paginationBottom.html(createUserPaginationControls(currentUserPage, totalPages, filteredUsers.length));

        // 绑定分页按钮事件
        bindUserPaginationEvents();

        // 异步批量加载当前页用户的存储大小
        if (pageUsers.length > 0) {
            const userHandles = pageUsers.map(u => u.handle);

            // 分批加载，避免一次性加载太多用户导致请求超时
            // 每批最多处理20个用户
            const batchSize = 20;
            for (let i = 0; i < userHandles.length; i += batchSize) {
                const batch = userHandles.slice(i, i + batchSize);

                // 延迟一点时间，让UI先渲染出来
                if (i === 0) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                try {
                    const storageSizes = await getUsersStorageSize(batch);

                    // 更新UI显示
                    for (const handle of batch) {
                        const userBlock = userBlocks.get(handle);
                        if (userBlock && storageSizes[handle]) {
                            if (storageSizes[handle].storageSize !== undefined) {
                                userBlock.find('.userStorageSize').text(humanFileSize(storageSizes[handle].storageSize));
                            } else if (storageSizes[handle].error) {
                                userBlock.find('.userStorageSize').text('计算失败');
                                userBlock.find('.userStorageSize').attr('title', storageSizes[handle].error);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error loading storage size for batch ${i / batchSize + 1}:`, error);
                    // 如果某批次失败，标记为错误
                    for (const handle of batch) {
                        const userBlock = userBlocks.get(handle);
                        if (userBlock) {
                            userBlock.find('.userStorageSize').text('加载失败');
                        }
                    }
                }
            }
        }
    }

    // 创建用户分页控件
    function createUserPaginationControls(currentPage, totalPages, totalUsers) {
        if (totalPages <= 1) return '';

        let html = '<div class="userPaginationControls" style="display: flex; align-items: center; justify-content: center; gap: 10px; margin: 15px 0; flex-wrap: wrap;">';

        // 上一页按钮
        if (currentPage > 1) {
            html += `<button class="menu_button user-pagination-btn" data-page="${currentPage - 1}">
                <i class="fa-solid fa-chevron-left"></i> 上一页
            </button>`;
        } else {
            html += `<button class="menu_button" disabled style="opacity: 0.5;">
                <i class="fa-solid fa-chevron-left"></i> 上一页
            </button>`;
        }

        // 页码按钮
        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
        let endPage = Math.min(totalPages, startPage + maxButtons - 1);

        // 调整起始页
        if (endPage - startPage < maxButtons - 1) {
            startPage = Math.max(1, endPage - maxButtons + 1);
        }

        // 第一页
        if (startPage > 1) {
            html += `<button class="menu_button user-pagination-btn" data-page="1">1</button>`;
            if (startPage > 2) {
                html += `<span style="opacity: 0.5;">...</span>`;
            }
        }

        // 中间页码
        for (let i = startPage; i <= endPage; i++) {
            if (i === currentPage) {
                html += `<button class="menu_button" disabled style="background: var(--SmartThemeBlurTintColor);">${i}</button>`;
            } else {
                html += `<button class="menu_button user-pagination-btn" data-page="${i}">${i}</button>`;
            }
        }

        // 最后一页
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                html += `<span style="opacity: 0.5;">...</span>`;
            }
            html += `<button class="menu_button user-pagination-btn" data-page="${totalPages}">${totalPages}</button>`;
        }

        // 下一页按钮
        if (currentPage < totalPages) {
            html += `<button class="menu_button user-pagination-btn" data-page="${currentPage + 1}">
                下一页 <i class="fa-solid fa-chevron-right"></i>
            </button>`;
        } else {
            html += `<button class="menu_button" disabled style="opacity: 0.5;">
                下一页 <i class="fa-solid fa-chevron-right"></i>
            </button>`;
        }

        html += '</div>';
        return html;
    }

    // 绑定用户分页按钮事件
    function bindUserPaginationEvents() {
        template.find('.user-pagination-btn').off('click').on('click', function() {
            currentUserPage = parseInt($(this).data('page'));
            renderUsers();

            // 滚动到顶部
            const usersListControls = template.find('.usersListControls');
            if (usersListControls.length > 0) {
                usersListControls[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    // 防抖函数
    function debounceSearch(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    const template = $(await renderTemplateAsync('admin'));

    template.find('.adminNav > button').on('click', function () {
        const target = String($(this).data('target-tab'));
        template.find('.navTab').each(function () {
            $(this).toggle(this.classList.contains(target));
        });
        // 初始化管理员扩展功能
        if (typeof window.initializeAdminExtensions === 'function') {
            setTimeout(() => {
                window.initializeAdminExtensions();
            }, 100);
        }
    });
// 管理员面板打开时立即初始化扩展功能
if (typeof window.initializeAdminExtensions === 'function') {
    setTimeout(() => {
        window.initializeAdminExtensions();
    }, 200);
}
    template.find('.createUserDisplayName').on('input', async function () {
        const slug = await slugify(String($(this).val()));
        template.find('.createUserHandle').val(slug);
    });

    template.find('.userCreateForm').on('submit', function (event) {
        if (!(event.target instanceof HTMLFormElement)) {
            return;
        }

        event.preventDefault();
        createUser(event.target, () => {
            template.find('.manageUsersButton').trigger('click');
            currentUserPage = 1; // 重置到第一页以显示新创建的用户
            userSearchTerm = ''; // 清空搜索词
            renderUsers();
        });
    });

    // 绑定一键清理所有用户备份文件按钮
    template.find('.clearAllBackupsButton').on('click', () => clearAllBackups(renderUsers));

    // 绑定一键删除30天未登录用户按钮
    template.find('.deleteInactiveUsersButton').on('click', () => deleteInactiveUsers(renderUsers));

    // 绑定定时任务相关按钮
    initScheduledTasksHandlers(template);

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, large: true, allowVerticalScrolling: true, allowHorizontalScrolling: true });

    renderUsers();
}

/**
 * 初始化定时任务处理器
 * @param {JQuery<HTMLElement>} template - 模板jQuery对象
 */
function initScheduledTasksHandlers(template) {
    const enabledCheckbox = template.find('#scheduledClearBackupsEnabled');
    const configDiv = template.find('#scheduledClearBackupsConfig');
    const cronInput = template.find('#scheduledClearBackupsCron');
    const saveButton = template.find('#saveScheduledClearBackups');
    const testButton = template.find('#testScheduledClearBackups');
    const loadButton = template.find('#loadScheduledClearBackups');
    const testCronButton = template.find('#testScheduledClearBackupsCron');
    const statusDiv = template.find('#scheduledClearBackupsStatus');

    // 切换启用/禁用状态
    enabledCheckbox.on('change', function() {
        if ($(this).is(':checked')) {
            configDiv.slideDown();
        } else {
            configDiv.slideUp();
        }
    });

    // 验证Cron表达式
    testCronButton.on('click', async function() {
        const cronExpression = String(cronInput.val() ?? '').trim();
        if (!cronExpression) {
            showScheduledTaskStatus(statusDiv, '请输入Cron表达式', 'error');
            return;
        }

        try {
            // 使用简单的正则验证（实际验证在服务端）
            const cronPattern = /^(\*|([0-9]|[1-5][0-9])|\*\/([0-9]|[1-5][0-9]))\s+(\*|([0-9]|1[0-9]|2[0-3])|\*\/([0-9]|1[0-9]|2[0-3]))\s+(\*|([1-9]|[12][0-9]|3[01])|\*\/([1-9]|[12][0-9]|3[01]))\s+(\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2]))\s+(\*|([0-6])|\*\/([0-6]))$/;
            if (cronPattern.test(cronExpression)) {
                showScheduledTaskStatus(statusDiv, 'Cron表达式格式正确', 'success');
            } else {
                showScheduledTaskStatus(statusDiv, 'Cron表达式格式可能不正确，请检查', 'warning');
            }
        } catch (error) {
            console.error('Error validating cron:', error);
            showScheduledTaskStatus(statusDiv, '验证失败: ' + error.message, 'error');
        }
    });

    // 保存配置
    saveButton.on('click', async function() {
        const enabled = enabledCheckbox.is(':checked');
        const cronExpression = String(cronInput.val() ?? '').trim();

        if (enabled && !cronExpression) {
            showScheduledTaskStatus(statusDiv, '启用定时任务时必须提供Cron表达式', 'error');
            return;
        }

        const button = $(this);
        const originalText = button.html();
        button.prop('disabled', true);
        button.html('<i class="fa-fw fa-solid fa-spinner fa-spin"></i><span>保存中...</span>');

        try {
            const response = await fetch('/api/scheduled-tasks/config', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    enabled: enabled,
                    cronExpression: cronExpression,
                }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || '保存配置失败');
            }

            const data = await response.json();
            showScheduledTaskStatus(statusDiv, data.message || '配置已保存', 'success');
            toastr.success(data.message || '定时任务配置已保存', '成功');
        } catch (error) {
            console.error('Error saving scheduled task config:', error);
            showScheduledTaskStatus(statusDiv, '保存失败: ' + error.message, 'error');
            toastr.error('保存定时任务配置失败: ' + error.message, '错误');
        } finally {
            button.prop('disabled', false);
            button.html(originalText);
        }
    });

    // 立即执行
    testButton.on('click', async function() {
        if (!confirm('确定要立即执行清理所有用户备份文件的任务吗？')) {
            return;
        }

        const button = $(this);
        const originalText = button.html();
        button.prop('disabled', true);
        button.html('<i class="fa-fw fa-solid fa-spinner fa-spin"></i><span>执行中...</span>');

        try {
            const response = await fetch('/api/scheduled-tasks/execute/clear-all-backups', {
                method: 'POST',
                headers: getRequestHeaders(),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || '执行失败');
            }

            const data = await response.json();
            showScheduledTaskStatus(statusDiv, data.message || '任务已开始执行，请查看服务器日志', 'success');
            toastr.info(data.message || '清理任务已开始执行，请查看服务器日志了解详情', '执行中');
        } catch (error) {
            console.error('Error executing scheduled task:', error);
            showScheduledTaskStatus(statusDiv, '执行失败: ' + error.message, 'error');
            toastr.error('执行清理任务失败: ' + error.message, '错误');
        } finally {
            button.prop('disabled', false);
            button.html(originalText);
        }
    });

    // 加载配置
    loadButton.on('click', loadScheduledTaskConfig);

    // 初始加载配置
    loadScheduledTaskConfig();

    /**
     * 加载定时任务配置
     */
    async function loadScheduledTaskConfig() {
        try {
            const response = await fetch('/api/scheduled-tasks/config', {
                method: 'GET',
                headers: getRequestHeaders(),
            });

            if (!response.ok) {
                throw new Error('加载配置失败');
            }

            const data = await response.json();
            const config = data.config || {};
            const status = data.status || {};

            // 更新UI
            enabledCheckbox.prop('checked', config.enabled || false);
            cronInput.val(config.cronExpression || '');

            if (config.enabled) {
                configDiv.show();
            } else {
                configDiv.hide();
            }

            // 显示状态
            if (status.enabled && status.running) {
                showScheduledTaskStatus(statusDiv, `定时任务已启用并运行中 (Cron: ${config.cronExpression})`, 'success');
            } else if (config.enabled) {
                showScheduledTaskStatus(statusDiv, '定时任务已配置但未运行', 'warning');
            } else {
                showScheduledTaskStatus(statusDiv, '定时任务未启用', 'info');
            }
        } catch (error) {
            console.error('Error loading scheduled task config:', error);
            showScheduledTaskStatus(statusDiv, '加载配置失败: ' + error.message, 'error');
        }
    }

    /**
     * 显示定时任务状态
     */
    function showScheduledTaskStatus(container, message, type) {
        const colors = {
            success: '#28a745',
            error: '#dc3545',
            warning: '#ffc107',
            info: '#17a2b8',
        };
        const bgColors = {
            success: '#d4edda',
            error: '#f8d7da',
            warning: '#fff3cd',
            info: '#d1ecf1',
        };

        container.css({
            'background-color': bgColors[type] || bgColors.info,
            'color': colors[type] || colors.info,
            'border': `1px solid ${colors[type] || colors.info}`,
            'padding': '10px',
            'border-radius': '5px',
            'margin-top': '10px',
        }).text(message).show();

        // 3秒后自动隐藏（除了错误信息）
        if (type !== 'error') {
            setTimeout(() => {
                container.fadeOut();
            }, 3000);
        }
    }
}

/**
 * Log out the current user.
 * @returns {Promise<void>}
 */
async function logout() {
    try {
        // 先停止用户心跳，防止在登出过程中发送心跳请求
        if (typeof window.userHeartbeat !== 'undefined' && window.userHeartbeat.stop) {
            window.userHeartbeat.stop();
        }

        // 发送登出请求
    await fetch('/api/users/logout', {
        method: 'POST',
        headers: getRequestHeaders(),
    });
} catch (error) {
    console.warn('Logout request failed:', error);
    // 即使登出请求失败，也继续执行页面跳转
}
    // On an explicit logout stop auto login
    // to allow user to change username even
    // when auto auth (such as authelia or basic)
    // would be valid
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.set('noauto', 'true');

    window.location.search = urlParams.toString();
}

/**
 * Runs a text through the slugify API endpoint.
 * @param {string} text Text to slugify
 * @returns {Promise<string>} Slugified text
 */
async function slugify(text) {
    try {
        const response = await fetch('/api/users/slugify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text }),
        });

        if (!response.ok) {
            throw new Error('Failed to slugify text');
        }

        return response.text();
    } catch (error) {
        console.error('Error slugifying text:', error);
        return text;
    }
}

/**
 * Pings the server to extend the user session.
 */
async function extendUserSession() {
    try {
        const response = await fetch('/api/ping?extend=1', {
            method: 'POST',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error('Ping did not succeed', { cause: response.status });
        }
    } catch (error) {
        console.error('Failed to extend user session', error);
    }
}

jQuery(() => {
    $('#logout_button').on('click', () => {
        logout();
    });
    $('#admin_button').on('click', () => {
        openAdminPanel();
    });
    $('#account_button').on('click', () => {
        openUserProfile();
    });
    setInterval(async () => {
        if (currentUser) {
            await extendUserSession();
        }
    }, SESSION_EXTEND_INTERVAL);
});

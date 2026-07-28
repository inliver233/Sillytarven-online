// 公用角色卡页面JavaScript

let characters = [];
let filteredCharacters = [];
let publicCharactersCurrentPage = 0;
const itemsPerPage = 12;
let isLoading = false;
let isLoggedIn = false;
let publicCharactersCurrentUser = null;
let currentCharacterId = null;
let comments = [];
let autoNameRequestId = 0;

// CSRF令牌获取函数（已不再需要）
async function getCsrfToken() {
    return null; // 不再需要CSRF令牌
}

// 检查用户登录状态
async function checkLoginStatus() {
    try {
        const response = await fetch('/api/users/me', {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (response.ok) {
            const userData = await response.json();
            isLoggedIn = true;
            publicCharactersCurrentUser = userData;
            console.log('User logged in:', userData);
            return true;
        } else {
            isLoggedIn = false;
            publicCharactersCurrentUser = null;
            console.log('User not logged in, status:', response.status);
            return false;
        }
    } catch (error) {
        console.error('Failed to check login status:', error);
        isLoggedIn = false;
        publicCharactersCurrentUser = null;
        return false;
    }
}

// 根据登录状态更新界面
function updateUIForLoginStatus() {
    if (isLoggedIn) {
        // 登录用户：显示上传按钮和用户信息
        $('#uploadButton').show();
        $('#userInfo').show();
        $('#loginPrompt').hide();

        // 更新用户信息
        if (publicCharactersCurrentUser) {
            $('#userName').text(publicCharactersCurrentUser.name || publicCharactersCurrentUser.handle);
        }
    } else {
        // 游客：隐藏上传按钮，显示登录提示
        $('#uploadButton').hide();
        $('#userInfo').hide();
        $('#loginPrompt').show();
    }
}

// 获取请求头
function getRequestHeaders(additionalHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...additionalHeaders
    };

    return headers;
}

// 显示加载指示器
function showLoading() {
    isLoading = true;
    $('#loadingIndicator').show();
}

// 隐藏加载指示器
function hideLoading() {
    isLoading = false;
    $('#loadingIndicator').hide();
}

// 显示错误消息
function showError(message) {
    // 这里可以使用toastr或其他通知库
    alert(message);
}

// 显示成功消息
function showSuccess(message) {
    // 这里可以使用toastr或其他通知库
    alert(message);
}

// 格式化日期
function formatDate(timestamp) {
    const date = parseDateInput(timestamp);
    if (!date) {
        return String(timestamp || '未知');
    }
    return date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function parseDateInput(value) {
    if (!value) {
        return null;
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }
    if (typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    if (typeof value === 'string') {
        const parsed = parseHumanizedDateTime(value);
        if (parsed) {
            return parsed;
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
}

function parseHumanizedDateTime(value) {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{2})h (\d{2})m (\d{2})s (\d{1,3})ms$/.exec(value);
    if (!match) {
        return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const millisecond = Number(match[7]);
    const date = new Date(year, month, day, hour, minute, second, millisecond);
    return Number.isNaN(date.getTime()) ? null : date;
}

async function getCharacterNameFromFile(file) {
    const fileName = String(file?.name || '').toLowerCase();
    const extension = fileName.split('.').pop() || '';
    if (extension === 'json') {
        const text = await readFileAsText(file);
        return extractNameFromCharacterData(parseJsonSafe(text));
    }
    if (extension === 'yaml' || extension === 'yml') {
        const text = await readFileAsText(file);
        return extractNameFromYaml(text);
    }
    if (extension === 'png') {
        const buffer = await readFileAsArrayBuffer(file);
        return extractNameFromPng(buffer);
    }
    return null;
}

function parseJsonSafe(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        console.debug('Failed to parse JSON character card:', error);
        return null;
    }
}

function extractNameFromCharacterData(data) {
    const name = data?.data?.name || data?.name || data?.char_name;
    if (typeof name !== 'string') {
        return null;
    }
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function extractNameFromYaml(text) {
    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (!/^\s*name\s*:/.test(line)) {
            continue;
        }
        const indent = line.match(/^\s*/)?.[0]?.length || 0;
        if (indent > 0) {
            break;
        }
        const value = extractYamlValue(line);
        if (value) {
            return value;
        }
    }

    let dataIndent = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const indent = line.match(/^\s*/)?.[0]?.length || 0;
        if (dataIndent === null) {
            if (/^\s*data\s*:\s*$/.test(line)) {
                dataIndent = indent;
            }
            continue;
        }
        if (indent <= dataIndent) {
            dataIndent = null;
            continue;
        }
        if (/^\s*name\s*:/.test(line)) {
            const value = extractYamlValue(line);
            if (value) {
                return value;
            }
        }
    }

    return null;
}

function extractYamlValue(line) {
    const match = /^\s*name\s*:\s*(.*)\s*$/.exec(line);
    if (!match) {
        return null;
    }
    let value = match[1].replace(/\s+#.*$/, '').trim();
    if (!value || value === '|' || value === '>') {
        return null;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    return value.trim() || null;
}

function extractNameFromPng(buffer) {
    const data = new Uint8Array(buffer);
    if (data.length < 8) {
        return null;
    }
    if (data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71) {
        return null;
    }
    let offset = 8;
    let charaText = null;
    while (offset + 8 <= data.length) {
        const length = readUint32(data, offset);
        const type = decodeLatin1(data.slice(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > data.length) {
            break;
        }
        if (type === 'tEXt') {
            const chunkData = data.slice(dataStart, dataEnd);
            const nullIndex = chunkData.indexOf(0);
            if (nullIndex > -1) {
                const keyword = decodeLatin1(chunkData.slice(0, nullIndex)).toLowerCase();
                const text = decodeLatin1(chunkData.slice(nullIndex + 1));
                if (keyword === 'ccv3') {
                    const name = parseNameFromBase64Card(text);
                    if (name) {
                        return name;
                    }
                } else if (keyword === 'chara' && !charaText) {
                    charaText = text;
                }
            }
        }
        offset = dataEnd + 4;
        if (type === 'IEND') {
            break;
        }
    }
    return charaText ? parseNameFromBase64Card(charaText) : null;
}

function parseNameFromBase64Card(base64Text) {
    try {
        const jsonText = decodeBase64ToUtf8(base64Text);
        return extractNameFromCharacterData(JSON.parse(jsonText));
    } catch (error) {
        console.debug('Failed to parse PNG character metadata:', error);
        return null;
    }
}

function decodeBase64ToUtf8(base64Text) {
    const binary = atob(base64Text.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

function readUint32(data, offset) {
    return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function decodeLatin1(bytes) {
    return new TextDecoder('latin1').decode(bytes);
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsText(file);
    });
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsArrayBuffer(file);
    });
}

// 加载角色卡列表
async function loadCharacters() {
    try {
        showLoading();

        const response = await fetch('/api/public-characters/?summary=1', {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                // 未登录或无权限：提示并显示登录提示区块
                console.log('Not authorized to load public characters. Status:', response.status);
                isLoggedIn = false;
                updateUIForLoginStatus();
                showError('请先登录后再访问公共角色卡');
                // 可选：短暂延迟后跳转到登录页
                // setTimeout(() => { window.location.href = '/login'; }, 1500);
                return;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        characters = data;
        filteredCharacters = [...characters];

        renderCharacters();
    } catch (error) {
        console.error('Failed to load characters:', error);
        if (String(error && error.message || '').includes('status: 401') || String(error && error.message || '').includes('status: 403')) {
            showError('请先登录后再访问公共角色卡');
        } else {
            showError('加载角色卡失败');
        }
    } finally {
        hideLoading();
    }
}

// 渲染角色卡（初始加载或重新筛选时使用）
function renderCharacters() {
    const grid = $('#charactersGrid');
    grid.empty();

    // 重置页码
    publicCharactersCurrentPage = 0;

    const startIndex = 0;
    const endIndex = itemsPerPage;
    const pageCharacters = filteredCharacters.slice(startIndex, endIndex);

    if (pageCharacters.length === 0) {
        grid.html(`
            <div class="no-characters">
                <i class="fa-solid fa-search" style="font-size: 3rem; color: rgba(255,255,255,0.5); margin-bottom: 1rem;"></i>
                <h3>暂无角色卡</h3>
                <p>还没有用户上传角色卡，快来上传第一个吧！</p>
            </div>
        `);
        $('#loadMoreButton').hide();
        return;
    }

    pageCharacters.forEach(character => {
        const card = createCharacterCard(character);
        grid.append(card);
    });

    // 显示/隐藏加载更多按钮
    updateLoadMoreButton();
}

// 追加更多角色卡（加载更多时使用）
function appendMoreCharacters() {
    const grid = $('#charactersGrid');

    const startIndex = (publicCharactersCurrentPage + 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const pageCharacters = filteredCharacters.slice(startIndex, endIndex);

    if (pageCharacters.length === 0) {
        $('#loadMoreButton').hide();
        return;
    }

    pageCharacters.forEach(character => {
        const card = createCharacterCard(character);
        grid.append(card);
    });

    // 更新页码
    publicCharactersCurrentPage++;

    // 显示/隐藏加载更多按钮
    updateLoadMoreButton();
}

// 更新加载更多按钮的显示状态
function updateLoadMoreButton() {
    const totalLoaded = (publicCharactersCurrentPage + 1) * itemsPerPage;
    if (totalLoaded < filteredCharacters.length) {
        $('#loadMoreButton').show();
    } else {
        $('#loadMoreButton').hide();
    }
}

function getAvatarUrl(character) {
    const avatarName = String(character?.avatar || '');
    const lowerName = avatarName.toLowerCase();
    const isImage = lowerName.endsWith('.png')
        || lowerName.endsWith('.jpg')
        || lowerName.endsWith('.jpeg')
        || lowerName.endsWith('.gif')
        || lowerName.endsWith('.webp');
    if (avatarName && isImage) {
        const encodedAvatar = encodeURIComponent(avatarName);
        return `/api/public-characters/avatar/${encodedAvatar}`;
    }
    return '/img/default-expressions/neutral.png';
}

// 创建角色卡元素
function createCharacterCard(character) {
    // 根据文件类型确定头像URL
    const avatarUrl = getAvatarUrl(character);

    const tags = character.tags || [];
    const tagsHtml = tags.map(tag => `<span class="character-tag">${tag}</span>`).join('');

    // 检查当前用户是否有删除权限
    const canDelete = isLoggedIn && (
        publicCharactersCurrentUser?.admin ||
        character.uploader?.handle === publicCharactersCurrentUser?.handle
    );

    // 根据登录状态显示不同的按钮
    const importButton = isLoggedIn ?
        `<button class="btn btn-primary import-btn" onclick="importCharacter('${character.id}')">
            <i class="fa-solid fa-download"></i>
            导入
        </button>` :
        `<button class="btn btn-secondary import-btn" onclick="showLoginPrompt()" disabled>
            <i class="fa-solid fa-lock"></i>
            登录后导入
        </button>`;

    // 删除按钮（仅对有权限的用户显示）
    const deleteButton = canDelete ?
        `<button class="btn btn-danger delete-btn" onclick="deleteCharacter('${character.id}', '${character.name}')">
            <i class="fa-solid fa-trash"></i>
            删除
        </button>` : '';

    return `
        <div class="character-card" data-character="${character.id}">
            <div class="character-avatar">
                <img src="${avatarUrl}" alt="${character.name}" onerror="this.src='/img/default-expressions/neutral.png'">
            </div>
            <div class="character-info">
                <div class="character-content">
                    <h3 class="character-name">${character.name}</h3>
                    <p class="character-description">${character.description || '暂无描述'}</p>
                </div>
                <div class="character-footer">
                    <div class="character-meta">
                        <span class="character-uploader">
                            <i class="fa-solid fa-user"></i>
                            ${character.uploader?.name || character.uploader || 'Unknown'}
                        </span>
                        <span class="character-date">
                            <i class="fa-solid fa-calendar"></i>
                            ${formatDate(character.uploaded_at || character.date_added)}
                        </span>
                    </div>
                    ${tagsHtml ? `<div class="character-tags">${tagsHtml}</div>` : ''}
                </div>
            </div>
            <div class="character-actions">
                ${importButton}
                <button class="btn btn-secondary view-btn" onclick="viewCharacter('${character.id}')">
                    <i class="fa-solid fa-eye"></i>
                    查看
                </button>
                ${deleteButton}
            </div>
        </div>
    `;
}

// 搜索和筛选角色卡
function filterCharacters() {
    const searchTerm = String($('#searchInput').val() || '').toLowerCase();
    const sortBy = String($('#sortSelect').val() || '');

    filteredCharacters = characters.filter(character => {
        const nameMatch = character.name.toLowerCase().includes(searchTerm);
        const descriptionMatch = (character.description || '').toLowerCase().includes(searchTerm);
        const uploaderMatch = String(character.uploader?.name || character.uploader || '').toLowerCase().includes(searchTerm);
        const tagsMatch = (character.tags || []).some(tag => tag.toLowerCase().includes(searchTerm));

        return nameMatch || descriptionMatch || uploaderMatch || tagsMatch;
    });

    // 排序
    filteredCharacters.sort((a, b) => {
        switch (sortBy) {
            case 'name':
                return a.name.localeCompare(b.name);
            case 'uploader':
                const uploaderA = a.uploader?.name || a.uploader || '';
                const uploaderB = b.uploader?.name || b.uploader || '';
                return uploaderA.localeCompare(uploaderB);
            case 'date':
            default:
                const dateA = parseDateInput(a.uploaded_at || a.date_added);
                const dateB = parseDateInput(b.uploaded_at || b.date_added);
                return (dateB?.getTime() || 0) - (dateA?.getTime() || 0);
        }
    });

    publicCharactersCurrentPage = 0;
    renderCharacters();
}

// 导入角色卡
async function importCharacter(characterId) {
    if (!isLoggedIn) {
        showError('请先登录后再导入角色卡');
        return;
    }

    try {
        const response = await fetch(`/api/public-characters/${characterId}/import`, {
            method: 'POST',
            credentials: 'include'
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '导入失败');
        }

        const data = await response.json();
        showSuccess(data.message || '角色卡已成功导入到您的角色库！');

        // 可以选择跳转到角色库页面
        // window.location.href = '/';

    } catch (error) {
        console.error('Failed to import character:', error);
        showError(`导入失败: ${error.message}`);
    }
}

// 删除角色卡
async function deleteCharacter(characterId, characterDisplayName) {
    if (!isLoggedIn) {
        showError('请先登录后再删除角色卡');
        return;
    }

    // 确认删除
    if (!confirm(`确定要删除角色卡 "${characterDisplayName}" 吗？此操作不可撤销。`)) {
        return;
    }

    try {
        const response = await fetch(`/api/public-characters/${characterId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '删除失败');
        }

        const result = await response.json();
        showSuccess(`角色卡 "${characterDisplayName}" 删除成功！`);

        // 刷新角色卡列表
        await loadCharacters();
    } catch (error) {
        console.error('Failed to delete character:', error);
        showError(`删除失败: ${error.message}`);
    }
}

// 查看角色卡详情
async function viewCharacter(characterId) {
    try {
        const response = await fetch(`/api/public-characters/${characterId}`, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('获取角色卡详情失败');
        }

        const character = await response.json();
        showCharacterModal(character);

    } catch (error) {
        console.error('Failed to get character details:', error);
        showError('获取角色卡详情失败');
    }
}

// 显示登录提示
function showLoginPrompt() {
    showError('请先登录后再导入角色卡');
}

// 显示角色卡详情模态框
function showCharacterModal(character) {
    // 设置当前角色卡ID
    currentCharacterId = character.id;

    // 根据文件类型确定头像URL
    const avatarUrl = getAvatarUrl(character);

    const tags = character.tags || [];
    const tagsHtml = tags.map(tag => `<span class="character-tag">${tag}</span>`).join('');

    $('#characterModalTitle').text(character.name);
    $('#characterModalAvatar').attr('src', avatarUrl);
    $('#characterModalName').text(character.name);
    $('#characterModalDescription').text(character.description || '暂无描述');
    $('#characterModalUploader').text(character.uploader?.name || character.uploader || 'Unknown');
    $('#characterModalDate').text(formatDate(character.uploaded_at || character.date_added));
    $('#characterModalTags').html(tagsHtml);

    // 根据登录状态设置导入按钮
    if (isLoggedIn) {
        $('#importCharacterButton').off('click').on('click', () => {
            importCharacter(character.id);
            $('#characterModal').hide();
        });
        $('#importCharacterButton').prop('disabled', false).html('<i class="fa-solid fa-download"></i> 导入到我的角色库');
    } else {
        $('#importCharacterButton').off('click').on('click', () => {
            showLoginPrompt();
            $('#characterModal').hide();
        });
        $('#importCharacterButton').prop('disabled', true).html('<i class="fa-solid fa-lock"></i> 登录后导入');
    }

    // 设置查看按钮事件
    $('#viewCharacterButton').off('click').on('click', () => {
        // 这里可以跳转到角色卡详情页面或显示更多信息
        $('#characterModal').hide();
    });

    // 更新评论区域显示状态
    updateCommentsSection();

    // 加载评论
    loadComments(character.id);

    $('#characterModal').show();
}

// 上传角色卡
async function uploadCharacter(formData) {
    try {
        const response = await fetch('/api/public-characters/upload', {
            method: 'POST',
            body: formData,
            credentials: 'include'
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '上传失败');
        }

        const data = await response.json();
        showSuccess(`角色卡 "${data.name}" 上传成功！`);

        // 重新加载角色卡列表
        await loadCharacters();

        // 关闭上传模态框
        $('#uploadModal').hide();
        /** @type {HTMLFormElement} */ ($('#uploadForm')[0]).reset();

    } catch (error) {
        console.error('Failed to upload character:', error);
        showError(`上传失败: ${error.message}`);
    }
}

// 加载更多角色卡
function loadMore() {
    const button = $('#loadMoreButton');
    const originalText = button.html();

    // 显示加载状态
    button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 加载中...');

    // 模拟异步加载（给用户反馈）
    setTimeout(() => {
        appendMoreCharacters();

        // 恢复按钮状态
        button.prop('disabled', false).html(originalText);
    }, 300);
}

// 事件监听器
$(document).ready(async function() {
    try {
        // 检查登录状态
        await checkLoginStatus();

        // 根据登录状态更新界面
        updateUIForLoginStatus();

        // 加载角色卡列表
        await loadCharacters();

        // 搜索输入事件
        $('#searchInput').on('input', filterCharacters);

        // 排序选择事件
        $('#sortSelect').on('change', filterCharacters);

        // 加载更多按钮
        $('#loadMoreButton').on('click', loadMore);

        // 上传按钮（只有登录用户才能看到）
        $('#uploadButton').on('click', () => {
            if (!isLoggedIn) {
                showError('请先登录后再上传角色卡');
                return;
            }
            $('#uploadModal').show();
        });

        // 关闭上传模态框
        $('#closeUploadModal, #cancelUpload').on('click', () => {
            $('#uploadModal').hide();
            /** @type {HTMLFormElement} */ ($('#uploadForm')[0]).reset();
        });

        // 关闭角色卡详情模态框
        $('#closeCharacterModal').on('click', () => {
            $('#characterModal').hide();
        });

        // 点击模态框外部关闭
        $('.modal').on('click', function(e) {
            if (e.target === this) {
                $(this).hide();
            }
        });

        // 上传表单提交
        $('#uploadForm').on('submit', async function(e) {
            e.preventDefault();

            if (!isLoggedIn) {
                showError('请先登录后再上传角色卡');
                return;
            }

            const fileInput = $('#characterFile')[0];
            const nameInput = String($('#characterName').val() || '');
            const descriptionInput = String($('#characterDescription').val() || '');
            const tagsInput = String($('#characterTags').val() || '');

            if (!/** @type {HTMLInputElement} */ (fileInput).files || !/** @type {HTMLInputElement} */ (fileInput).files[0]) {
                showError('请选择角色卡文件');
                return;
            }

            if (!nameInput.trim()) {
                showError('请输入角色名称');
                return;
            }

            const formData = new FormData();
            formData.append('avatar', /** @type {HTMLInputElement} */ (fileInput).files[0]);

            // 获取文件扩展名
            const fileName = /** @type {HTMLInputElement} */ (fileInput).files[0].name;
            const extension = fileName.split('.').pop()?.toLowerCase() || '';
            formData.append('file_type', extension);

            // 添加其他信息
            if (nameInput.trim()) {
                formData.append('name', nameInput.trim());
            }
            if (descriptionInput.trim()) {
                formData.append('description', descriptionInput.trim());
            }
            if (tagsInput.trim()) {
                const tags = tagsInput.split(',').map(tag => tag.trim()).filter(tag => tag);
                formData.append('tags', JSON.stringify(tags));
            }

            await uploadCharacter(formData);
        });

        // 文件选择时自动填充名称
        $('#characterFile').on('change', async function() {
            const file = /** @type {HTMLInputElement} */ (this).files?.[0];
            if (!file) {
                return;
            }
            const fileName = file.name;
            const nameWithoutExt = fileName.replace(/\.[^/.]+$/, "");
            $('#characterName').val(nameWithoutExt);
            const requestId = ++autoNameRequestId;
            try {
                const extractedName = await getCharacterNameFromFile(file);
                if (!extractedName || requestId !== autoNameRequestId) {
                    return;
                }
                $('#characterName').val(extractedName);
            } catch (error) {
                console.debug('Failed to extract character name:', error);
            }
        });

        // 评论相关事件监听器
        $('#submitCommentButton').on('click', submitComment);

        // 回车键提交评论
        $('#commentInput').on('keydown', function(e) {
            if (e.ctrlKey && e.keyCode === 13) { // Ctrl + Enter
                submitComment();
            }
        });

    } catch (error) {
        console.error('Failed to initialize page:', error);
        showError('页面初始化失败，请刷新页面重试');
    }
});

// 添加一些样式到页面
$('<style>').text(`
    .no-characters {
        grid-column: 1 / -1;
        text-align: center;
        padding: 3rem;
        color: rgba(255,255,255,0.7);
    }

    .no-characters h3 {
        margin: 1rem 0 0.5rem 0;
        color: #ffffff;
    }

    .no-characters p {
        margin: 0;
        font-size: 1rem;
    }
`).appendTo('head');

// 评论相关功能

// 加载角色卡评论
async function loadComments(characterId) {
    try {
        const response = await fetch(`/api/public-characters/${characterId}/comments`, {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        comments = await response.json();
        renderComments();
        updateCommentsCount();
    } catch (error) {
        console.error('Failed to load comments:', error);
        showError('加载评论失败');
    }
}

// 渲染评论列表
function renderComments() {
    const commentsList = $('#commentsList');
    commentsList.empty();

    if (comments.length === 0) {
        commentsList.html(`
            <div class="no-comments">
                <i class="fa-solid fa-comment" style="font-size: 2rem; color: rgba(255,255,255,0.3); margin-bottom: 1rem;"></i>
                <p>还没有评论，来发表第一条评论吧！</p>
            </div>
        `);
        return;
    }

    comments.forEach(comment => {
        const commentElement = createCommentElement(comment, 0);
        commentsList.append(commentElement);
    });
}

// 创建评论元素
function createCommentElement(comment, depth = 0) {
    const isAuthor = isLoggedIn && publicCharactersCurrentUser && comment.author.handle === publicCharactersCurrentUser.handle;
    const isAdmin = isLoggedIn && publicCharactersCurrentUser && publicCharactersCurrentUser.admin;
    const canDelete = isAuthor || isAdmin;

    const deleteButton = canDelete ?
        `<button class="comment-delete" onclick="deleteComment('${comment.id}')" title="删除评论">
            <i class="fa-solid fa-trash"></i>
        </button>` : '';

    const replyButton = isLoggedIn ?
        `<button class="comment-reply" onclick="showReplyInput('${comment.id}')" title="回复">
            <i class="fa-solid fa-reply"></i>
            回复
        </button>` : '';

    let repliesHtml = '';
    if (comment.replies && comment.replies.length > 0) {
        repliesHtml = '<div class="comment-replies">';
        comment.replies.forEach(reply => {
            repliesHtml += createCommentElement(reply, depth + 1);
        });
        repliesHtml += '</div>';
    }

    return `
        <div class="comment-item" data-comment-id="${comment.id}" style="margin-left: ${depth * 20}px;">
            <div class="comment-header">
                <div class="comment-author">
                    <i class="fa-solid fa-user"></i>
                    <span class="author-name">${comment.author.name || comment.author.handle}</span>
                    <span class="comment-date">${formatDate(comment.created_at)}</span>
                </div>
                <div class="comment-actions">
                    ${replyButton}
                    ${deleteButton}
                </div>
            </div>
            <div class="comment-content">
                ${escapeHtml(comment.content)}
            </div>
            <div class="comment-reply-input" id="replyInput_${comment.id}" style="display: none;">
                <textarea class="reply-textarea" placeholder="写下你的回复..." rows="2"></textarea>
                <div class="reply-actions">
                    <button class="btn btn-primary btn-small" onclick="submitReply('${comment.id}')">
                        <i class="fa-solid fa-paper-plane"></i>
                        回复
                    </button>
                    <button class="btn btn-secondary btn-small" onclick="cancelReply('${comment.id}')">
                        取消
                    </button>
                </div>
            </div>
            ${repliesHtml}
        </div>
    `;
}

// HTML转义函数
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
}

// 更新评论数量
function updateCommentsCount() {
    const totalComments = countTotalComments(comments);
    $('#commentsCount').text(`${totalComments} 条评论`);
}

// 递归计算总评论数
function countTotalComments(commentsList) {
    let count = commentsList.length;
    commentsList.forEach(comment => {
        if (comment.replies && comment.replies.length > 0) {
            count += countTotalComments(comment.replies);
        }
    });
    return count;
}

// 发表评论
async function submitComment() {
    if (!isLoggedIn) {
        showError('请先登录后再发表评论');
        return;
    }

    const content = String($('#commentInput').val() || '').trim();
    if (!content) {
        showError('请输入评论内容');
        return;
    }

    try {
        const response = await fetch(`/api/public-characters/${currentCharacterId}/comments`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: content
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '发表评论失败');
        }

        const newComment = await response.json();
        comments.push(newComment);

        // 清空输入框
        $('#commentInput').val('');

        // 重新渲染评论
        renderComments();
        updateCommentsCount();

        showSuccess('评论发表成功！');
    } catch (error) {
        console.error('Failed to submit comment:', error);
        showError(`发表评论失败: ${error.message}`);
    }
}

// 显示回复输入框
function showReplyInput(commentId) {
    if (!isLoggedIn) {
        showError('请先登录后再回复评论');
        return;
    }

    // 隐藏所有其他回复输入框
    $('.comment-reply-input').hide();

    // 显示指定的回复输入框
    $(`#replyInput_${commentId}`).show();
    $(`#replyInput_${commentId} .reply-textarea`).focus();
}

// 取消回复
function cancelReply(commentId) {
    $(`#replyInput_${commentId}`).hide();
    $(`#replyInput_${commentId} .reply-textarea`).val('');
}

// 提交回复
async function submitReply(parentId) {
    if (!isLoggedIn) {
        showError('请先登录后再回复评论');
        return;
    }

    const content = String($(`#replyInput_${parentId} .reply-textarea`).val() || '').trim();
    if (!content) {
        showError('请输入回复内容');
        return;
    }

    try {
        const response = await fetch(`/api/public-characters/${currentCharacterId}/comments`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: content,
                parentId: parentId
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '回复失败');
        }

        // 重新加载评论
        await loadComments(currentCharacterId);

        // 隐藏回复输入框
        cancelReply(parentId);

        showSuccess('回复发表成功！');
    } catch (error) {
        console.error('Failed to submit reply:', error);
        showError(`回复失败: ${error.message}`);
    }
}

// 删除评论
async function deleteComment(commentId) {
    if (!isLoggedIn) {
        showError('请先登录后再删除评论');
        return;
    }

    if (!confirm('确定要删除这条评论吗？此操作不可撤销。')) {
        return;
    }

    try {
        const response = await fetch(`/api/public-characters/${currentCharacterId}/comments/${commentId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '删除失败');
        }

        // 重新加载评论
        await loadComments(currentCharacterId);

        showSuccess('评论删除成功！');
    } catch (error) {
        console.error('Failed to delete comment:', error);
        showError(`删除失败: ${error.message}`);
    }
}

// 更新评论区域的显示状态
function updateCommentsSection() {
    if (isLoggedIn) {
        $('#commentInputSection').show();
        $('#commentLoginPrompt').hide();
    } else {
        $('#commentInputSection').hide();
        $('#commentLoginPrompt').show();
    }
}

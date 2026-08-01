/**
 * 公共页面配置管理
 * 根据服务器配置动态控制页面链接的显示
 */

let publicPagesConfig = {
    enablePublicCharacters: true,
    enableForum: true,
    registrationAvailable: true,
};

/**
 * 获取公共页面配置
 */
async function fetchPublicPagesConfig() {
    try {
        const response = await fetch('/api/public-config/public-pages', {
            method: 'GET',
            credentials: 'include',
        });

        if (response.ok) {
            const config = await response.json();
            publicPagesConfig = { ...publicPagesConfig, ...config };
            return publicPagesConfig;
        } else {
            console.warn('Failed to fetch public pages config, using defaults');
            return publicPagesConfig;
        }
    } catch (error) {
        console.warn('Error fetching public pages config:', error);
        return publicPagesConfig;
    }
}

/**
 * 注册页是所有注册方式的统一入口，仅在至少一种方式可用时显示。
 */
async function fetchRegistrationAvailability() {
    try {
        const [registrationResponse, oauthResponse] = await Promise.all([
            fetch('/api/users/registration-config', { credentials: 'include' }),
            fetch('/api/oauth/config', { credentials: 'include' }),
        ]);
        if (!registrationResponse.ok || !oauthResponse.ok) {
            return publicPagesConfig.registrationAvailable;
        }

        const registration = await registrationResponse.json();
        const oauth = await oauthResponse.json();
        const oauthProviders = ['github', 'discord', 'linuxdo'];
        publicPagesConfig.registrationAvailable = registration.password?.enabled !== false ||
            oauthProviders.some(provider =>
                registration[provider]?.enabled !== false &&
                oauth[provider]?.enabled === true &&
                oauth[provider]?.registrationEnabled !== false);
        return publicPagesConfig.registrationAvailable;
    } catch (error) {
        console.warn('Error fetching registration availability:', error);
        return publicPagesConfig.registrationAvailable;
    }
}

/**
 * 根据配置隐藏或显示页面链接
 */
function updatePageLinks() {
    // 更新角色卡分享链接
    const publicCharactersLinks = document.querySelectorAll('a[href="/public-characters"], #publicCharactersLink');
    publicCharactersLinks.forEach(link => {
        if (!publicPagesConfig.enablePublicCharacters) {
            link.style.display = 'none';
        } else {
            link.style.display = '';
        }
    });

    // 更新论坛链接
    const forumLinks = document.querySelectorAll('a[href="/forum"], #forumLink');
    forumLinks.forEach(link => {
        if (!publicPagesConfig.enableForum) {
            link.style.display = 'none';
        } else {
            link.style.display = '';
        }
    });

    const registrationLinks = document.querySelectorAll('a[href="/register"], #registrationLink');
    registrationLinks.forEach(link => {
        link.style.display = publicPagesConfig.registrationAvailable ? '' : 'none';
    });
}

/**
 * 初始化公共页面配置
 */
async function initPublicPagesConfig() {
    await Promise.all([
        fetchPublicPagesConfig(),
        fetchRegistrationAvailability(),
    ]);
    updatePageLinks();
}

// 当DOM加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPublicPagesConfig);
} else {
    initPublicPagesConfig();
}

// 导出函数供其他脚本使用
window.publicPagesConfig = {
    fetch: fetchPublicPagesConfig,
    update: updatePageLinks,
    init: initPublicPagesConfig,
    getConfig: () => publicPagesConfig,
};

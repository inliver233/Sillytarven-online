import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import storage from 'node-persist';
import fetch from 'node-fetch';
import { getConfigValue } from '../util.js';
import {
    toKey,
    getUserAvatar,
    normalizeHandle,
    KEY_PREFIX,
    getUserDirectories,
    ensurePublicDirectoriesExist,
    toAvatarKey
} from '../users.js';
import {
    validateInvitationCode,
    useInvitationCode,
    isInvitationCodesEnabled
} from '../invitation-codes.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { applyDefaultTemplateToUser } from '../default-template.js';

export const router = express.Router();
const USER_STORAGE_ENABLED = getConfigValue('userStorage.enabled', false, 'boolean');
const USER_STORAGE_DEFAULT_LIMIT_MIB = getConfigValue('userStorage.defaultLimitMiB', 0, 'number');

/**
 * 处理 Discourse avatar template
 * @param {string} template Avatar template 字符串
 * @param {string} baseUrl 基础 URL
 * @returns {string|null} 完整的头像 URL
 */
function processDiscourseAvatarTemplate(template, baseUrl = 'https://connect.linux.do') {
    if (!template) return null;

    // 如果已经是完整 URL，直接返回
    if (template.startsWith('http://') || template.startsWith('https://')) {
        return template.replace('{size}', '96');
    }

    // 处理相对路径，替换 {size} 占位符
    const path = template.replace('{size}', '96');
    return `${baseUrl}${path}`;
}


/**
 * 解码JWT token（仅解码payload，不验证签名）
 * @param {string} token JWT token
 * @returns {object|null} 解码后的payload对象，失败返回null
 */
function decodeJWT(token) {
    try {
        if (!token || typeof token !== 'string') {
            return null;
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            return null;
        }

        // JWT payload是base64url编码的，需要处理padding
        const payload = parts[1];
        const paddedPayload = payload + '='.repeat((4 - payload.length % 4) % 4);

        // 将base64url转换为base64
        const base64Payload = paddedPayload.replace(/-/g, '+').replace(/_/g, '/');

        // 解码
        const decoded = Buffer.from(base64Payload, 'base64').toString('utf-8');
        const parsedPayload = JSON.parse(decoded);

        return parsedPayload;
    } catch (error) {
        console.error('Error decoding JWT:', error.message);
        return null;
    }
}

/**
 * 动态构建OAuth回调URL
 * @param {express.Request} request Express请求对象
 * @param {string} provider OAuth提供商 (github/discord/linuxdo)
 * @returns {string} 回调URL
 */
function buildCallbackUrl(request, provider) {
    // 优先从请求头获取（支持反向代理）
    // request.protocol 由 Express 的 trust proxy 设置决定
    let protocol = request.protocol;

    // 如果没有设置 trust proxy，尝试从请求头获取
    if (!protocol || protocol === 'http' || protocol === 'https') {
        const forwardedProto = request.get('x-forwarded-proto');
        if (forwardedProto) {
            protocol = forwardedProto.split(',')[0].trim();
        }
    }

    // 默认使用 http
    if (!protocol || (protocol !== 'http' && protocol !== 'https')) {
        protocol = 'http';
    }

    // 获取主机名（支持反向代理）
    let host = request.get('host') || request.get('x-forwarded-host');

    // 如果没有从请求头获取到，使用默认值
    if (!host) {
        host = 'localhost';
    }

    // 如果host不包含端口，从配置中获取端口
    let hostname = host;
    if (!host.includes(':')) {
        const port = getConfigValue('port', 8000, 'number');
        // 标准端口不需要显示
        if ((protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443)) {
            hostname = `${host}:${port}`;
        }
    }

    // 确保协议正确（如果配置了SSL，强制使用https）
    const sslEnabled = getConfigValue('ssl.enabled', false, 'boolean');
    const finalProtocol = sslEnabled ? 'https' : protocol;

    return `${finalProtocol}://${hostname}/api/oauth/${provider}/callback`;
}

// 存储 OIDC 配置的缓存（避免频繁请求）
const oidcConfigCache = new Map();
const OIDC_CACHE_TTL = 60 * 60 * 1000; // 1小时缓存
const OIDC_FAILURE_TTL = 5 * 60 * 1000; // 5分钟失败缓存
const OIDC_REQUEST_TIMEOUT = 3000; // 3秒超时

/**
 * 从 OIDC 配置端点获取配置
 * @param {string} wellKnownEndpoint OIDC 配置端点 URL
 * @returns {Promise<object|null>} OIDC 配置对象，失败返回 null
 */
async function fetchOIDCConfig(wellKnownEndpoint) {
    try {
        // 检查缓存
        const cached = oidcConfigCache.get(wellKnownEndpoint);
        if (cached) {
            if (cached.failed && (Date.now() - cached.timestamp < OIDC_FAILURE_TTL)) {
                return null;
            }
            if (cached.config && (Date.now() - cached.timestamp < OIDC_CACHE_TTL)) {
                return cached.config;
            }
        }

        // 从端点获取配置
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OIDC_REQUEST_TIMEOUT);
        const response = await fetch(wellKnownEndpoint, {
            headers: {
                'Accept': 'application/json',
            },
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`Failed to fetch OIDC config from ${wellKnownEndpoint}: ${response.status}`);
            oidcConfigCache.set(wellKnownEndpoint, { failed: true, timestamp: Date.now() });
            return null;
        }

        /** @type {any} */
        const config = await response.json();

        // 验证必需的字段
        if (!config.authorization_endpoint || !config.token_endpoint) {
            console.error('Invalid OIDC config: missing required endpoints');
            oidcConfigCache.set(wellKnownEndpoint, { failed: true, timestamp: Date.now() });
            return null;
        }

        // 缓存配置
        oidcConfigCache.set(wellKnownEndpoint, {
            config: config,
            timestamp: Date.now(),
        });
        return config;
    } catch (error) {
        const errorMessage = error && error.name === 'AbortError'
            ? `timeout after ${OIDC_REQUEST_TIMEOUT}ms`
            : error?.message;
        console.error(`Error fetching OIDC config from ${wellKnownEndpoint}:`, errorMessage);
        oidcConfigCache.set(wellKnownEndpoint, { failed: true, timestamp: Date.now() });
        return null;
    }
}

/**
 * 获取OAuth配置（动态回调URL）
 * @param {express.Request} request Express请求对象
 * @returns {Promise<object>} OAuth配置对象
 */
async function getOAuthConfig(request) {
    // 动态构建回调URL
    const githubCallbackUrl = getConfigValue('oauth.github.callbackUrl', '', null) || buildCallbackUrl(request, 'github');
    const discordCallbackUrl = getConfigValue('oauth.discord.callbackUrl', '', null) || buildCallbackUrl(request, 'discord');
    const linuxdoCallbackUrl = getConfigValue('oauth.linuxdo.callbackUrl', '', null) || buildCallbackUrl(request, 'linuxdo');

    const linuxdoEnabled = getConfigValue('oauth.linuxdo.enabled', false, 'boolean');
    // Linux.do 配置：支持从 OIDC 配置端点自动发现
    // 默认端点参考官方文档：https://connect.linux.do/oauth2/authorize, token, /api/user
    let linuxdoAuthUrl = String(getConfigValue('oauth.linuxdo.authUrl', 'https://connect.linux.do/oauth2/authorize') || 'https://connect.linux.do/oauth2/authorize');
    let linuxdoTokenUrl = String(getConfigValue('oauth.linuxdo.tokenUrl', 'https://connect.linux.do/oauth2/token') || 'https://connect.linux.do/oauth2/token');
    let linuxdoUserInfoUrl = String(getConfigValue('oauth.linuxdo.userInfoUrl', 'https://connect.linux.do/api/user') || 'https://connect.linux.do/api/user');

    // 如果配置了 OIDC 配置端点，尝试从端点获取配置
    const wellKnownEndpoint = getConfigValue('oauth.linuxdo.wellKnownEndpoint', '', null);
    if (linuxdoEnabled && wellKnownEndpoint && wellKnownEndpoint.trim()) {
        const oidcConfig = await fetchOIDCConfig(wellKnownEndpoint.trim());
        if (oidcConfig) {
            // 使用从 OIDC 配置端点获取的端点
            linuxdoAuthUrl = oidcConfig.authorization_endpoint || linuxdoAuthUrl;
            linuxdoTokenUrl = oidcConfig.token_endpoint || linuxdoTokenUrl;
            // userinfo_endpoint 可能不存在，使用默认值
            linuxdoUserInfoUrl = oidcConfig.userinfo_endpoint || linuxdoUserInfoUrl;
        }
    }

    return {
        github: {
            enabled: getConfigValue('oauth.github.enabled', false, 'boolean'),
            clientId: String(getConfigValue('oauth.github.clientId', '') || ''),
            clientSecret: String(getConfigValue('oauth.github.clientSecret', '') || ''),
            callbackUrl: githubCallbackUrl,
            authUrl: 'https://github.com/login/oauth/authorize',
            tokenUrl: 'https://github.com/login/oauth/access_token',
            userInfoUrl: 'https://api.github.com/user',
        },
        discord: {
            enabled: getConfigValue('oauth.discord.enabled', false, 'boolean'),
            clientId: String(getConfigValue('oauth.discord.clientId', '') || ''),
            clientSecret: String(getConfigValue('oauth.discord.clientSecret', '') || ''),
            callbackUrl: discordCallbackUrl,
            authUrl: 'https://discord.com/api/oauth2/authorize',
            tokenUrl: 'https://discord.com/api/oauth2/token',
            userInfoUrl: 'https://discord.com/api/users/@me',
        },
        linuxdo: {
            enabled: linuxdoEnabled,
            clientId: String(getConfigValue('oauth.linuxdo.clientId', '') || ''),
            clientSecret: String(getConfigValue('oauth.linuxdo.clientSecret', '') || ''),
            callbackUrl: linuxdoCallbackUrl,
            authUrl: linuxdoAuthUrl,
            tokenUrl: linuxdoTokenUrl,
            userInfoUrl: linuxdoUserInfoUrl,
        },
    };
}

// 存储OAuth状态的临时缓存
const oauthStateCache = new Map();

/**
 * 生成随机state用于OAuth安全验证
 */
function generateState() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 获取OAuth配置信息（公开API，用于前端判断是否显示按钮）
 */
router.get('/config', async (request, response) => {
    try {
        const oauthConfig = await getOAuthConfig(request);
        const config = {
            github: {
                enabled: oauthConfig.github.enabled && !!oauthConfig.github.clientId,
            },
            discord: {
                enabled: oauthConfig.discord.enabled && !!oauthConfig.discord.clientId,
            },
            linuxdo: {
                enabled: oauthConfig.linuxdo.enabled && !!oauthConfig.linuxdo.clientId,
            },
        };
        return response.json(config);
    } catch (error) {
        console.error('Error getting OAuth config:', error);
        return response.status(500).json({ error: '获取OAuth配置失败' });
    }
});

/**
 * GitHub OAuth授权端点
 */
router.get('/github', async (request, response) => {
    try {
        const oauthConfig = await getOAuthConfig(request);
        if (!oauthConfig.github.enabled || !oauthConfig.github.clientId) {
            return response.status(400).json({ error: 'GitHub OAuth未启用' });
        }

        const state = generateState();
        oauthStateCache.set(state, { provider: 'github', timestamp: Date.now() });

        // 清理过期的state（超过10分钟）
        for (const [key, value] of oauthStateCache.entries()) {
            if (Date.now() - value.timestamp > 10 * 60 * 1000) {
                oauthStateCache.delete(key);
            }
        }

        const params = new URLSearchParams({
            client_id: oauthConfig.github.clientId,
            redirect_uri: oauthConfig.github.callbackUrl,
            scope: 'read:user user:email',
            state: state,
        });

        const authUrl = `${oauthConfig.github.authUrl}?${params.toString()}`;
        return response.redirect(authUrl);
    } catch (error) {
        console.error('Error initiating GitHub OAuth:', error);
        return response.status(500).json({ error: 'GitHub OAuth初始化失败' });
    }
});

/**
 * Discord OAuth授权端点
 */
router.get('/discord', async (request, response) => {
    try {
        const oauthConfig = await getOAuthConfig(request);
        if (!oauthConfig.discord.enabled || !oauthConfig.discord.clientId) {
            return response.status(400).json({ error: 'Discord OAuth未启用' });
        }

        const state = generateState();
        oauthStateCache.set(state, { provider: 'discord', timestamp: Date.now() });

        // 清理过期的state
        for (const [key, value] of oauthStateCache.entries()) {
            if (Date.now() - value.timestamp > 10 * 60 * 1000) {
                oauthStateCache.delete(key);
            }
        }

        const params = new URLSearchParams({
            client_id: oauthConfig.discord.clientId,
            redirect_uri: oauthConfig.discord.callbackUrl,
            response_type: 'code',
            scope: 'identify email',
            state: state,
        });

        const authUrl = `${oauthConfig.discord.authUrl}?${params.toString()}`;
        return response.redirect(authUrl);
    } catch (error) {
        console.error('Error initiating Discord OAuth:', error);
        return response.status(500).json({ error: 'Discord OAuth初始化失败' });
    }
});

/**
 * Linux.do OAuth授权端点
 */
router.get('/linuxdo', async (request, response) => {
    try {
        const oauthConfig = await getOAuthConfig(request);
        if (!oauthConfig.linuxdo.enabled || !oauthConfig.linuxdo.clientId) {
            return response.status(400).json({ error: 'Linux.do OAuth未启用' });
        }

        const state = generateState();
        oauthStateCache.set(state, { provider: 'linuxdo', timestamp: Date.now() });

        // 清理过期的state
        for (const [key, value] of oauthStateCache.entries()) {
            if (Date.now() - value.timestamp > 10 * 60 * 1000) {
                oauthStateCache.delete(key);
            }
        }

        // Linux.do 支持标准 OAuth2 和 OIDC
        // 根据官方文档，基本参数为 response_type=code, client_id, state
        // redirect_uri 和 scope 是可选的
        const params = new URLSearchParams({
            client_id: oauthConfig.linuxdo.clientId,
            redirect_uri: oauthConfig.linuxdo.callbackUrl,
            response_type: 'code',
            state: state,
        });

        const authUrl = `${oauthConfig.linuxdo.authUrl}?${params.toString()}`;
        return response.redirect(authUrl);
    } catch (error) {
        console.error('Error initiating Linux.do OAuth:', error);
        return response.status(500).json({ error: 'Linux.do OAuth初始化失败' });
    }
});

/**
 * GitHub OAuth回调处理
 */
router.get('/github/callback', async (request, response) => {
    try {
        const { code, state } = request.query;
        const oauthConfig = await getOAuthConfig(request);

        // 验证state
        const cachedState = oauthStateCache.get(state);
        if (!cachedState || cachedState.provider !== 'github') {
            return response.status(400).send('Invalid state parameter');
        }
        oauthStateCache.delete(state);

        // 交换access token
        const tokenResponse = await fetch(oauthConfig.github.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                client_id: oauthConfig.github.clientId,
                client_secret: oauthConfig.github.clientSecret,
                code: code,
                redirect_uri: oauthConfig.github.callbackUrl,
            }),
        });

        /** @type {any} */
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) {
            console.error('GitHub OAuth token error:', tokenData);
            return response.status(400).send('Failed to get access token');
        }

        // 获取用户信息
        const userResponse = await fetch(oauthConfig.github.userInfoUrl, {
            headers: {
                'Authorization': `Bearer ${String(tokenData.access_token)}`,
                'Accept': 'application/json',
            },
        });

        const userData = await userResponse.json();
        console.log('GitHub user data:', userData);

        // 处理OAuth登录
        await handleOAuthLogin(request, response, 'github', userData);
    } catch (error) {
        console.error('Error in GitHub OAuth callback:', error);
        return response.status(500).send('GitHub OAuth callback failed');
    }
});

/**
 * Discord OAuth回调处理
 */
router.get('/discord/callback', async (request, response) => {
    try {
        const { code, state } = request.query;
        const oauthConfig = await getOAuthConfig(request);

        // 验证state
        const cachedState = oauthStateCache.get(state);
        if (!cachedState || cachedState.provider !== 'discord') {
            return response.status(400).send('Invalid state parameter');
        }
        oauthStateCache.delete(state);

        // 交换access token
        const codeStr = String(code || '');
        const params = new URLSearchParams({
            client_id: oauthConfig.discord.clientId,
            client_secret: oauthConfig.discord.clientSecret,
            grant_type: 'authorization_code',
            code: codeStr,
            redirect_uri: oauthConfig.discord.callbackUrl,
        });

        const tokenResponse = await fetch(oauthConfig.discord.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });

        /** @type {any} */
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) {
            console.error('Discord OAuth token error:', tokenData);
            return response.status(400).send('Failed to get access token');
        }

        // 获取用户信息
        const userResponse = await fetch(oauthConfig.discord.userInfoUrl, {
            headers: {
                'Authorization': `Bearer ${String(tokenData.access_token)}`,
            },
        });

        const userData = await userResponse.json();
        console.log('Discord user data:', userData);

        // 处理OAuth登录
        await handleOAuthLogin(request, response, 'discord', userData);
    } catch (error) {
        console.error('Error in Discord OAuth callback:', error);
        return response.status(500).send('Discord OAuth callback failed');
    }
});

/**
 * Linux.do OAuth回调处理
 */
router.get('/linuxdo/callback', async (request, response) => {
    try {
        const { code, state } = request.query;
        const oauthConfig = await getOAuthConfig(request);

        // 验证state
        const cachedState = oauthStateCache.get(state);
        if (!cachedState || cachedState.provider !== 'linuxdo') {
            return response.status(400).send('Invalid state parameter');
        }
        oauthStateCache.delete(state);

        // 交换access token
        const codeStr = String(code || '');
        const params = new URLSearchParams({
            client_id: oauthConfig.linuxdo.clientId,
            client_secret: oauthConfig.linuxdo.clientSecret,
            grant_type: 'authorization_code',
            code: codeStr,
            redirect_uri: oauthConfig.linuxdo.callbackUrl,
        });

        const tokenResponse = await fetch(oauthConfig.linuxdo.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });

        // 检查token响应状态
        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error('Linux.do OAuth token error response:', tokenResponse.status, errorText);
            return response.status(400).send(`Failed to get access token: ${tokenResponse.status}`);
        }

        /** @type {any} */
        const tokenData = await tokenResponse.json();

        let userData;

        // OpenID Connect返回id_token，优先使用它
        if (tokenData.id_token) {
            const decodedToken = decodeJWT(tokenData.id_token);
            if (decodedToken) {
                userData = decodedToken;
            }
        }

        // access_token 可能是 JWT，检查是否包含完整用户信息
        if (!userData && tokenData.access_token && tokenData.access_token.split('.').length === 3) {
            const decodedToken = decodeJWT(tokenData.access_token);
            if (decodedToken && decodedToken.sub) {
                // 只有当 JWT 包含实际用户信息时才使用
                if (decodedToken.username || decodedToken.email || decodedToken.name || decodedToken.preferred_username) {
                    userData = decodedToken;
                }
            }
        }

        // 如果没有获取到完整用户信息，调用 userinfo 端点
        if (!userData && tokenData.access_token) {
            const endpoints = [
                oauthConfig.linuxdo.userInfoUrl,
                'https://connect.linux.do/api/user'
            ];

            for (const endpoint of endpoints) {
                if (userData) break;

                try {
                    const userResponse = await fetch(endpoint, {
                        headers: {
                            'Authorization': `Bearer ${String(tokenData.access_token)}`,
                            'Accept': 'application/json',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        },
                    });

                    if (userResponse.ok) {
                        const contentType = userResponse.headers.get('content-type');
                        if (contentType && contentType.includes('application/json')) {
                            /** @type {any} */
                            const data = await userResponse.json();

                            if (data && (data.username || data.id)) {
                                userData = data;
                                break;
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error fetching user info from', endpoint, ':', error.message);
                }
            }
        }

        if (!userData) {
            console.error('Linux.do OAuth error: Failed to get user information');
            return response.status(400).send('Failed to get user information');
        }

        // 处理OAuth登录
        await handleOAuthLogin(request, response, 'linuxdo', userData);
    } catch (error) {
        console.error('Error in Linux.do OAuth callback:', error);
        return response.status(500).send('Linux.do OAuth callback failed');
    }
});

/**
 * 处理OAuth登录逻辑
 */
async function handleOAuthLogin(request, response, provider, userData) {
    try {
        // 提取用户信息
        let userId, username, email, avatar;

        switch (provider) {
            case 'github':
                userId = `github_${userData.id}`;
                username = userData.login || `github_user_${userData.id}`;
                email = userData.email;
                avatar = userData.avatar_url;
                break;
            case 'discord':
                userId = `discord_${userData.id}`;
                username = userData.username || `discord_user_${userData.id}`;
                email = userData.email;
                avatar = userData.avatar
                    ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                    : null;
                break;
            case 'linuxdo':
                // Linux.do 返回格式：{ id, username, name, email, avatar_url, ... }
                // 可能的嵌套结构：{user: {...}} 或 {current_user: {...}}
                const userInfo = userData.user || userData.current_user || userData;

                // 提取用户ID
                const rawUserId = userInfo.id || userData.id || userInfo.sub || userData.sub;
                userId = `linuxdo_${rawUserId}`;

                // 提取用户名
                username = userInfo.username || userData.username ||
                          userInfo.preferred_username || userData.preferred_username ||
                          userInfo.name || userData.name ||
                          `linuxdo_user_${rawUserId}`;

                // 提取邮箱
                email = userInfo.email || userData.email;

                // 提取头像
                avatar = userInfo.avatar_url || userData.avatar_url ||
                        userInfo.picture || userData.picture ||
                        userInfo.avatar_template || userData.avatar_template;

                // 如果是 avatar_template，需要处理
                if (avatar && avatar.includes('{size}')) {
                    avatar = processDiscourseAvatarTemplate(avatar);
                }
                break;
            default:
                throw new Error('Unknown OAuth provider');
        }

        // 规范化用户名
        const normalizedHandle = normalizeHandle(username);
        if (!normalizedHandle) {
            return response.redirect(`/login?error=${encodeURIComponent('用户名格式无效')}`);
        }

        // 检查用户是否已存在
        let user = await storage.getItem(toKey(normalizedHandle));

        if (!user) {
            // 如果开启了邀请码，需要先验证邀请码
            if (isInvitationCodesEnabled()) {
                // 将用户信息存储到session，等待输入邀请码
                if (request.session) {
                    request.session.oauthPendingUser = {
                        handle: normalizedHandle,
                        name: username,
                        email: email,
                        avatar: avatar,
                        provider: provider,
                        userId: userId,
                    };
                }
                // 重定向到邀请码输入页面
                return response.redirect('/login?oauth_pending=true');
            }

            // 创建新用户（第三方登录用户，标记 oauthProvider，不设置密码）
            user = {
                handle: normalizedHandle,
                name: username || normalizedHandle,
                email: email || '',
                created: Date.now(),
                admin: false,
                enabled: true,
                password: null,  // 第三方登录用户没有密码
                salt: null,
                oauthProvider: provider,  // 标记为第三方登录用户
                oauthUserId: userId,
                avatar: avatar || null,
            };

            await storage.setItem(toKey(normalizedHandle), user);
            console.log(`Created new user via ${provider} OAuth:`, normalizedHandle);

            // 保存头像 URL
            if (avatar) {
                await storage.setItem(toAvatarKey(normalizedHandle), avatar);
            }

            // 创建用户目录并初始化默认内容
            console.info('Creating data directories for', normalizedHandle);
            await ensurePublicDirectoriesExist();
            const directories = getUserDirectories(normalizedHandle);
            // 确保用户目录实际存在
            for (const dir of Object.values(directories)) {
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
            }
            // 检查并创建默认设置文件
            await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
            applyDefaultTemplateToUser(directories, { userName: user.name });
        } else {
            // 更新OAuth信息
            user.oauthProvider = provider;
            user.oauthUserId = userId;
            if (avatar) {
                user.avatar = avatar;
                // 更新头像 URL
                await storage.setItem(toAvatarKey(normalizedHandle), avatar);
            }
            await storage.setItem(toKey(normalizedHandle), user);
        }

        // 设置session
        if (request.session) {
            request.session.handle = user.handle;
            request.session.authenticated = true;
        }

        // 登录成功，重定向到主页
        return response.redirect('/');
    } catch (error) {
        console.error('Error handling OAuth login:', error);
        return response.redirect(`/login?error=${encodeURIComponent('OAuth登录失败')}`);
    }
}

/**
 * 验证邀请码并完成OAuth注册
 */
router.post('/verify-invitation', async (request, response) => {
    try {
        const { invitationCode } = request.body;

        if (!invitationCode) {
            return response.status(400).json({ error: '请输入邀请码' });
        }

        if (!request.session || !request.session.oauthPendingUser) {
            return response.status(400).json({ error: '没有待处理的OAuth用户' });
        }

        const pendingUser = request.session.oauthPendingUser;

        // 验证邀请码
        const validation = await validateInvitationCode(invitationCode);
        if (!validation.valid) {
            return response.status(400).json({ error: validation.reason || '邀请码无效' });
        }

        // 创建用户
        const user = {
            handle: pendingUser.handle,
            name: pendingUser.name || pendingUser.handle,
            email: pendingUser.email || '',
            created: Date.now(),
            admin: false,
            enabled: true,
            password: null,  // 第三方登录用户没有密码
            salt: null,
            oauthProvider: pendingUser.provider,  // 标记为第三方登录用户
            oauthUserId: pendingUser.userId,
            avatar: pendingUser.avatar || null,
        };

        if (USER_STORAGE_ENABLED) {
            const limitMiB = Number(USER_STORAGE_DEFAULT_LIMIT_MIB) || 0;
            user.storageLimitMiB = Math.max(0, limitMiB);
        }

        // 如果邀请码有用户过期时间，设置用户过期时间
        let userExpiresAt = null;
        if (validation.invitation && validation.invitation.durationDays) {
            // 计算用户到期时间
            const now = Date.now();
            const expiresAt = now + (validation.invitation.durationDays * 24 * 60 * 60 * 1000);
            userExpiresAt = expiresAt;
            user.expiresAt = expiresAt;
        }

        await storage.setItem(toKey(pendingUser.handle), user);
        console.log(`Created new user via ${pendingUser.provider} OAuth with invitation code:`, pendingUser.handle);

        // 保存头像 URL
        if (pendingUser.avatar) {
            await storage.setItem(toAvatarKey(pendingUser.handle), pendingUser.avatar);
        }

        // 使用邀请码
        await useInvitationCode(invitationCode, pendingUser.handle, userExpiresAt);

        // 创建用户目录并初始化默认内容
        console.info('Creating data directories for', pendingUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(pendingUser.handle);
        // 确保用户目录实际存在
        for (const dir of Object.values(directories)) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
        // 检查并创建默认设置文件
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        applyDefaultTemplateToUser(directories, { userName: user.name });

        // 清除pending user信息
        if (request.session) {
            delete request.session.oauthPendingUser;

            // 设置session
            request.session.handle = user.handle;
            request.session.authenticated = true;
        }

        return response.json({ success: true, handle: user.handle });
    } catch (error) {
        console.error('Error verifying invitation code for OAuth:', error);
        return response.status(500).json({ error: '邀请码验证失败' });
    }
});

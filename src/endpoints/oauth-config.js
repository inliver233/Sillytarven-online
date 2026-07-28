import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { requireAdminMiddleware } from '../users.js';
import { getConfigValue } from '../util.js';

export const router = express.Router();

/**
 * 获取OAuth配置
 */
router.get('/get', requireAdminMiddleware, async (request, response) => {
    try {
        const configPath = path.join(process.cwd(), 'config.yaml');

        if (!fs.existsSync(configPath)) {
            return response.status(404).json({ error: '配置文件不存在' });
        }

        const configContent = fs.readFileSync(configPath, 'utf8');
        /** @type {any} */
        const config = yaml.parse(configContent);

        // 动态构建回调URL（如果配置中没有指定）
        const protocol = request.protocol || (request.get('x-forwarded-proto') || 'http').split(',')[0].trim();
        const host = request.get('host') || request.get('x-forwarded-host') || 'localhost';
        const port = getConfigValue('port', 8000, 'number');
        const sslEnabled = getConfigValue('ssl.enabled', false, 'boolean');

        let hostname = host;
        if (!host.includes(':')) {
            if ((protocol === 'http' && port !== 80) || (protocol === 'https' && port !== 443)) {
                hostname = `${host}:${port}`;
            }
        }
        const finalProtocol = sslEnabled ? 'https' : protocol;

        const defaultGithubCallback = `${finalProtocol}://${hostname}/api/oauth/github/callback`;
        const defaultDiscordCallback = `${finalProtocol}://${hostname}/api/oauth/discord/callback`;
        const defaultLinuxdoCallback = `${finalProtocol}://${hostname}/api/oauth/linuxdo/callback`;

        const oauthConfig = {
            github: {
                enabled: config?.oauth?.github?.enabled || false,
                clientId: config?.oauth?.github?.clientId || '',
                clientSecret: config?.oauth?.github?.clientSecret || '',
                callbackUrl: config?.oauth?.github?.callbackUrl || '',
                defaultCallbackUrl: defaultGithubCallback,
            },
            discord: {
                enabled: config?.oauth?.discord?.enabled || false,
                clientId: config?.oauth?.discord?.clientId || '',
                clientSecret: config?.oauth?.discord?.clientSecret || '',
                callbackUrl: config?.oauth?.discord?.callbackUrl || '',
                defaultCallbackUrl: defaultDiscordCallback,
            },
            linuxdo: {
                enabled: config?.oauth?.linuxdo?.enabled || false,
                clientId: config?.oauth?.linuxdo?.clientId || '',
                clientSecret: config?.oauth?.linuxdo?.clientSecret || '',
                callbackUrl: config?.oauth?.linuxdo?.callbackUrl || '',
                defaultCallbackUrl: defaultLinuxdoCallback,
                wellKnownEndpoint: config?.oauth?.linuxdo?.wellKnownEndpoint || '',
                authUrl: config?.oauth?.linuxdo?.authUrl || 'https://connect.linux.do/oauth2/authorize',
                tokenUrl: config?.oauth?.linuxdo?.tokenUrl || 'https://connect.linux.do/oauth2/token',
                userInfoUrl: config?.oauth?.linuxdo?.userInfoUrl || 'https://connect.linux.do/api/user',
            },
        };

        return response.json(oauthConfig);
    } catch (error) {
        console.error('Error loading OAuth config:', error);
        return response.status(500).json({ error: '加载配置失败' });
    }
});

/**
 * 保存OAuth配置
 */
router.post('/save', requireAdminMiddleware, async (request, response) => {
    try {
        const { github, discord, linuxdo } = request.body;

        if (!github || !discord || !linuxdo) {
            return response.status(400).json({ error: '缺少必要的配置信息' });
        }

        const configPath = path.join(process.cwd(), 'config.yaml');

        if (!fs.existsSync(configPath)) {
            return response.status(404).json({ error: '配置文件不存在' });
        }

        const configContent = fs.readFileSync(configPath, 'utf8');
        /** @type {any} */
        const config = yaml.parse(configContent);

        // 更新OAuth配置
        if (!config.oauth) {
            config.oauth = {};
        }

        // 如果callbackUrl为空，则不保存（使用动态URL）
        config.oauth.github = {
            enabled: Boolean(github.enabled),
            clientId: String(github.clientId || ''),
            clientSecret: String(github.clientSecret || ''),
        };
        // 只有当用户明确设置了callbackUrl时才保存
        if (github.callbackUrl && github.callbackUrl.trim()) {
            config.oauth.github.callbackUrl = String(github.callbackUrl.trim());
        }

        config.oauth.discord = {
            enabled: Boolean(discord.enabled),
            clientId: String(discord.clientId || ''),
            clientSecret: String(discord.clientSecret || ''),
        };
        if (discord.callbackUrl && discord.callbackUrl.trim()) {
            config.oauth.discord.callbackUrl = String(discord.callbackUrl.trim());
        }

        config.oauth.linuxdo = {
            enabled: Boolean(linuxdo.enabled),
            clientId: String(linuxdo.clientId || ''),
            clientSecret: String(linuxdo.clientSecret || ''),
            wellKnownEndpoint: String(linuxdo.wellKnownEndpoint || ''),
            authUrl: String(linuxdo.authUrl || 'https://connect.linux.do/oauth2/authorize'),
            tokenUrl: String(linuxdo.tokenUrl || 'https://connect.linux.do/oauth2/token'),
            userInfoUrl: String(linuxdo.userInfoUrl || 'https://connect.linux.do/api/user'),
        };
        if (linuxdo.callbackUrl && linuxdo.callbackUrl.trim()) {
            config.oauth.linuxdo.callbackUrl = String(linuxdo.callbackUrl.trim());
        }

        // 将配置写回文件
        const newConfigContent = yaml.stringify(config, {
            indent: 2,
            lineWidth: -1,
        });

        fs.writeFileSync(configPath, newConfigContent, 'utf8');

        console.log('OAuth configuration saved successfully');
        return response.json({
            success: true,
            message: 'OAuth配置已保存，请重启服务以使配置生效'
        });
    } catch (error) {
        console.error('Error saving OAuth config:', error);
        return response.status(500).json({ error: '保存配置失败：' + error.message });
    }
});


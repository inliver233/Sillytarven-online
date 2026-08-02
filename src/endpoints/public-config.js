import express from 'express';
import { getConfigValue } from '../util.js';
import { getPublicMigrationFeatureFlags } from '../feature-flags.js';

export const router = express.Router();

/**
 * 获取公共页面配置信息
 * 返回哪些页面被启用
 */
router.get('/public-pages', (request, response) => {
    try {
        const enablePublicCharacters = getConfigValue('enablePublicCharacters', true, 'boolean');
        const enableForum = getConfigValue('enableForum', true, 'boolean');

        response.json({
            enablePublicCharacters,
            enableForum,
        });
    } catch (error) {
        console.error('Error getting public pages config:', error);
        response.status(500).json({ error: 'Failed to get public pages config' });
    }
});

router.get('/feature-flags', (_request, response) => {
    response.json(getPublicMigrationFeatureFlags());
});

router.get('/reasoning-tools', (_request, response) => {
    const configuredLimit = getConfigValue('toolCalling.recurseHardLimit', 50, 'number');
    const recurseHardLimit = Number.isInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 50
        ? configuredLimit
        : 50;

    response.json({
        enabled: getPublicMigrationFeatureFlags().reasoningTools,
        recurseHardLimit,
    });
});

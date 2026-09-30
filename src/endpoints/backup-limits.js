import express from 'express';

import { requireAdminMiddleware } from '../users.js';
import { getBackupLimitPolicy, getBackupQuotaStatus, getBackupUsageSummary, saveBackupLimitPolicy } from '../backup-limits.js';

export const router = express.Router();

// The signed-in user's remaining exports for today.
router.get('/status', (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return response.json(getBackupQuotaStatus(request.user.profile));
});

router.get('/config', requireAdminMiddleware, (_request, response) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return response.json({ policy: getBackupLimitPolicy(), usage: getBackupUsageSummary() });
});

router.post('/config', requireAdminMiddleware, async (request, response) => {
    try {
        const policy = await saveBackupLimitPolicy(request.body?.policy);
        console.info(`Backup limits updated by ${request.user.profile.handle}:`, JSON.stringify(policy));
        return response.json({ policy, usage: getBackupUsageSummary() });
    } catch (error) {
        console.error('Failed to save backup limits:', error);
        return response.status(500).json({ error: '保存失败，请稍后重试' });
    }
});

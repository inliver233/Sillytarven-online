import express from 'express';

import { requireAdminMiddleware } from '../users.js';
import { getBackupLimitPolicy, getBackupQuotaStatus, getBackupUsageSummary, saveBackupLimitPolicy } from '../backup-limits.js';
import { getBackupActivitySummary } from '../backup-activity.js';

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

// One day of backups, exports and restores: outcome, size and who ran them.
router.get('/activity', requireAdminMiddleware, (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return response.json(getBackupActivitySummary(String(request.query.date ?? '')));
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

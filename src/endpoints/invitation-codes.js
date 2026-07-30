import express from 'express';
import {
    createInvitationCode,
    getInvitationCodesBySource,
    deleteInvitationCode,
    isInvitationCodesEnabled,
    cleanupExpiredInvitationCodes,
    setPurchaseLink,
    getPurchaseLink,
} from '../invitation-codes.js';
import { ADMIN_INVITATION_SOURCE } from '../user-invitation-policy.js';
import { requireAdminMiddleware } from '../users.js';

export const router = express.Router();

// 获取所有邀请码（管理员功能）
router.get('/', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.json({ enabled: false, codes: [] });
        }

        const codes = await getInvitationCodesBySource(ADMIN_INVITATION_SOURCE);
        response.json({ enabled: true, codes });
    } catch (error) {
        console.error('Error getting invitation codes:', error);
        response.status(500).json({ error: '获取邀请码失败' });
    }
});

// 创建邀请码（管理员功能）
router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.status(400).json({ error: 'Invitation codes are disabled' });
        }

        const { durationType } = request.body;
        // @ts-ignore - user.handle exists in actual runtime
        const createdBy = request.user?.profile?.handle || request.user?.handle || 'admin';

        const invitation = await createInvitationCode(createdBy, durationType);
        response.json(invitation);
    } catch (error) {
        console.error('Error creating invitation code:', error);
        response.status(500).json({ error: error.message || '创建邀请码失败' });
    }
});

// 批量创建邀请码（管理员功能）
router.post('/batch-create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.status(400).json({ error: 'Invitation codes are disabled' });
        }

        const { count, durationType } = request.body;
        // @ts-ignore - user.handle exists in actual runtime
        const createdBy = request.user?.profile?.handle || request.user?.handle || 'admin';

        if (!count || count < 1 || count > 100) {
            return response.status(400).json({ error: 'Count must be between 1 and 100' });
        }

        const invitations = [];
        for (let i = 0; i < count; i++) {
            const invitation = await createInvitationCode(createdBy, durationType);
            invitations.push(invitation);
        }

        response.json({
            success: true,
            count: invitations.length,
            codes: invitations,
        });
    } catch (error) {
        console.error('Error batch creating invitation codes:', error);
        response.status(500).json({ error: error.message || '批量创建邀请码失败' });
    }
});

// 删除邀请码（管理员功能）
router.delete('/:code', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.status(400).json({ error: '邀请码功能未启用' });
        }

        const { code } = request.params;
        const success = await deleteInvitationCode(code, { issuanceSource: ADMIN_INVITATION_SOURCE });

        if (success) {
            response.json({ success: true });
        } else {
            response.status(404).json({ error: '邀请码不存在' });
        }
    } catch (error) {
        console.error('Error deleting invitation code:', error);
        response.status(500).json({ error: '删除邀请码失败' });
    }
});

// 批量删除邀请码（管理员功能）
router.post('/batch-delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.status(400).json({ error: '邀请码功能未启用' });
        }

        const { codes } = request.body;

        if (!codes || !Array.isArray(codes) || codes.length === 0) {
            return response.status(400).json({ error: '未提供要删除的邀请码' });
        }
        if (codes.length > 10000) {
            return response.status(400).json({ error: '单次最多删除10000个邀请码' });
        }

        const uniqueCodes = [...new Set(codes.map(code => String(code).toUpperCase()))];
        if (uniqueCodes.some(code => !/^[A-F0-9]{16}$/.test(code))) {
            return response.status(400).json({ error: '包含格式无效的邀请码' });
        }

        let deletedCount = 0;
        let notFoundCount = 0;

        for (const code of uniqueCodes) {
            try {
                const success = await deleteInvitationCode(code, { issuanceSource: ADMIN_INVITATION_SOURCE });
                if (success) {
                    deletedCount++;
                } else {
                    notFoundCount++;
                }
            } catch (error) {
                console.error('Failed to delete an invitation code during batch deletion:', error.message);
                notFoundCount++;
            }
        }

        response.json({
            success: true,
            deletedCount,
            totalRequested: uniqueCodes.length,
            notFoundCount,
        });
    } catch (error) {
        console.error('Error batch deleting invitation codes:', error);
        response.status(500).json({ error: '批量删除邀请码失败' });
    }
});

// 清理过期邀请码（管理员功能）
router.post('/cleanup', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.status(400).json({ error: '邀请码功能未启用' });
        }

        const cleanedCount = await cleanupExpiredInvitationCodes();
        response.json({ cleanedCount });
    } catch (error) {
        console.error('Error cleaning up invitation codes:', error);
        response.status(500).json({ error: '清理邀请码失败' });
    }
});

// 检查邀请码功能状态
router.get('/status', async (request, response) => {
    try {
        const enabled = isInvitationCodesEnabled();
        response.json({ enabled });
    } catch (error) {
        console.error('Error checking invitation codes status:', error);
        response.status(500).json({ error: '检查状态失败' });
    }
});

// 设置购买链接（管理员功能）
router.post('/purchase-link', requireAdminMiddleware, async (request, response) => {
    try {
        if (!isInvitationCodesEnabled()) {
            return response.status(400).json({ error: '邀请码功能未启用' });
        }

        const { purchaseLink } = request.body;
        await setPurchaseLink(purchaseLink);
        response.json({ success: true, purchaseLink });
    } catch (error) {
        console.error('Error setting purchase link:', error);
        response.status(500).json({ error: '设置购买链接失败' });
    }
});

// 获取购买链接（公开接口）
router.get('/purchase-link', async (request, response) => {
    try {
        const purchaseLink = await getPurchaseLink();
        response.json({ purchaseLink });
    } catch (error) {
        console.error('Error getting purchase link:', error);
        response.status(500).json({ error: '获取购买链接失败' });
    }
});

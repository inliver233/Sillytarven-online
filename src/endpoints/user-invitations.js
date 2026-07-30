/**
 * 用户层邀请码发放系统 — 路由
 *
 * 用户级（requireLoginMiddleware）：
 *   GET  /api/user-invitations/my      资格状态(仅布尔) + 我的邀请码列表
 *   POST /api/user-invitations/create  生成一个永久邀请码（服务端全套校验）
 *
 * 管理员级（requireAdminMiddleware）：
 *   GET  /api/user-invitations/config       读规则配置
 *   POST /api/user-invitations/config       写规则配置
 *   GET  /api/user-invitations/issuer-stats 发放者统计（谁邀请了谁）
 *   DELETE /api/user-invitations/:code      撤销用户系统邀请码
 */
import express from 'express';
import { requireLoginMiddleware, requireAdminMiddleware } from '../users.js';
import {
    getMyInvitationData,
    issueUserInvitation,
    getUserInvitationConfig,
    setUserInvitationConfig,
    getUserInvitationAdminData,
    deleteUserInvitation,
} from '../user-invitations.js';

export const router = express.Router();

/** 从请求中取当前用户 handle */
function getHandle(request) {
    return request.user?.profile?.handle || null;
}

// ===== 用户级 =====

// 资格状态 + 我的邀请码列表（一次拿全，减少请求）
router.get('/my', requireLoginMiddleware, async (request, response) => {
    try {
        const handle = getHandle(request);
        if (!handle) {
            return response.status(401).json({ error: '未登录' });
        }
        const data = await getMyInvitationData(handle);
        response.json(data);
    } catch (error) {
        console.error('GET /api/user-invitations/my failed:', error);
        response.status(500).json({ error: '获取邀请码信息失败' });
    }
});

// 生成一个永久邀请码
router.post('/create', requireLoginMiddleware, async (request, response) => {
    try {
        const handle = getHandle(request);
        if (!handle) {
            return response.status(401).json({ error: '未登录' });
        }
        const result = await issueUserInvitation(handle);
        if (result.success) {
            response.json({ success: true, invitation: result.invitation });
        } else {
            // 422 = 语义错误（资格/配额不满足），区别于 500
            response.status(422).json({ success: false, reason: result.reason });
        }
    } catch (error) {
        console.error('POST /api/user-invitations/create failed:', error);
        response.status(500).json({ error: '生成邀请码失败' });
    }
});

// ===== 管理员级 =====

// 读规则配置
router.get('/config', requireAdminMiddleware, async (request, response) => {
    try {
        const config = await getUserInvitationConfig();
        response.json(config);
    } catch (error) {
        console.error('GET /api/user-invitations/config failed:', error);
        response.status(500).json({ error: '读取配置失败' });
    }
});

// 写规则配置（合并）
router.post('/config', requireAdminMiddleware, async (request, response) => {
    try {
        const config = await setUserInvitationConfig(request.body || {});
        response.json(config);
    } catch (error) {
        console.error('POST /api/user-invitations/config failed:', error);
        response.status(500).json({ error: '保存配置失败' });
    }
});

// 发放者统计（谁发了多少 / 邀请了谁）
router.get('/issuer-stats', requireAdminMiddleware, async (request, response) => {
    try {
        const limit = Math.min(1000, Math.max(1, Number(request.query.limit) || 100));
        const data = await getUserInvitationAdminData({ limit });
        response.json(data);
    } catch (error) {
        console.error('GET /api/user-invitations/issuer-stats failed:', error);
        response.status(500).json({ error: '获取统计失败' });
    }
});

// 撤销用户发放的邀请码（不会误删旧管理员系统的邀请码）
router.delete('/:code', requireAdminMiddleware, async (request, response) => {
    try {
        const code = String(request.params.code || '').toUpperCase();
        if (!/^[A-F0-9]{16}$/.test(code)) {
            return response.status(400).json({ error: '邀请码格式无效' });
        }
        const result = await deleteUserInvitation(code);
        if (!result.deleted) {
            const status = result.reason?.includes('已使用') ? 409 : 404;
            return response.status(status).json({ error: result.reason || '用户邀请码不存在' });
        }
        response.json({ success: true });
    } catch (error) {
        console.error('DELETE /api/user-invitations/:code failed:', error);
        response.status(500).json({ error: '撤销邀请码失败' });
    }
});

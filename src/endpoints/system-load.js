import express from 'express';
import systemMonitor from '../system-monitor.js';
import { requireAdminMiddleware } from '../users.js';
import {
    clearSystemStatsPreservingInvitationDurations,
    resetUserStatsPreservingInvitationDuration,
} from '../user-invitations.js';

export const router = express.Router();

// 获取系统负载信息（管理员功能）
router.get('/', requireAdminMiddleware, async (request, response) => {
    try {
        const summaryOnly = ['1', 'true'].includes(String(request.query.summary || '').toLowerCase());
        const systemLoad = systemMonitor.getLatestSystemLoad();
        const userStats = systemMonitor.getAllUserLoadStats({ includeDetails: !summaryOnly });
        const loadHistory = summaryOnly ? [] : systemMonitor.getSystemLoadHistory(50);

        response.json({
            system: systemLoad,
            users: userStats,
            history: loadHistory,
        });
    } catch (error) {
        console.error('Error getting system load:', error);
        response.status(500).json({ error: 'Failed to get system load' });
    }
});

// Live overview: the latest 5-second sample, without the user list.
router.get('/live', requireAdminMiddleware, (_request, response) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return response.json({ system: systemMonitor.getLatestSystemLoad(), serverTime: Date.now() });
});

// One page of user statistics with optional search.
router.get('/users-page', requireAdminMiddleware, (request, response) => {
    try {
        response.setHeader('Cache-Control', 'private, no-store, max-age=0');
        return response.json(systemMonitor.getUserLoadStatsPage({
            page: request.query.page,
            pageSize: request.query.pageSize,
            search: request.query.search,
        }));
    } catch (error) {
        console.error('Error getting user stats page:', error);
        return response.status(500).json({ error: 'Failed to get user stats' });
    }
});

// 获取用户统计信息（管理员功能）
router.get('/users', requireAdminMiddleware, async (request, response) => {
    try {
        const userStats = systemMonitor.getAllUserLoadStats();
        response.json(userStats);
    } catch (error) {
        console.error('Error getting user stats:', error);
        response.status(500).json({ error: 'Failed to get user stats' });
    }
});

// 获取特定用户的统计信息（管理员功能）
router.get('/users/:userHandle', requireAdminMiddleware, async (request, response) => {
    try {
        const { userHandle } = request.params;
        const userStats = systemMonitor.getUserLoadStats(userHandle);

        if (!userStats) {
            return response.status(404).json({ error: 'User stats not found' });
        }

        response.json(userStats);
    } catch (error) {
        console.error('Error getting user stats:', error);
        response.status(500).json({ error: 'Failed to get user stats' });
    }
});

// 重置用户统计信息（管理员功能）
router.post('/users/:userHandle/reset', requireAdminMiddleware, async (request, response) => {
    try {
        const { userHandle } = request.params;
        await resetUserStatsPreservingInvitationDuration(userHandle);
        response.json({ success: true });
    } catch (error) {
        console.error('Error resetting user stats:', error);
        response.status(500).json({ error: 'Failed to reset user stats' });
    }
});

// 清除所有统计数据（管理员功能）
router.post('/clear', requireAdminMiddleware, async (request, response) => {
    try {
        await clearSystemStatsPreservingInvitationDurations();
        response.json({ success: true });
    } catch (error) {
        console.error('Error clearing stats:', error);
        response.status(500).json({ error: 'Failed to clear stats' });
    }
});

// 获取系统负载历史（管理员功能）
router.get('/history', requireAdminMiddleware, async (request, response) => {
    try {
        const limitParam = request.query.limit;
        const limit = limitParam ? parseInt(String(limitParam)) : 100;
        const history = systemMonitor.getSystemLoadHistory(limit);
        response.json(history);
    } catch (error) {
        console.error('Error getting load history:', error);
        response.status(500).json({ error: 'Failed to get load history' });
    }
});

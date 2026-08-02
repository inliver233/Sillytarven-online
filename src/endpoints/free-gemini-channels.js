import express from 'express';

import {
    createFreeGeminiChannel,
    deleteFreeGeminiChannel,
    listAdminFreeGeminiChannels,
    listPublicFreeGeminiChannels,
    updateFreeGeminiChannel,
} from '../free-gemini-channels.js';
import { requireAdminMiddleware, requireLoginMiddleware } from '../users.js';

export const router = express.Router();

function sendError(response, error, fallbackMessage) {
    if (error?.code === 'FREE_GEMINI_VALIDATION') {
        return response.status(400).json({ error: error.message });
    }

    console.error(fallbackMessage, error);
    return response.status(500).json({ error: fallbackMessage });
}

router.get('/', requireLoginMiddleware, async (_request, response) => {
    try {
        const channels = await listPublicFreeGeminiChannels();
        return response.json({ channels });
    } catch (error) {
        return sendError(response, error, '获取免费 Gemini 渠道失败');
    }
});

router.get('/admin', requireAdminMiddleware, async (_request, response) => {
    try {
        const channels = await listAdminFreeGeminiChannels();
        return response.json({ channels });
    } catch (error) {
        return sendError(response, error, '获取免费 Gemini 渠道配置失败');
    }
});

router.post('/admin', requireAdminMiddleware, async (request, response) => {
    try {
        const channel = await createFreeGeminiChannel(request.body);
        return response.status(201).json({ success: true, channel });
    } catch (error) {
        return sendError(response, error, '新增免费 Gemini 渠道失败');
    }
});

router.put('/admin/:id', requireAdminMiddleware, async (request, response) => {
    try {
        const channel = await updateFreeGeminiChannel(request.params.id, request.body);
        if (!channel) {
            return response.status(404).json({ error: '免费 Gemini 渠道不存在' });
        }
        return response.json({ success: true, channel });
    } catch (error) {
        return sendError(response, error, '更新免费 Gemini 渠道失败');
    }
});

router.delete('/admin/:id', requireAdminMiddleware, async (request, response) => {
    try {
        const deleted = await deleteFreeGeminiChannel(request.params.id);
        if (!deleted) {
            return response.status(404).json({ error: '免费 Gemini 渠道不存在' });
        }
        return response.json({ success: true });
    } catch (error) {
        return sendError(response, error, '删除免费 Gemini 渠道失败');
    }
});

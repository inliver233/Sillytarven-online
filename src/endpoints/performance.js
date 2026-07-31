import express from 'express';

import { performanceMonitor } from '../performance-monitor.js';
import { requireAdminMiddleware } from '../users.js';
import { clearCharacterListCache, getCharacterListCacheStatus } from '../character-list-cache.js';
import { clearSettingsCache, getSettingsCacheStatus } from '../settings-cache.js';
import { clearRecentChatsCache, getRecentChatsCacheStatus } from '../recent-chats-cache.js';

export const router = express.Router();
const parseClientTelemetryJson = express.json({ limit: '64kb', strict: true });

function clientTelemetryBodyParser(request, response, next) {
    parseClientTelemetryJson(request, response, (error) => {
        if (!error) {
            next();
            return;
        }
        if (error.type === 'entity.too.large') {
            response.status(413).json({
                error: 'telemetry_body_too_large',
                message: 'The telemetry request exceeds the 64 KiB limit.',
            });
            return;
        }
        response.status(400).json({
            error: 'invalid_telemetry_body',
            message: 'The telemetry request body must be valid JSON.',
        });
    });
}

router.use((_, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    next();
});

router.post('/client', clientTelemetryBodyParser, (request, response) => {
    const result = performanceMonitor.recordClientBatch(
        request.user.profile.handle,
        request.body?.samples,
    );
    return response.status(202).send(result);
});

router.get('/summary', requireAdminMiddleware, (_, response) => {
    return response.send({
        ...performanceMonitor.getSummary(),
        caches: {
            characterLists: getCharacterListCacheStatus(),
            settings: getSettingsCacheStatus(),
            recentChats: getRecentChatsCacheStatus(),
        },
    });
});

router.post('/clear', requireAdminMiddleware, (_, response) => {
    performanceMonitor.clear();
    return response.send({ ok: true });
});

router.post('/cache/characters/clear', requireAdminMiddleware, (_, response) => {
    clearCharacterListCache();
    return response.send({ ok: true });
});

router.post('/cache/settings/clear', requireAdminMiddleware, (_, response) => {
    clearSettingsCache();
    return response.send({ ok: true });
});

router.post('/cache/recent-chats/clear', requireAdminMiddleware, (_, response) => {
    clearRecentChatsCache();
    return response.send({ ok: true });
});

import express from 'express';

import { performanceMonitor } from '../performance-monitor.js';
import { requireAdminMiddleware } from '../users.js';
import { clearCharacterListCache, getCharacterListCacheStatus } from '../character-list-cache.js';

export const router = express.Router();

router.use((_, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    next();
});

router.post('/client', (request, response) => {
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

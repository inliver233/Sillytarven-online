import express from 'express';

import { requireAdminMiddleware } from '../users.js';
import { METRICS, SITE_FILTERS, WINDOWS } from '../leaderboard.js';
import { leaderboard } from '../leaderboard-service.js';

export const router = express.Router();

router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!leaderboard.running) return response.status(404).send({ error: 'disabled' });
    return next();
});

/** The page says somebody is using it (online time); t is the page's clock. */
router.get('/ping', (request, response) => {
    leaderboard.onPing(request.user.profile, Number(request.query.t));
    return response.sendStatus(204);
});

router.get('/board', (request, response) => {
    const metric = String(request.query.metric ?? 'chat');
    const window = String(request.query.window ?? 'today');
    const site = String(request.query.site ?? 'all');
    if (!METRICS.includes(metric) || !WINDOWS.includes(window) || !SITE_FILTERS.includes(site)) {
        return response.status(400).send({ error: 'bad_query' });
    }
    const handle = leaderboard.account(request.user.profile);
    const board = leaderboard.store.board({ metric, window, site, handle });
    if (request.query.v && String(request.query.v) === board.version) {
        return response.send({ unchanged: true, version: board.version });
    }
    const backfill = leaderboard.store.backfillFinished ? null : { done: leaderboard.backfill.done, total: leaderboard.backfill.total };
    return response.send({ ...board, peers: leaderboard.peerStatus(), backfill, countingSince: leaderboard.store.countingSince });
});

router.get('/me', (request, response) => {
    const handle = leaderboard.account(request.user.profile);
    return response.send(leaderboard.store.prefsOf(handle));
});

router.post('/me', (request, response) => {
    const handle = leaderboard.account(request.user.profile);
    if (request.user.profile.admin) return response.status(400).send({ error: 'admin' });
    const result = leaderboard.store.setPrefs(handle, { mode: request.body?.mode, nickname: request.body?.nickname });
    if (result.error) return response.status(400).send({ error: result.error });
    leaderboard.dirty = true;
    leaderboard.save();
    return response.send(leaderboard.store.prefsOf(handle));
});

/** An administrator takes someone off the board, or back (both sites). */
router.post('/admin/ban', requireAdminMiddleware, (request, response) => {
    const id = String(request.body?.id ?? '');
    if (!leaderboard.store.setBan(id, request.body?.banned !== false)) return response.status(404).send({ error: 'unknown_person' });
    leaderboard.dirty = true;
    leaderboard.save();
    return response.sendStatus(204);
});

router.get('/status', requireAdminMiddleware, (_request, response) => {
    return response.send(leaderboard.status());
});

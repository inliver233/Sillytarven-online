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

/**
 * The page says somebody is using it (online time); t is the page's clock. The answer says whether
 * they still have to choose real name or anonymous (new, or asked again by an administrator).
 */
router.get('/ping', (request, response) => {
    leaderboard.onPing(request.user.profile, Number(request.query.t));
    const prefs = leaderboard.store.prefsOf(request.user.profile.handle);
    return response.send({ choose: !!prefs && !prefs.explicit });
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
    // Administrators are not ranked, but their answer to the launch notice is kept like anybody's.
    const handle = leaderboard.account(request.user.profile);
    const result = leaderboard.store.setPrefs(handle, { mode: request.body?.mode });
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

/**
 * An administrator asks someone (by row, or by account name on this site) to choose again. Their
 * open pages are told at once; on the other site, once it has synced.
 */
router.post('/admin/reset-choice', requireAdminMiddleware, (request, response) => {
    const handle = typeof request.body?.handle === 'string' ? request.body.handle.trim() : '';
    const key = handle ? leaderboard.store.personKeyOf(handle) : String(request.body?.id ?? '');
    if (!key || !leaderboard.store.resetChoice(key)) {
        return response.status(404).send({ error: handle ? 'no_such_account' : 'not_on_this_site' });
    }
    leaderboard.dirty = true;
    leaderboard.save();
    return response.send({ pages: leaderboard.askToChoose(key) });
});

/** The emoji next to the user's own name: {scope: 'all' or a metric, emoji: '' to remove}. */
router.post('/me/emoji', (request, response) => {
    const handle = leaderboard.account(request.user.profile);
    const result = leaderboard.store.setEmoji(handle, request.body?.scope, request.body?.emoji);
    if (result.error) return response.status(400).send({ error: result.error });
    leaderboard.dirty = true;
    leaderboard.save();
    return response.send(leaderboard.store.prefsOf(handle));
});

/** An administrator removes someone's emoji (all boards). */
router.post('/admin/clear-emoji', requireAdminMiddleware, (request, response) => {
    if (!leaderboard.store.clearEmoji(String(request.body?.id ?? ''))) return response.status(404).send({ error: 'not_on_this_site' });
    leaderboard.dirty = true;
    leaderboard.save();
    return response.sendStatus(204);
});

router.get('/status', requireAdminMiddleware, (_request, response) => {
    return response.send(leaderboard.status());
});

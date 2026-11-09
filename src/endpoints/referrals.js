/**
 * 邀请奖励接口（src/referrals.js）：
 *   GET  /status             开没开、邀请一个人给多少（入口要不要显示、上面写多少）
 *   GET  /my                 自己的邀请码、规则、邀请到的人、被谁邀请
 *   POST /code               生成邀请码（够格才行）；{ reset: true } 换一个
 *   POST /claim              绑定邀请人 { code, source }
 *   GET  /admin/config       管理员：设置（含共用的邀请资格门槛）
 *   POST /admin/config
 *   GET  /admin/list         管理员：邀请关系 ?query=&status=&inviter=&offset=&limit=，含汇总和邀请人排行
 *   POST /admin/revoke       管理员：撤销 { invitee, reclaim }
 *   POST /admin/approve      管理员：判定成功 { invitee }
 *   GET  /admin/access       管理员：单独设置过邀请资格的人
 *   POST /admin/access       管理员：单独设置一个人 { handle, mode: allow|block|default, revokeAll, reclaim }
 *
 * 跨站邀请的站间接口（peerRouter，挂在 /api/referrals/peer，不用登录，要两站共用的 secret 签名）：
 *   POST /info               本站开没开、开没开跨站邀请、开着注册没有、奖励多少
 *   POST /lookup             对方站来问一个邀请码 { code, identity }
 *   POST /sync               对方站告诉本站：本站用户邀请的人在那边的状态（发 / 收回邀请人的奖励）
 *   POST /revoked            对方站撤销了它的用户在本站邀请的人
 */
import express from 'express';

import { verifyPeer } from '../referral-peer.js';
import { traceContext } from '../referral-trace.js';
import {
    answerPeerInfo,
    answerPeerLookup,
    applyPeerRevoke,
    applyPeerSync,
    approveReferral,
    claimReferral,
    ensureCode,
    getCrossSiteStatus,
    listAccess,
    noteParticipant,
    getMyReferralData,
    getReferralConfig,
    listReferrals,
    resetCode,
    revokeReferral,
    rewardsAvailable,
    setInviterAccess,
    setReferralConfig,
} from '../referrals.js';
import { hadValidReply } from '../usage-meter.js';
import { getUserInvitationConfig, setUserInvitationConfig } from '../user-invitations.js';
import { requireAdminMiddleware, requireLoginMiddleware } from '../users.js';

export const router = express.Router();

router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
});

router.get('/status', requireLoginMiddleware, async (request, response) => {
    // 溯源：参与邀请的人每次打开页面记一下 IP 和设备（同一组 6 小时一次）
    void noteParticipant(request.user.profile.handle, traceContext(request));
    const config = await getReferralConfig();
    return response.send({ enabled: config.enabled, rewardMiB: rewardsAvailable() ? config.inviterRewardMiB : 0 });
});

router.get('/my', requireLoginMiddleware, async (request, response) => {
    try {
        void noteParticipant(request.user.profile.handle, traceContext(request), { force: true });
        return response.send(await getMyReferralData(request.user.profile.handle));
    } catch (error) {
        console.error('[referrals] /my failed:', error);
        return response.status(500).send({ error: '读取邀请信息失败' });
    }
});

router.post('/code', requireLoginMiddleware, async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const data = await getMyReferralData(handle);
        if (!data.enabled) return response.status(400).send({ error: '邀请奖励暂未开放' });
        if (data.blocked) return response.status(403).send({ error: '你的邀请已被管理员停用' });
        if (!data.eligible) return response.status(403).send({ error: '暂未达到邀请资格' });
        const code = request.body?.reset ? await resetCode(handle) : await ensureCode(handle);
        void noteParticipant(handle, traceContext(request), { force: true });
        return response.send({ code });
    } catch (error) {
        console.error('[referrals] /code failed:', error);
        return response.status(500).send({ error: '生成邀请码失败' });
    }
});

router.post('/claim', requireLoginMiddleware, async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const source = request.body?.source === 'link' ? 'link' : 'code';
        const result = await claimReferral(handle, request.body?.code, { source, hadValidReply: hadValidReply(handle), context: traceContext(request) });
        if (!result.ok) return response.status(400).send({ error: result.reason });
        return response.send({ status: result.link.status, rewardMiB: result.link.inviteeRewardMiB || 0 });
    } catch (error) {
        console.error('[referrals] /claim failed:', error);
        return response.status(500).send({ error: '绑定失败，请稍后再试' });
    }
});

/** 设置 + 共用的邀请资格门槛 + 奖励能不能生效 + 跨站邀请的情况 */
async function adminConfig(config) {
    const eligibility = await getUserInvitationConfig();
    return {
        ...config, minRegisteredDays: eligibility.minRegisteredDays, minOnlineHours: eligibility.minOnlineHours, rewardsAvailable: rewardsAvailable(),
        crossSiteStatus: await getCrossSiteStatus(),
    };
}

router.get('/admin/config', requireAdminMiddleware, async (_request, response) => {
    return response.send(await adminConfig(await getReferralConfig()));
});

router.post('/admin/config', requireAdminMiddleware, async (request, response) => {
    try {
        const body = request.body ?? {};
        const config = await setReferralConfig(body);
        // 邀请资格的门槛和用户邀请码共用一份
        const thresholds = {};
        if (Object.hasOwn(body, 'minRegisteredDays')) thresholds.minRegisteredDays = body.minRegisteredDays;
        if (Object.hasOwn(body, 'minOnlineHours')) thresholds.minOnlineHours = body.minOnlineHours;
        if (Object.keys(thresholds).length) await setUserInvitationConfig(thresholds);
        console.info(`[referrals] ${request.user.profile.handle} updated the settings`);
        return response.send(await adminConfig(config));
    } catch (error) {
        console.error('[referrals] /admin/config failed:', error);
        return response.status(500).send({ error: '保存失败' });
    }
});

router.get('/admin/list', requireAdminMiddleware, async (request, response) => {
    const offset = Math.max(0, Number(request.query.offset) || 0);
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 50));
    return response.send(await listReferrals({
        query: String(request.query.query ?? ''),
        status: String(request.query.status ?? ''),
        inviter: String(request.query.inviter ?? ''),
        offset,
        limit,
    }));
});

router.post('/admin/revoke', requireAdminMiddleware, async (request, response) => {
    const result = await revokeReferral(String(request.body?.invitee ?? ''), { reclaim: request.body?.reclaim === true, by: request.user.profile.handle });
    return result.ok ? response.send({ status: result.link.status }) : response.status(400).send({ error: result.reason });
});

router.post('/admin/approve', requireAdminMiddleware, async (request, response) => {
    const result = await approveReferral(String(request.body?.invitee ?? ''), { by: request.user.profile.handle });
    return result.ok ? response.send({ status: result.link.status }) : response.status(400).send({ error: result.reason });
});

router.get('/admin/access', requireAdminMiddleware, async (_request, response) => {
    return response.send(await listAccess());
});

router.post('/admin/access', requireAdminMiddleware, async (request, response) => {
    const body = request.body ?? {};
    const result = await setInviterAccess(String(body.handle ?? '').trim(), /** @type {any} */ (String(body.mode ?? '')), {
        revokeAll: body.revokeAll === true,
        reclaim: body.reclaim === true,
        by: request.user.profile.handle,
    });
    return result.ok ? response.send({ mode: result.mode, revoked: result.revoked }) : response.status(400).send({ error: result.reason });
});

/** 跨站邀请的站间接口（不用登录，验签名） */
export const peerRouter = express.Router();

const PEER_HANDLERS = Object.freeze({
    '/info': () => answerPeerInfo(),
    '/lookup': body => answerPeerLookup(body),
    '/sync': body => applyPeerSync(body),
    '/revoked': body => applyPeerRevoke(body),
});

for (const [path, handle] of Object.entries(PEER_HANDLERS)) {
    peerRouter.post(path, async (request, response) => {
        response.set('Cache-Control', 'no-store');
        if (!verifyPeer(request, path)) return response.status(403).send({ error: '签名不对' });
        try {
            return response.send(await handle(request.body ?? {}));
        } catch (error) {
            console.error(`[referrals] peer ${path} failed:`, error);
            return response.status(500).send({ error: '对方站出错了' });
        }
    });
}

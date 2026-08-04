import { recordPerformanceSample } from './performance-telemetry.js';

const RECENT_TRANSITION_DURATION_MS = 240;
const RECENT_TRANSITION_TIMEOUT_MS = 340;
const SHOW_MORE_TIMEOUT_MS = 700;
const MAX_ANIMATED_RECENT_CHATS = 8;
const SHOW_MORE_EXPAND_DURATION_MS = 450;
const SHOW_MORE_COLLAPSE_DURATION_MS = 320;
const SHOW_MORE_STAGGER_MS = 20;

let activeRecentTransition = null;
let activeShowMoreTransition = null;
let transitionSequence = 0;

function isNodeConnected(node) {
    return Boolean(node && node.isConnected !== false);
}

function getMotionBody(documentRef) {
    return documentRef?.body ?? null;
}

/**
 * Check the explicit inliver motion policy. Theme colors are never used as detection signals.
 * @param {object} [dependencies] Browser dependencies
 * @returns {boolean} Whether motion is allowed
 */
export function canUseInliverMotion({
    documentRef = globalThis.document,
    matchMedia = query => globalThis.matchMedia?.(query),
} = {}) {
    const body = getMotionBody(documentRef);
    if (body?.dataset?.uiMotion !== 'inliver') {
        return false;
    }
    try {
        return typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

function nextFrame(requestAnimationFrameFn) {
    return new Promise(resolve => requestAnimationFrameFn(() => resolve()));
}

function getValidRect(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
        return null;
    }
    const rect = element.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function createIdentityLayer(documentRef, source, rect, kind) {
    if (!source || !rect) {
        return null;
    }

    const layer = documentRef.createElement('div');
    layer.className = `st-welcome-motion-identity st-welcome-motion-${kind}`;
    Object.assign(layer.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
    });

    const clone = source.cloneNode(true);
    clone.removeAttribute?.('id');
    clone.setAttribute?.('aria-hidden', 'true');
    const computed = globalThis.getComputedStyle?.(source);
    if (computed) {
        for (const property of ['font', 'color', 'font-weight', 'line-height', 'border-radius']) {
            const value = computed.getPropertyValue(property);
            if (value) {
                clone.style?.setProperty?.(property, value);
            }
        }
    }
    layer.append(clone);
    return { layer, rect };
}

function normalizeTargets(target) {
    if (!target) {
        return { avatar: null, name: null };
    }
    if (target.avatar || target.name) {
        return { avatar: target.avatar ?? null, name: target.name ?? null };
    }
    return { avatar: target, name: null };
}

function animateIdentity(layer, sourceRect, target, { delay = 0, duration = RECENT_TRANSITION_DURATION_MS, documentRef = globalThis.document } = {}) {
    const targetRect = getValidRect(target);
    if (!layer || !sourceRect || !targetRect || typeof layer.animate !== 'function') {
        return null;
    }

    const deltaX = targetRect.left - sourceRect.left;
    const deltaY = targetRect.top - sourceRect.top;
    const scaleX = targetRect.width / sourceRect.width || 1;
    const scaleY = targetRect.height / sourceRect.height || 1;
    const easing = globalThis.getComputedStyle?.(documentRef?.documentElement)
        ?.getPropertyValue('--il-spring')?.trim() || 'cubic-bezier(0.16, 1, 0.3, 1)';

    try {
        return layer.animate([
            { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1, 1)' },
            { opacity: 0.96, transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})` },
        ], {
            duration,
            delay,
            easing,
            fill: 'both',
        });
    } catch {
        return null;
    }
}

async function waitForAnimations(animations, timeoutMs, setTimeoutFn, clearTimeoutFn) {
    if (!animations.length) {
        return;
    }
    let timeoutId;
    const timeout = new Promise(resolve => {
        timeoutId = setTimeoutFn(resolve, timeoutMs);
    });
    const finished = Promise.allSettled(animations.map(animation => Promise.resolve(animation.finished)));
    await Promise.race([finished, timeout]);
    clearTimeoutFn(timeoutId);
}

/**
 * Open a recent chat normally while connecting its avatar and name with a bounded FLIP transition.
 * @param {object} options Transition options
 * @param {HTMLElement} options.card Recent chat card
 * @param {() => Promise<any>|any} options.openChat Existing chat-opening function
 * @param {() => ({avatar?: HTMLElement, name?: HTMLElement}|HTMLElement|null)} options.getTarget Real target resolver
 * @param {object} [options.dependencies] Testable browser dependencies
 * @returns {Promise<any>} Original openChat result
 */
export async function runRecentChatTransition({ card, openChat, getTarget, dependencies = {} }) {
    if (typeof openChat !== 'function') {
        throw new TypeError('Recent chat transition requires an openChat function.');
    }

    const documentRef = dependencies.documentRef ?? globalThis.document;
    const requestAnimationFrameFn = dependencies.requestAnimationFrameFn ?? (callback => globalThis.requestAnimationFrame(callback));
    const setTimeoutFn = dependencies.setTimeoutFn ?? ((...args) => globalThis.setTimeout(...args));
    const clearTimeoutFn = dependencies.clearTimeoutFn ?? (timeoutId => globalThis.clearTimeout(timeoutId));
    const now = dependencies.now ?? (() => globalThis.performance.now());

    if (!canUseInliverMotion({
        documentRef,
        matchMedia: dependencies.matchMedia ?? (query => globalThis.matchMedia?.(query)),
    })
        || !isNodeConnected(card)) {
        return await openChat();
    }

    const sourceAvatar = card.querySelector?.('.avatar');
    const sourceName = card.querySelector?.('.chatName .characterName, .chatName');
    const avatarRect = getValidRect(sourceAvatar);
    const nameRect = getValidRect(sourceName);
    if (!avatarRect && !nameRect) {
        return await openChat();
    }

    cancelWelcomeMotion();
    const id = ++transitionSequence;
    const startedAt = now();
    const overlay = documentRef.createElement('div');
    overlay.className = 'st-welcome-motion-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    const avatarIdentity = createIdentityLayer(documentRef, sourceAvatar, avatarRect, 'avatar');
    const nameIdentity = createIdentityLayer(documentRef, sourceName, nameRect, 'name');
    if (avatarIdentity) overlay.append(avatarIdentity.layer);
    if (nameIdentity) overlay.append(nameIdentity.layer);
    documentRef.body.append(overlay);

    const animations = [];
    const hiddenTargets = [];
    let cleaned = false;
    let cancelled = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        for (const animation of animations) animation.cancel?.();
        for (const { element, visibility } of hiddenTargets) element.style.visibility = visibility;
        overlay.remove?.();
        if (activeRecentTransition?.id === id) activeRecentTransition = null;
    };
    activeRecentTransition = {
        id,
        cancel: () => {
            cancelled = true;
            cleanup();
        },
    };

    try {
        const result = await openChat();
        if (activeRecentTransition?.id !== id) {
            cancelled = true;
            return result;
        }

        let targets = normalizeTargets(getTarget?.());
        for (let attempt = 0; attempt < 2 && !targets.avatar && !targets.name; attempt++) {
            await nextFrame(requestAnimationFrameFn);
            targets = normalizeTargets(getTarget?.());
        }

        for (const target of [targets.avatar, targets.name]) {
            if (target?.style) {
                hiddenTargets.push({ element: target, visibility: target.style.visibility });
                target.style.visibility = 'hidden';
            }
        }

        const avatarAnimation = animateIdentity(avatarIdentity?.layer, avatarIdentity?.rect, targets.avatar, { documentRef });
        const nameAnimation = animateIdentity(nameIdentity?.layer, nameIdentity?.rect, targets.name, { delay: 24, duration: 260, documentRef });
        if (avatarAnimation) animations.push(avatarAnimation);
        if (nameAnimation) animations.push(nameAnimation);

        if (!animations.length && typeof overlay.animate === 'function') {
            try {
                animations.push(overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
                    duration: 100,
                    easing: 'ease-out',
                    fill: 'both',
                }));
            } catch {
                // A missing WAAPI implementation is a valid zero-motion fallback.
            }
        }
        await waitForAnimations(animations, RECENT_TRANSITION_TIMEOUT_MS, setTimeoutFn, clearTimeoutFn);
        return result;
    } finally {
        cancelled ||= activeRecentTransition?.id !== id;
        cleanup();
        recordPerformanceSample('welcome-recent-chat-transition', now() - startedAt, {
            cancelled: Number(cancelled),
        });
    }
}

/**
 * Animate only a bounded subset of the recent-chat expansion while committing all item visibility.
 * @param {object} options Transition options
 * @param {Iterable<HTMLElement>} options.items Initially hidden recent-chat items
 * @param {boolean} options.expanded Desired final state
 * @param {object} [options.dependencies] Testable browser dependencies
 */
export async function runShowMoreTransition({ items, expanded, dependencies = {} }) {
    const nodes = [...(items ?? [])];
    const documentRef = dependencies.documentRef ?? globalThis.document;
    const setTimeoutFn = dependencies.setTimeoutFn ?? ((...args) => globalThis.setTimeout(...args));
    const clearTimeoutFn = dependencies.clearTimeoutFn ?? (timeoutId => globalThis.clearTimeout(timeoutId));
    const now = dependencies.now ?? (() => globalThis.performance.now());
    const motionAllowed = canUseInliverMotion({
        documentRef,
        matchMedia: dependencies.matchMedia ?? (query => globalThis.matchMedia?.(query)),
    });

    activeShowMoreTransition?.cancel();
    if (!motionAllowed || nodes.length === 0) {
        nodes.forEach(node => node.classList.toggle('hidden', !expanded));
        return;
    }

    const id = ++transitionSequence;
    const startedAt = now();
    let cancelled = false;
    let cleaned = false;
    const animations = [];
    const animatedNodes = nodes.slice(0, MAX_ANIMATED_RECENT_CHATS);
    nodes.forEach(node => node.classList.remove('hidden'));
    const easing = globalThis.getComputedStyle?.(documentRef?.documentElement)
        ?.getPropertyValue('--il-spring')?.trim() || 'cubic-bezier(0.16, 1, 0.3, 1)';

    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        animations.forEach(animation => animation.cancel?.());
        animatedNodes.forEach(node => node.classList.remove('st-motion-running'));
        if (activeShowMoreTransition?.id === id) activeShowMoreTransition = null;
    };
    activeShowMoreTransition = {
        id,
        cancel: () => {
            cancelled = true;
            cleanup();
        },
    };

    try {
        animatedNodes.forEach((node, index) => {
            node.classList.add('st-motion-running');
            if (typeof node.animate !== 'function') return;
            const keyframes = expanded
                ? [
                    { opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.99)' },
                    { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
                ]
                : [
                    { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
                    { opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.99)' },
                ];
            try {
                animations.push(node.animate(keyframes, {
                    duration: expanded ? SHOW_MORE_EXPAND_DURATION_MS : SHOW_MORE_COLLAPSE_DURATION_MS,
                    delay: index * SHOW_MORE_STAGGER_MS,
                    easing,
                    fill: 'both',
                }));
            } catch {
                // A single card animation failure must not block the visibility commit.
            }
        });

        await waitForAnimations(animations, SHOW_MORE_TIMEOUT_MS, setTimeoutFn, clearTimeoutFn);
        if (activeShowMoreTransition?.id === id) {
            nodes.forEach(node => node.classList.toggle('hidden', !expanded));
        }
    } finally {
        cancelled ||= activeShowMoreTransition?.id !== id;
        cleanup();
        recordPerformanceSample('welcome-show-more-transition', now() - startedAt, {
            items: animatedNodes.length,
            cancelled: Number(cancelled),
        });
    }
}

/** Cancel and fully clean all welcome-screen motion artifacts. */
export function cancelWelcomeMotion() {
    activeRecentTransition?.cancel();
    activeShowMoreTransition?.cancel();
    activeRecentTransition = null;
    activeShowMoreTransition = null;
}

import { CATEGORY_ICONS, esc, finishWorkTreeChange, flushPendingSaves, gitApi, timeAgo } from '../shared.js';
import { reloadSmartCommit } from '../smart-commit.js';

/**
 * 快速开始: the same two paths as the setup wizard (start here / restore from a remote) for people
 * who don't read: one short question per screen, a few words per step, links that open exactly
 * the page to click on, and the address and token checked before anything happens. Automatic
 * saving is turned on without asking; it can be changed in 设置.
 */

const REPO_NAME = 'tavern-backup';

/** Per-platform pages and what to click there, a few words per step. */
const PLATFORMS = {
    github: {
        label: 'GitHub',
        hint: '推荐',
        icon: 'fa-brands fa-github',
        host: 'github.com',
        newRepo: `https://github.com/new?name=${REPO_NAME}&visibility=private`,
        newRepoSteps: ['点下面的按钮', '没账号就先注册', '点绿色的 <b>Create repository</b>'],
        token: 'https://github.com/settings/tokens/new?scopes=repo&description=Tavern%20Git',
        tokenSteps: ['点下面的按钮', '有效期选 <b>No expiration</b>', '点绿色的 <b>Generate token</b>', '复制 <code>ghp_</code> 开头那串'],
        tokenPattern: /^(ghp_|github_pat_|gho_)/,
    },
    gitee: {
        label: 'Gitee',
        hint: '国内能打开',
        icon: 'fa-solid fa-g',
        host: 'gitee.com',
        newRepo: 'https://gitee.com/projects/new',
        newRepoSteps: [`名字填 <code>${REPO_NAME}</code>`, '选 <b>私有</b>', '点 <b>创建</b>'],
        copyName: true,
        token: 'https://gitee.com/profile/personal_access_tokens/new',
        tokenSteps: ['点下面的按钮', '描述随便写', '点 <b>提交</b>', '复制那串字'],
        tokenPattern: /^[0-9a-f]{32}$/i,
        needsUsername: true,
    },
    gitlab: {
        label: 'GitLab',
        hint: '',
        icon: 'fa-brands fa-gitlab',
        host: 'gitlab.com',
        newRepo: 'https://gitlab.com/projects/new#blank_project',
        newRepoSteps: [`名字填 <code>${REPO_NAME}</code>`, '选 <b>Private</b>', '去掉 <b>README</b> 的勾', '点 <b>Create project</b>'],
        copyName: true,
        token: 'https://gitlab.com/-/user_settings/personal_access_tokens?name=Tavern%20Git&scopes=write_repository',
        tokenSteps: ['点下面的按钮', '点 <b>Create token</b>', '复制 <code>glpat-</code> 开头那串'],
        tokenPattern: /^glpat-/,
    },
    custom: {
        label: '其他',
        hint: '我有自己的 Git 服务',
        icon: 'fa-solid fa-server',
        host: '',
        tokenSteps: ['建一个能读写仓库的令牌', '复制过来'],
        needsUsername: true,
    },
};

/**
 * Tidies whatever the user pasted into a clone address: adds https://, drops the page part of a
 * browser address (…/tree/main) and adds .git on the big hosts.
 * @param {string} raw
 * @param {string} platformId
 * @returns {{ url?: string, owner?: string, platform?: string, error?: string }}
 */
export function cleanRepoAddress(raw, platformId) {
    let text = String(raw ?? '').trim().replace(/^[“"'「]+|[”"'」]+$/g, '').trim();
    if (!text) return { error: '还没贴' };
    if (/^(ghp_|github_pat_|glpat-)/.test(text) || (/^[0-9a-f]{32}$/i.test(text))) return { error: '这是钥匙，不是网址。钥匙下一步再贴' };
    if (text.startsWith('git@')) text = text.replace(/^git@([^:]+):/, 'https://$1/');
    if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
    let url;
    try {
        url = new URL(text);
    } catch {
        return { error: '这不是网址' };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const platform = Object.entries(PLATFORMS).find(([, entry]) => entry.host && host === entry.host)?.[0] ?? (platformId === 'custom' ? 'custom' : null);
    if (!platform) return { error: `这不是 ${PLATFORMS[platformId].label} 的网址` };
    let segments = url.pathname.split('/').filter(Boolean);
    if (platform !== 'custom') {
        const pagePart = segments.findIndex((segment, index) => segment === '-' || (index >= 2 && ['tree', 'blob', 'commits', 'issues', 'pulls', 'settings', 'wikis'].includes(segment)));
        if (pagePart >= 0) segments = segments.slice(0, pagePart);
        if (platform !== 'gitlab') segments = segments.slice(0, 2);
        if (['new', 'settings', 'projects', 'profile', 'dashboard'].includes(segments[0])) return { error: '还没点创建。先创建，再复制网址' };
        if (segments.length < 2) return { error: '网址不完整' };
        segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, '') + '.git';
    }
    url.pathname = '/' + segments.join('/');
    url.search = '';
    url.hash = '';
    return { url: url.toString(), owner: segments[0] ?? '', platform };
}

/** @param {HTMLElement} input */
async function pasteInto(input) {
    try {
        input.value = (await navigator.clipboard.readText()).trim();
        input.dispatchEvent(new Event('input'));
    } catch {
        input.focus();
        toastr.info('长按输入框，选“粘贴”');
    }
}

/**
 * @param {HTMLElement} container
 * @param {import('../index.js').PanelApp} app
 * @param {{ onlineOnly?: boolean, onExit?: () => void }} [options] onlineOnly: the repository exists, only connect it to the internet
 */
export function renderQuickStart(container, app, { onlineOnly = false, onExit } = {}) {
    /** Answers so far. */
    const answers = {
        mode: onlineOnly ? 'new' : '',
        online: onlineOnly,
        platform: '',
        url: '',
        owner: '',
        username: '',
        token: '',
        branch: '',
        branches: [],
        /** 酒馆云 (the site's own git server) instead of an account on a git host */
        cloud: false,
        remote: 'origin',
        force: false,
        cloudChoices: [],
        /** Auto-save every this many messages (0: only by hand) */
        every: 5,
        /** Tracking rules when the user picked "只存一部分" */
        rules: null,
    };
    const cloudLabel = app.state.hosted?.label ?? '';
    const trail = [];

    const show = (screen, remember = true) => {
        if (remember && current) trail.push(current);
        current = screen;
        draw();
    };
    const back = () => {
        const previous = trail.pop();
        if (!previous) {
            onExit?.();
            return;
        }
        current = previous;
        draw();
    };
    let current = null;

    /** Screen order for the progress dots. */
    const route = () => {
        const first = onlineOnly ? [] : ['intro', 'start'];
        if (answers.mode === 'restore') return answers.cloud ? [...first, 'platform', 'freq', 'confirm'] : [...first, 'platform', 'url', 'token', 'freq', 'confirm'];
        if (!answers.online) return [...first, 'where', 'freq', 'run'];
        if (answers.cloud) return onlineOnly ? ['platform', 'freq', 'run'] : [...first, 'where', 'freq', 'run'];
        return [...first, ...(onlineOnly ? [] : ['where']), 'platform', 'repo', 'url', 'token', 'freq', 'run'];
    };

    const frame = (inner) => {
        const steps = route();
        const index = Math.max(steps.indexOf(current), 0);
        container.innerHTML = `
            <div class="git-sync-qs">
                <div class="git-sync-qs-top">
                    <button type="button" class="git-sync-qs-back" data-qs="back"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                    <div class="git-sync-qs-dots">${steps.map((_, i) => `<span class="${i < index ? 'done' : i === index ? 'now' : ''}"></span>`).join('')}</div>
                </div>
                ${inner}
                <div class="git-sync-qs-error" hidden></div>
            </div>`;
        const backButton = container.querySelector('[data-qs="back"]');
        backButton.addEventListener('click', back);
        if (!trail.length && !onExit) backButton.hidden = true;
        // Not scrollIntoView: on phones the tavern transforms <html>, and that scrolls the whole page.
        const scroller = container.closest('.git-sync-body');
        if (scroller) scroller.scrollTop = 0;
    };
    /**
     * Shows an error under the current screen, with a big "重试" button when `retry` is given.
     * @param {string} text HTML
     * @param {() => any} [retry]
     */
    const fail = (text, retry) => {
        const box = container.querySelector('.git-sync-qs-error');
        box.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> ${text}${retry ? '<button type="button" class="menu_button git-sync-qs-retry"><i class="fa-solid fa-rotate-right"></i> 重试</button>' : ''}`;
        box.hidden = false;
        box.querySelector('.git-sync-qs-retry')?.addEventListener('click', () => {
            box.hidden = true;
            retry();
        });
        const scroller = container.closest('.git-sync-body');
        if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    };
    const choices = (items) => `<div class="git-sync-qs-choices">${items.map(item => `
        <button type="button" class="git-sync-qs-choice${item.primary ? ' primary' : ''}" data-choice="${esc(item.id)}">
            <i class="${item.icon.includes(' ') ? item.icon : `fa-solid ${item.icon}`}"></i>
            <span><b>${item.title}</b>${item.text ? `<small>${item.text}</small>` : ''}</span>
        </button>`).join('')}</div>`;
    const onChoice = (handler) => container.querySelectorAll('[data-choice]').forEach(button => button.addEventListener('click', () => handler(button.dataset.choice)));
    const head = (icon, title, text = '') => `
        <div class="git-sync-qs-head">
            <i class="fa-solid ${icon}"></i>
            <h2>${title}</h2>
            ${text ? `<p>${text}</p>` : ''}
        </div>`;
    const next = (label = '下一步', icon = 'fa-arrow-right') => `<button type="button" class="menu_button git-sync-qs-next" data-qs="next">${label} <i class="fa-solid ${icon}"></i></button>`;
    const platform = () => PLATFORMS[answers.platform];
    const openLink = (href, label = '打开') => `<a class="menu_button git-sync-qs-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${label}</a>`;
    const stepList = (items) => `<ol class="git-sync-qs-steps">${items.map(item => `<li>${item}</li>`).join('')}</ol>`;
    const pasteField = (field, value, placeholder, type = 'text') => `
        <div class="git-sync-qs-field">
            <input class="text_pole" data-field="${field}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="${type === 'password' ? 'new-password' : 'off'}">
            <button type="button" class="menu_button" data-qs="paste"><i class="fa-solid fa-paste"></i> 粘贴</button>
        </div>
        <div class="git-sync-qs-check" data-check></div>`;
    const mark = (check, problem, okText) => {
        check.className = `git-sync-qs-check ${problem ? 'bad' : 'good'}`;
        check.innerHTML = problem ? `<i class="fa-solid fa-circle-exclamation"></i> ${esc(problem)}` : `<i class="fa-solid fa-circle-check"></i> ${okText}`;
    };

    const screens = {
        /** What it does, as a small looping animation, then one button. */
        intro() {
            const scenes = [
                ['save', '聊天时自动存，' + (cloudLabel ? `放到${esc(cloudLabel)}` : '随时有备份'), `
                    <div class="git-sync-demo-stage">
                        <span class="git-sync-demo-node n1"><i class="fa-solid fa-comments"></i></span>
                        <span class="git-sync-demo-line l1"><i></i></span>
                        <span class="git-sync-demo-node n2"><i class="fa-solid fa-floppy-disk"></i></span>
                        <span class="git-sync-demo-line l2"><i></i></span>
                        <span class="git-sync-demo-node n3"><i class="fa-solid fa-cloud"></i></span>
                    </div>`],
                ['rewind', '存错了？随时回到过去', `
                    <div class="git-sync-demo-timeline">
                        <span class="git-sync-demo-track"></span>
                        ${[1, 2, 3, 4, 5].map(i => `<span class="git-sync-demo-tick k${i}"></span>`).join('')}
                        <span class="git-sync-demo-cursor"><i class="fa-solid fa-backward"></i></span>
                    </div>`],
                ['branch', '开个平行世界，试另一种结局', `
                    <svg class="git-sync-demo-fork" viewBox="0 0 300 90">
                        <path class="main" d="M10 62 H290"/>
                        <path class="side" d="M120 62 C150 62 150 22 180 22 H290"/>
                        <circle class="d1" cx="40" cy="62" r="7"/><circle class="d2" cx="120" cy="62" r="7"/>
                        <circle class="d3" cx="210" cy="62" r="7"/><circle class="d4" cx="270" cy="62" r="7"/>
                        <circle class="s1" cx="210" cy="22" r="7"/><circle class="s2" cx="270" cy="22" r="7"/>
                    </svg>
                    <div class="git-sync-demo-forklabels"><span class="a">主线</span><span class="b">if 线</span></div>`],
                ['protect', '重 roll、删除之前，先自动存一份', `
                    <div class="git-sync-demo-protect">
                        <span class="git-sync-demo-node p1"><i class="fa-solid fa-rotate"></i></span>
                        <span class="git-sync-demo-shield"><i class="fa-solid fa-shield-heart"></i></span>
                        <span class="git-sync-demo-node p2"><i class="fa-solid fa-trash-can"></i></span>
                    </div>`],
                ['tags', '给重要时刻起名字，以后好找', `
                    <div class="git-sync-demo-timeline">
                        <span class="git-sync-demo-track"></span>
                        ${[1, 2, 3, 4, 5].map(i => `<span class="git-sync-demo-tick k${i}"></span>`).join('')}
                        <span class="git-sync-demo-flag f1"><i class="fa-solid fa-bookmark"></i> 第一章完</span>
                        <span class="git-sync-demo-flag f2"><i class="fa-solid fa-bookmark"></i> 表白前</span>
                    </div>`],
            ];
            frame(`
                <div class="git-sync-demo" title="点一下看下一个">
                    ${scenes.map(([id, caption, visual], index) => `
                    <div class="git-sync-demo-scene scene-${id}${index ? '' : ' on'}" aria-hidden="${index ? 'true' : 'false'}">
                        <div class="git-sync-demo-visual">${visual}</div>
                        <div class="git-sync-demo-caption">${caption}</div>
                    </div>`).join('')}
                    <div class="git-sync-demo-dots">${scenes.map((_, index) => `<span class="${index ? '' : 'on'}"></span>`).join('')}</div>
                </div>`
                + head('fa-code-branch', '酒馆 Git', '自动帮你存聊天、角色卡<br>存错了、删错了都能找回来')
                + `<div class="git-sync-qs-foot center">${next('开始', 'fa-arrow-right')}</div>
                <p class="git-sync-qs-beta"><i class="fa-solid fa-flask"></i> 测试版：重要数据请再用“备份与导出”存一份</p>`);
            const demo = container.querySelector('.git-sync-demo');
            const sceneEls = [...demo.querySelectorAll('.git-sync-demo-scene')];
            const dots = [...demo.querySelectorAll('.git-sync-demo-dots span')];
            let index = 0;
            // The first time, "开始" waits until every scene has been shown (tapping through counts).
            const seen = new Set([0]);
            const nextButton = /** @type {HTMLButtonElement} */ (container.querySelector('[data-qs="next"]'));
            const nextLabel = nextButton.innerHTML;
            let watched = false;
            try {
                watched = localStorage.getItem('git_sync_intro_seen') === '1';
            } catch {
                // No storage: show it every time.
            }
            const updateGate = () => {
                if (watched || seen.size >= sceneEls.length) {
                    watched = true;
                    nextButton.disabled = false;
                    nextButton.innerHTML = nextLabel;
                    try {
                        localStorage.setItem('git_sync_intro_seen', '1');
                    } catch {
                        // Ignore
                    }
                    return;
                }
                nextButton.disabled = true;
                nextButton.innerHTML = `先看完介绍 ${seen.size}/${sceneEls.length} <i class="fa-solid fa-eye"></i>`;
            };
            const showScene = (next) => {
                sceneEls[index].classList.remove('on');
                sceneEls[index].setAttribute('aria-hidden', 'true');
                dots[index].classList.remove('on');
                index = next % sceneEls.length;
                // Re-adding the class restarts the scene's animation.
                void sceneEls[index].offsetWidth;
                sceneEls[index].classList.add('on');
                sceneEls[index].setAttribute('aria-hidden', 'false');
                dots[index].classList.add('on');
                seen.add(index);
                if (!watched) updateGate();
            };
            updateGate();
            const timer = setInterval(() => {
                if (!demo.isConnected) return clearInterval(timer);
                showScene(index + 1);
            }, 3400);
            demo.addEventListener('click', () => showScene(index + 1));
            container.querySelector('[data-qs="next"]').addEventListener('click', () => {
                clearInterval(timer);
                show('start');
            });
        },
        /** "只存一部分": big toggles per kind of data. */
        scope() {
            const rules = answers.rules ?? structuredClone(app.state.settings.rules);
            frame(head('fa-list-check', '要存哪些？', '点一下切换，亮的会存')
                + `<div class="git-sync-qs-tiles">${app.state.categories.map(category => `
                    <button type="button" class="git-sync-qs-tile${rules.categories[category.id] ? ' on' : ''}" data-category="${esc(category.id)}">
                        <i class="fa-solid ${CATEGORY_ICONS[category.id] ?? 'fa-file'}"></i><span>${esc(category.label)}</span>
                    </button>`).join('')}</div>`
                + `<div class="git-sync-qs-foot">${next('好了', 'fa-check')}</div>`);
            container.querySelectorAll('[data-category]').forEach(tile => tile.addEventListener('click', () => {
                tile.classList.toggle('on');
                rules.categories[tile.dataset.category] = tile.classList.contains('on');
            }));
            container.querySelector('[data-qs="next"]').addEventListener('click', () => {
                if (!Object.values(rules.categories).some(Boolean)) return fail('至少选一样');
                answers.rules = rules;
                back();
            });
        },
        /** How often to save automatically. */
        freq() {
            frame(head('fa-stopwatch', '多久自动存一次？', '存得越勤，丢得越少') + choices([
                { id: '5', icon: 'fa-gauge', title: '每 5 条消息', text: '推荐', primary: true },
                { id: '2', icon: 'fa-gauge-high', title: '每次 AI 回复后', text: '一条都不丢' },
                { id: '10', icon: 'fa-gauge-simple', title: '每 10 条消息', text: '历史记录少一点' },
                { id: '0', icon: 'fa-hand-pointer', title: '不自动存', text: '我自己点' },
            ]) + `<ul class="git-sync-qs-notes">
                <li><i class="fa-solid fa-shield-heart"></i> 重 roll、删除之前也会先存一份</li>
                <li><i class="fa-solid fa-wand-magic-sparkles"></i> 存档说明由你的 AI 写一句，花一点点 token，可在设置里关</li>
            </ul>`);
            onChoice((id) => {
                answers.every = Number(id);
                show(answers.mode === 'restore' ? 'confirm' : 'run');
            });
        },
        start() {
            frame(head('fa-hand-sparkles', '第一次用吗？') + choices([
                { id: 'new', icon: 'fa-seedling', title: '是', text: '帮我存起来', primary: true },
                { id: 'restore', icon: 'fa-cloud-arrow-down', title: '不是', text: '我要找回以前的备份' },
            ]));
            onChoice((id) => {
                answers.mode = id;
                answers.online = id === 'restore';
                show(id === 'restore' ? 'platform' : 'where');
            });
        },
        where() {
            frame(head('fa-box-archive', '存在哪？') + choices(cloudLabel ? [
                { id: 'cloud', icon: 'fa-cloud', title: `存到${esc(cloudLabel)}`, text: '最安全 · 点一下就好', primary: true },
                { id: 'online', icon: 'fa-brands fa-github', title: '存到 GitHub 等', text: '要自己注册账号' },
            ] : [
                { id: 'online', icon: 'fa-cloud', title: '存网上', text: '最安全 · 推荐', primary: true },
                { id: 'local', icon: 'fa-house', title: '只存这里', text: '最快 · 点一下就好' },
            ]));
            container.querySelector('.git-sync-qs-choices').insertAdjacentHTML('afterend', `<button type="button" class="git-sync-qs-skip" data-qs="scope">${answers.rules ? '<i class="fa-solid fa-check"></i> 已选好要存的内容，改一下？' : '只存一部分？'}</button>`);
            container.querySelector('[data-qs="scope"]').addEventListener('click', () => show('scope'));
            onChoice((id) => {
                if (id === 'cloud') return useCloud();
                answers.cloud = false;
                answers.remote = 'origin';
                answers.online = id === 'online';
                show(answers.online ? 'platform' : 'freq');
            });
        },
        platform() {
            const restoring = answers.mode === 'restore';
            frame(head('fa-globe', restoring ? '备份在哪？' : '选一个网站', restoring ? '' : '都免费') + choices([
                ...(cloudLabel ? [{ id: 'cloud', icon: 'fa-cloud', title: esc(cloudLabel), text: restoring ? '' : '点一下就好 · 推荐', primary: true }] : []),
                ...Object.entries(PLATFORMS).map(([id, entry]) => ({ id, icon: entry.icon, title: entry.label, text: entry.hint, primary: id === 'github' && !restoring && !cloudLabel })),
            ]));
            onChoice((id) => {
                if (id === 'cloud') return useCloud();
                answers.cloud = false;
                answers.remote = 'origin';
                answers.platform = id;
                show(restoring || id === 'custom' ? 'url' : 'repo');
            });
        },
        repo() {
            const entry = platform();
            frame(head('fa-folder-plus', '建一个仓库', '仓库 = 放备份的文件夹')
                + stepList(entry.newRepoSteps)
                + `<div class="git-sync-qs-actions">
                    ${openLink(entry.newRepo)}
                    ${entry.copyName ? '<button type="button" class="menu_button git-sync-qs-link" data-qs="copy-name"><i class="fa-solid fa-copy"></i> 复制名字</button>' : ''}
                </div>`
                + `<div class="git-sync-qs-foot">${next('建好了')}</div>`);
            container.querySelector('[data-qs="copy-name"]')?.addEventListener('click', () => navigator.clipboard?.writeText(REPO_NAME).then(() => toastr.success('已复制')).catch(() => toastr.info(REPO_NAME)));
            container.querySelector('[data-qs="next"]').addEventListener('click', () => show('url'));
        },
        url() {
            const restoring = answers.mode === 'restore';
            const example = platform().host ? `https://${platform().host}/你的名字/${REPO_NAME}` : 'https://…';
            frame(head('fa-link', '复制网址', restoring ? '打开你的备份仓库<br>复制<b>浏览器顶上</b>的网址' : '复制<b>浏览器顶上</b>的网址')
                + pasteField('url', answers.url, example)
                + `<div class="git-sync-qs-foot">${next()}</div>`);
            const input = /** @type {HTMLInputElement} */ (container.querySelector('[data-field="url"]'));
            const check = container.querySelector('[data-check]');
            const validate = () => {
                if (!input.value.trim()) {
                    check.innerHTML = '';
                    return null;
                }
                const result = cleanRepoAddress(input.value, answers.platform);
                mark(check, result.error, '对了');
                return result;
            };
            input.addEventListener('input', validate);
            validate();
            container.querySelector('[data-qs="paste"]').addEventListener('click', () => pasteInto(input));
            container.querySelector('[data-qs="next"]').addEventListener('click', () => {
                const result = validate();
                if (!result) return fail('先把网址贴进来');
                if (result.error) return fail(esc(result.error));
                answers.url = result.url;
                answers.owner = result.owner;
                answers.platform = result.platform;
                if (!answers.username) answers.username = result.owner;
                show('token');
            });
        },
        token() {
            const restoring = answers.mode === 'restore';
            const entry = platform();
            frame(head('fa-key', '拿一把钥匙', '有了钥匙才能存进去')
                + stepList(entry.tokenSteps)
                + (entry.token ? `<div class="git-sync-qs-actions">${openLink(entry.token)}</div>` : '')
                + (answers.platform === 'custom' ? `<label class="git-sync-qs-label">用户名
                    <input class="text_pole" data-field="username" value="${esc(answers.username)}" spellcheck="false" autocomplete="off"></label>` : '')
                + pasteField('token', answers.token, '把钥匙贴到这里', 'password')
                + `<div class="git-sync-qs-foot">
                    ${restoring ? '<button type="button" class="git-sync-qs-skip" data-qs="skip">仓库是公开的？跳过</button>' : ''}
                    ${next('连接', 'fa-plug')}
                </div>`);
            const input = /** @type {HTMLInputElement} */ (container.querySelector('[data-field="token"]'));
            const check = container.querySelector('[data-check]');
            const validate = () => {
                const value = input.value.trim();
                if (!value) {
                    check.innerHTML = '';
                    return;
                }
                mark(check, /^https?:\/\//.test(value) ? '这是网址，不是钥匙'
                    : /\s/.test(value) ? '多复制了空格'
                        : entry.tokenPattern && !entry.tokenPattern.test(value) ? '好像不太对，点“连接”试试' : '', '收到');
            };
            input.addEventListener('input', validate);
            validate();
            container.querySelector('[data-qs="paste"]').addEventListener('click', () => pasteInto(input));
            const connect = async (useToken) => {
                answers.token = useToken ? input.value.trim() : '';
                answers.username = container.querySelector('[data-field="username"]')?.value.trim() || answers.owner;
                if (useToken && !answers.token) return fail('先把钥匙贴进来');
                if (/^https?:\/\//.test(answers.token)) return fail('这是网址，不是钥匙');
                try {
                    const info = await app.busy('连接中…', async () => {
                        await gitApi('/remote/save', { name: 'origin', url: answers.url, provider: answers.platform === 'custom' ? '' : answers.platform, username: answers.username, token: answers.token, clearToken: !answers.token });
                        return gitApi('/remote/test', { name: 'origin' });
                    });
                    if (restoring) {
                        if (!info.branches.length) return fail('这个仓库是空的，没有备份');
                        answers.branches = info.branches.map(branch => branch.name);
                        answers.branch = info.defaultBranch || answers.branches[0];
                        show('freq');
                        return;
                    }
                    if (!info.canPush) return fail('钥匙权限不够，按上面步骤重新拿一把');
                    if (info.branches.length) return fail('这个仓库里已经有东西了，换一个新的空仓库');
                    show('freq');
                } catch (error) {
                    fail(friendlyError(error));
                }
            };
            container.querySelector('[data-qs="next"]').addEventListener('click', () => connect(true));
            container.querySelector('[data-qs="skip"]')?.addEventListener('click', () => connect(false));
        },
        /** Several sites have a backup of this (Discord) account. */
        cloudPick() {
            frame(head('fa-clock-rotate-left', '找回哪一份？') + choices(answers.cloudChoices.map(entry => ({
                id: entry.site, icon: 'fa-cloud', title: esc(entry.label), text: entry.updatedAt ? `上次存：${timeAgo(Date.parse(entry.updatedAt) / 1000)}` : '',
            }))));
            onChoice(site => connectCloud(site));
        },
        /** Starting fresh, but this site's cloud repository already holds a backup. */
        cloudExists() {
            frame(head('fa-cloud', `${esc(cloudLabel)}里已经有你的备份`) + choices([
                { id: 'restore', icon: 'fa-cloud-arrow-down', title: '找回它', text: '换成云上那份', primary: true },
                { id: 'overwrite', icon: 'fa-arrow-up-from-bracket', title: '用现在的覆盖它', text: '云上那份会被替换' },
            ]));
            onChoice((id) => {
                if (id === 'restore') {
                    answers.mode = 'restore';
                    void connectCloud(app.state.hosted?.site ?? '');
                    return;
                }
                answers.force = true;
                show('freq');
            });
        },
        confirm() {
            frame(head('fa-cloud-arrow-down', '换成网上的备份？')
                + `<ul class="git-sync-qs-facts">
                    <li><i class="fa-solid fa-arrows-rotate"></i> 现在的聊天、角色卡会被换掉</li>
                    <li><i class="fa-solid fa-shield-heart"></i> 换之前会自动存一份，后悔能找回</li>
                </ul>`
                + (answers.branches.length > 1 ? `<label class="git-sync-qs-label">恢复哪一份？<small>不懂就别改</small>
                    <select class="text_pole" data-field="branch">${answers.branches.map(name => `<option${name === answers.branch ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>` : '')
                + '<div class="git-sync-qs-foot"><button type="button" class="menu_button git-sync-qs-next" data-qs="next"><i class="fa-solid fa-cloud-arrow-down"></i> 开始恢复</button></div>');
            const restore = async () => {
                answers.branch = container.querySelector('[data-field="branch"]')?.value || answers.branch;
                try {
                    await flushPendingSaves();
                    await saveAutoSave();
                    const result = await app.busy('恢复中，别关页面…', () => gitApi('/import', { remote: answers.remote, branch: answers.branch }));
                    container.innerHTML = doneHtml('恢复好了！', '马上自动刷新');
                    finishWorkTreeChange(result, '恢复完成');
                } catch (error) {
                    fail(friendlyError(error), restore);
                }
            };
            container.querySelector('[data-qs="next"]').addEventListener('click', restore);
        },
        async run() {
            const tasks = [
                ...(onlineOnly ? [] : [{ label: '建仓库', work: () => gitApi('/init', { branch: 'main', ...(answers.rules ? { rules: answers.rules } : {}) }) }]),
                ...(onlineOnly ? [] : [{
                    label: '存第一份', work: async () => {
                        await flushPendingSaves();
                        await gitApi('/commit', { message: '第一份存档', split: true }).catch(error => {
                            if (error.status !== 409) throw error;
                        });
                    },
                }]),
                ...(answers.cloud && onlineOnly ? [{ label: `连上${esc(cloudLabel)}`, work: () => gitApi('/hosted/connect') }] : []),
                ...(answers.online ? [{ label: answers.cloud ? `传到${esc(cloudLabel)}` : '传到网上', work: () => gitApi('/push', { remote: answers.remote, force: answers.force || answers.cloud }) }] : []),
                { label: answers.every ? '打开自动存' : '记下设置', work: saveAutoSave },
            ];
            frame(head('fa-gears', '稍等…', '别关页面')
                + `<ul class="git-sync-qs-progress">${tasks.map(task => `<li><i class="fa-regular fa-circle"></i> ${task.label}</li>`).join('')}</ul>`);
            container.querySelector('[data-qs="back"]').hidden = true;
            const rows = container.querySelectorAll('.git-sync-qs-progress li');
            /** Runs the steps from `start`; "重试" continues from the step that failed. */
            const runFrom = async (start) => {
                for (let index = start; index < tasks.length; index++) {
                    const row = rows[index];
                    const icon = row.querySelector('i');
                    row.classList.remove('failed');
                    row.classList.add('active');
                    icon.className = 'fa-solid fa-spinner fa-spin';
                    try {
                        await tasks[index].work();
                        icon.className = 'fa-solid fa-circle-check';
                        row.classList.replace('active', 'done');
                    } catch (error) {
                        icon.className = 'fa-solid fa-circle-xmark';
                        row.classList.replace('active', 'failed');
                        container.querySelector('[data-qs="back"]').hidden = false;
                        fail(friendlyError(error), () => runFrom(index));
                        return;
                    }
                }
                const where = answers.cloud ? `${esc(cloudLabel)}里也有一份` : answers.online ? '网上也有一份' : '';
                container.innerHTML = doneHtml('搞定！', `已存好${where ? `，${where}` : ''}<br>${answers.every ? '以后会自动存' : '想存的时候点“全部提交”'}`,
                    `${howToRestore()}
                    <div class="git-sync-qs-foot">
                        <button type="button" class="menu_button git-sync-qs-link" data-qs="history"><i class="fa-solid fa-clock-rotate-left"></i> 去看看</button>
                        <button type="button" class="menu_button git-sync-qs-next" data-qs="finish">好 <i class="fa-solid fa-check"></i></button>
                    </div>`);
                container.querySelector('[data-qs="finish"]').addEventListener('click', () => app.refresh('overview'));
                container.querySelector('[data-qs="history"]').addEventListener('click', () => app.refresh('history'));
            };
            await runFrom(0);
        },
    };

    /** 酒馆云 chosen: see what this account already has there. */
    const useCloud = async () => {
        answers.cloud = true;
        answers.online = true;
        answers.remote = 'cloud';
        answers.force = false;
        let info;
        try {
            info = await app.busy('连接中…', () => gitApi('/hosted/info'));
        } catch (error) {
            return fail(friendlyError(error), useCloud);
        }
        if (!info.available) return fail(`${esc(cloudLabel)}暂时不能用`);
        if (answers.mode === 'restore') {
            answers.cloudChoices = info.repositories.filter(entry => entry.exists && !entry.empty);
            if (!answers.cloudChoices.length) return fail(`${esc(cloudLabel)}里还没有你的备份`);
            if (answers.cloudChoices.length === 1) return connectCloud(answers.cloudChoices[0].site);
            return show('cloudPick');
        }
        const own = info.repositories.find(entry => entry.site === info.site);
        show(own?.exists && !own.empty ? 'cloudExists' : 'freq');
    };

    /** Restoring from 酒馆云: connect that site's repository and read its branches. */
    const connectCloud = async (site) => {
        try {
            const info = await app.busy('连接中…', async () => {
                const connected = await gitApi('/hosted/connect', site ? { site } : {});
                answers.remote = connected.remote;
                return gitApi('/remote/test', { name: connected.remote });
            });
            if (!info.branches.length) return fail('这份备份是空的');
            answers.branches = info.branches.map(branch => branch.name);
            answers.branch = info.defaultBranch || answers.branches[0];
            show('freq');
        } catch (error) {
            fail(friendlyError(error), () => connectCloud(site));
        }
    };

    /** "How do I get it back": three steps that light up one after another. */
    const howToRestore = () => `
        <div class="git-sync-qs-howto">
            <b>想找回以前的？</b>
            <ol>
                <li><i class="fa-solid fa-clock-rotate-left"></i><span>点<b>历史</b></span></li>
                <li><i class="fa-solid fa-hand-pointer"></i><span>选一条</span></li>
                <li><i class="fa-solid fa-backward"></i><span>点<b>回到这个版本</b></span></li>
            </ol>
        </div>`;

    const doneHtml = (title, text, foot = '') => `
        <div class="git-sync-qs">
            <div class="git-sync-qs-head done">
                <i class="fa-solid fa-circle-check"></i>
                <h2>${title}</h2>
                <p>${text}</p>
            </div>
            ${foot}
        </div>`;

    /** Every few messages → save the open chat; leaving a chat → save everything. */
    const saveAutoSave = async () => {
        await gitApi('/settings', {
            smartCommit: {
                ...(app.state.settings.smartCommit ?? {}),
                onChatSwitch: answers.every > 0,
                everyMessages: answers.every,
                aiMessages: true,
                beforeReroll: true,
                beforeDelete: true,
                // 酒馆云 copies are made by the server after every save.
                push: answers.online && !answers.cloud,
                remote: answers.remote,
            },
        });
        await reloadSmartCommit();
    };

    const draw = () => {
        void screens[current]();
    };
    show(onlineOnly ? 'platform' : 'intro', false);
}

/** Server errors in a few words (the server's own message stays in small print). */
function friendlyError(error) {
    const message = String(error?.message || error || '');
    const detail = `<small>${esc(message)}</small>`;
    if (/^认证失败/.test(message)) return `钥匙不对，重新拿一把${detail}`;
    if (/^没有权限/.test(message)) return `钥匙权限不够，重新拿一把${detail}`;
    if (/^找不到仓库/.test(message)) return `找不到仓库，检查网址${detail}`;
    if (/^无法解析/.test(message)) return `网址不对${detail}`;
    if (/^连接仓库失败/.test(message)) return `连不上，等会儿再试${detail}`;
    if (/^远程仓库有你本地没有/.test(message)) return `仓库不是空的，换一个新的${detail}`;
    return `出错了${detail}`;
}

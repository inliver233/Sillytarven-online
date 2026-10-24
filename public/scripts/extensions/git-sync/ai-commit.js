import { getContext } from '../../extensions.js';
import { gitApi } from './shared.js';

const KIND = { added: '新增', modified: '修改', deleted: '删除', untracked: '停止同步' };

const SYSTEM_PROMPT = [
    '你是 SillyTavern 酒馆的存档助手。根据下面的改动摘要，用简体中文写一条 Git 提交说明。',
    '第一行是标题，不超过 30 个字，像游戏存档名一样概括剧情进展或设定变化（例如“艾琳带旅人闯进钟楼”“调高小猫之神预设的温度”）。',
    '如果改动较多，空一行后用 1 到 3 行“- ”开头的要点补充。',
    '只输出提交说明本身，不要引号、代码块、表情符号或任何解释。',
].join('\n');

/**
 * Turns the server's change digest into lines a model can summarize.
 * @param {{ count: number, items: any[] }} digest
 */
export function describeDigest(digest) {
    return digest.items.map((item) => {
        let line = `- ${KIND[item.kind] ?? '修改'}${item.categoryLabel}「${item.item}」`;
        if (item.messageCount) {
            line += `，新增 ${item.messageCount} 条消息：${item.messages.map(message => `${message.name}：${message.text}`).join(' / ')}`;
        }
        if (item.keys.length) line += `，改动：${item.keys.join('、')}`;
        return line;
    }).join('\n');
}

/** Removes wrapping quotes, code fences and over-long lines from a model's answer. */
function cleanMessage(text) {
    const lines = String(text ?? '')
        .replace(/```[a-z]*\n?|```/gi, '')
        .split('\n')
        .map(line => line.trim().replace(/^["“”'「」]+|["“”'「」]+$/g, ''))
        .filter((line, index, all) => line || (index > 0 && all[index - 1]));
    const title = (lines.shift() ?? '').replace(/^(标题|提交说明)[:：]\s*/, '').slice(0, 60);
    const body = lines.filter(Boolean).slice(0, 4).map(line => line.slice(0, 120));
    return title ? [title, ...(body.length ? ['', ...body] : [])].join('\n') : '';
}

/** Whether the main chat is generating, so a background request would compete with it. */
export function isGenerating() {
    return document.body.dataset.generating === 'true';
}

/**
 * Asks the user's current model for a commit message. Returns '' when it cannot.
 * @param {{ paths?: string[] }} [options]
 */
export async function writeCommitMessage({ paths } = {}) {
    const digest = await gitApi('/digest', paths ? { paths } : {});
    if (!digest.count) return '';
    const context = getContext();
    if (typeof context.generateRaw !== 'function') return '';
    const answer = await context.generateRaw({
        systemPrompt: SYSTEM_PROMPT,
        prompt: `改动摘要（共 ${digest.count} 个文件）：\n${describeDigest(digest)}\n\n提交说明：`,
        responseLength: 200,
    });
    return cleanMessage(answer);
}

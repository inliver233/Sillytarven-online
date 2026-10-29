// 记住用户点过「我知道了」的公告版本：内容没变就不再弹，改了或有新公告再弹。

export const SEEN_ANNOUNCEMENTS_KEY = 'announcements_seen';

/**
 * 公告的版本指纹：id + 标题和正文的哈希（FNV-1a），改了标题或正文就会变。
 * @param {{ id?: string|number, title?: string, content?: string }} announcement
 * @returns {string}
 */
export function announcementFingerprint(announcement) {
    const text = `${announcement.title ?? ''}\n${announcement.content ?? ''}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${announcement.id ?? ''}:${hash.toString(16).padStart(8, '0')}`;
}

/**
 * @param {string|null} stored accountStorage 里存的值
 * @returns {Set<string>}
 */
export function parseSeen(stored) {
    try {
        const list = JSON.parse(stored ?? '[]');
        return new Set(Array.isArray(list) ? list.filter(item => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
}

/**
 * @template {{ id?: string|number, title?: string, content?: string }} T
 * @param {T[]} announcements 当前启用的公告
 * @param {Set<string>} seen
 * @returns {T[]} 还没确认过当前版本的公告
 */
export function unseenAnnouncements(announcements, seen) {
    return announcements.filter(announcement => !seen.has(announcementFingerprint(announcement)));
}

/**
 * 确认看过后要存的值：只保留当前还在的公告，旧版本和已下线的自然丢掉。
 * @param {{ id?: string|number, title?: string, content?: string }[]} current 当前启用的公告
 * @param {Set<string>} seen 之前确认过的
 * @param {{ id?: string|number, title?: string, content?: string }[]} acknowledged 这次确认的
 * @returns {string}
 */
export function serializeSeen(current, seen, acknowledged) {
    const confirmed = new Set([...seen, ...acknowledged.map(announcementFingerprint)]);
    return JSON.stringify(current.map(announcementFingerprint).filter(fingerprint => confirmed.has(fingerprint)));
}

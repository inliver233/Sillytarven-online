// 公告里的占位符（如 {{storage_used}}）在显示时换成这个用户的数值；看没看过仍按原文判断，
// 所以数值变了公告不会重新弹出。数值由服务器随公告一起给（见 src/endpoints/announcements.js）。

/**
 * @param {unknown} text 公告标题或正文
 * @param {Record<string, string>|undefined} variables 这条公告用到的数值
 * @returns {string}
 */
export function fillAnnouncementVariables(text, variables) {
    return String(text ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (placeholder, name) =>
        variables && Object.hasOwn(variables, name) ? String(variables[name]) : placeholder);
}

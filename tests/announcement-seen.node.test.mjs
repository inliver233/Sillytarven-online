import assert from 'node:assert/strict';
import test from 'node:test';

import {
    announcementFingerprint,
    parseSeen,
    serializeSeen,
    unseenAnnouncements,
} from '../public/scripts/announcement-seen.js';

const git = { id: 'a1', title: '新功能：酒馆 Git', content: '内容 v1' };
const update = { id: 'a2', title: '近期更新', content: '读完整聊天' };

test('confirmed announcements stay hidden until their title or content changes', () => {
    const seen = parseSeen(serializeSeen([git, update], new Set(), [git, update]));
    assert.deepEqual(unseenAnnouncements([git, update], seen), []);

    const edited = { ...git, content: '内容 v2' };
    assert.deepEqual(unseenAnnouncements([edited, update], seen), [edited]);
    assert.deepEqual(unseenAnnouncements([{ ...update, title: '近期更新（补充）' }], seen).length, 1);

    const fresh = { id: 'a3', title: '维护通知', content: '今晚维护' };
    assert.deepEqual(unseenAnnouncements([git, update, fresh], seen), [fresh]);
});

test('confirming keeps earlier confirmations and drops announcements that are gone', () => {
    const fresh = { id: 'a3', title: '维护通知', content: '今晚维护' };
    let seen = parseSeen(serializeSeen([git, update], new Set(), [git, update]));
    // 只弹了新的那条，确认后旧的仍算看过
    seen = parseSeen(serializeSeen([git, update, fresh], seen, [fresh]));
    assert.deepEqual(unseenAnnouncements([git, update, fresh], seen), []);
    // 下线的公告不再保存
    seen = parseSeen(serializeSeen([fresh], seen, []));
    assert.deepEqual([...seen], [announcementFingerprint(fresh)]);
});

test('bad stored values are treated as nothing seen', () => {
    assert.equal(parseSeen(null).size, 0);
    assert.equal(parseSeen('not json').size, 0);
    assert.equal(parseSeen('{"a":1}').size, 0);
    assert.deepEqual([...parseSeen('["x", 1, null]')], ['x']);
});

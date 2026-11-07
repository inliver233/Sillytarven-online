import assert from 'node:assert/strict';
import test from 'node:test';

import { fillAnnouncementVariables } from '../public/scripts/announcement-variables.js';
import { announcementFingerprint } from '../public/scripts/announcement-seen.js';

test('announcement placeholders are filled for display only', () => {
    const announcement = { id: 'a', title: '扩容', content: '你现在是 {{storage_used}}/{{ storage_limit }} MB，{{unknown}} 保留', variables: { storage_used: '153', storage_limit: '3048' } };
    assert.equal(fillAnnouncementVariables(announcement.content, announcement.variables), '你现在是 153/3048 MB，{{unknown}} 保留');
    assert.equal(fillAnnouncementVariables(announcement.content, undefined), announcement.content, 'without values the text stays as written');
    assert.equal(fillAnnouncementVariables(undefined, {}), '');
    // The "seen" fingerprint uses the text as written, so changing usage does not show it again.
    assert.equal(announcementFingerprint(announcement), announcementFingerprint({ ...announcement, variables: { storage_used: '999', storage_limit: '3048' } }));
});

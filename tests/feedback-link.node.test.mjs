import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

const secret = 'feedback-link-secret-0123456789';

// Config comes from the environment so the test needs no config.yaml.
process.env.SILLYTAVERN_FEEDBACK_LINKSECRET = '';
process.env.SILLYTAVERN_FEEDBACK_FORMORIGIN = 'https://forms.example/f/report?x=1';
process.env.SILLYTAVERN_FEEDBACK_FORMURL = '';
process.env.SILLYTAVERN_FEEDBACK_SITE = '站点 A（dc.example）';

const { createFeedbackLink, FEEDBACK_LINK_HOURS } = await import('../src/feedback-link.js');

/** The questionnaire's check, written out independently: all params but sig, sorted, form-encoded. */
function questionnaireAccepts(params, key) {
    const search = new URLSearchParams(params);
    const sig = search.get('sig');
    const entries = [...search].filter(([name]) => name !== 'sig').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return sig === createHmac('sha256', key).update(new URLSearchParams(entries).toString()).digest('base64url');
}

test('feedback links need a questionnaire address; without a secret they are not signed', () => {
    assert.equal(createFeedbackLink('alice'), null, 'formOrigin alone gives nothing to sign or open');
    process.env.SILLYTAVERN_FEEDBACK_FORMURL = 'https://forms.example/f/report?x=1#top';
    const unsigned = createFeedbackLink('alice');
    assert.equal(unsigned.params, null);
    assert.equal(unsigned.origin, 'https://forms.example');
    assert.equal(unsigned.url, 'https://forms.example/f/report?site=%E7%AB%99%E7%82%B9+A%EF%BC%88dc.example%EF%BC%89&user=alice');
    process.env.SILLYTAVERN_FEEDBACK_LINKSECRET = secret;
    process.env.SILLYTAVERN_FEEDBACK_FORMURL = 'not a url';
    process.env.SILLYTAVERN_FEEDBACK_FORMORIGIN = 'ftp://forms.example';
    assert.equal(createFeedbackLink('alice'), null);
    process.env.SILLYTAVERN_FEEDBACK_FORMORIGIN = 'https://forms.example/f/report?x=1';
    assert.equal(createFeedbackLink(''), null);
});

test('signed feedback links carry the site, user and expiry the questionnaire verifies', () => {
    process.env.SILLYTAVERN_FEEDBACK_LINKSECRET = secret;
    const now = Date.UTC(2026, 9, 30, 12, 0, 0);
    // The older origin-only setting still signs, but gives the menu no address to open.
    process.env.SILLYTAVERN_FEEDBACK_FORMURL = '';
    assert.equal(createFeedbackLink('alice', now).url, '');
    process.env.SILLYTAVERN_FEEDBACK_FORMURL = 'https://forms.example/f/report';
    const link = createFeedbackLink('alice', now);
    assert.equal(link.origin, 'https://forms.example');
    assert.equal(link.url, `https://forms.example/f/report?${new URLSearchParams(link.params)}`);
    assert.deepEqual(Object.keys(link.params).sort(), ['exp', 'sig', 'site', 'user']);
    assert.equal(link.params.site, '站点 A（dc.example）');
    assert.equal(link.params.user, 'alice');
    assert.equal(Number(link.params.exp), now / 1000 + FEEDBACK_LINK_HOURS * 3600);
    assert.equal(link.expiresAt, Number(link.params.exp) * 1000);

    assert.ok(questionnaireAccepts(link.params, secret));
    assert.ok(!questionnaireAccepts({ ...link.params, user: 'mallory' }, secret), 'changing the user breaks the signature');
    assert.ok(!questionnaireAccepts(link.params, 'another-secret-0123456789'));
    // Parameter order in the URL does not matter.
    const { sig, ...rest } = link.params;
    assert.ok(questionnaireAccepts({ sig, ...Object.fromEntries(Object.entries(rest).reverse()) }, secret));
});

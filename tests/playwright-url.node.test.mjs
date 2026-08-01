/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test -- Node test runner uses assert and restores process state. */
import assert from 'node:assert/strict';
import test from 'node:test';

const originalUrl = process.env.ST_TEST_URL;

test('Playwright and frontend setup use ST_TEST_URL', async () => {
    const expected = 'http://127.0.0.1:8123';
    process.env.ST_TEST_URL = expected;
    try {
        const config = (await import(`./playwright.config.js?test=${Date.now()}`)).default;
        const { testSetup } = await import(`./frontend/frontent-test-utils.js?test=${Date.now()}`);
        assert.equal(config.use.baseURL, expected);
        assert.equal(testSetup.testUrl, expected);
    } finally {
        if (originalUrl === undefined) {
            delete process.env.ST_TEST_URL;
        } else {
            process.env.ST_TEST_URL = originalUrl;
        }
    }
});

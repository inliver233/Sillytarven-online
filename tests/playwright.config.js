import { defineConfig } from '@playwright/test';

const testUrl = process.env.ST_TEST_URL || 'http://127.0.0.1:8000';

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL: testUrl,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: process.env.ST_TEST_URL ? 1 : 4,
    fullyParallel: true,
});

export const testSetup = {
    testUrl: process.env.ST_TEST_URL || 'http://127.0.0.1:8000',
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for the preloader to disappear.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');
        const loginLink = page.locator('a[href="/login"]');
        if (await loginLink.count()) {
            await page.goto('/login');
        }

        if (new URL(page.url()).pathname === '/login') {
            const userSelector = page.locator('#userList .userSelect:last-child');
            const handleInput = page.locator('#userHandle:visible');
            await userSelector.or(handleInput).first().waitFor({ state: 'visible' });
            if (await handleInput.count()) {
                await handleInput.fill(process.env.ST_TEST_USER || 'default-user');
                await page.locator('#userPassword').fill(process.env.ST_TEST_PASSWORD || '');
                await page.locator('#loginButton').click();
            } else {
                await userSelector.click();
            }
            await page.waitForURL(new URL('/', testSetup.testUrl).href);
        }

        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await page.waitForFunction('globalThis.SillyTavern?.getContext', { timeout: 0 });
    },
};

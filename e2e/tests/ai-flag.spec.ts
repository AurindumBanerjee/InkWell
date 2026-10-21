import { expect, test } from '@playwright/test';
import { createDoc, open, uniqueSuffix, userContext } from './helpers.js';

/**
 * One spec, two builds: E2E_AI=true runs the AI version, anything else the normal one.
 * CI runs the whole e2e suite in both modes.
 */
const AI = process.env.E2E_AI === 'true';

test.describe(AI ? 'AI version' : 'normal version', () => {
  test(
    AI ? 'shows the AI panel and talks to the AI routes' : 'has no AI UI, routes or code',
    async ({ browser }) => {
      const ctx = await userContext(browser, `flag-${uniqueSuffix()}@example.com`);
      const docId = await createDoc(ctx);
      const page = await open(ctx, docId);
      const status = await ctx.request.get('/api/ai/status');

      if (AI) {
        await page.getByTestId('open-ai').click();
        await expect(page.getByTestId('inkwell-ai-collaborator-ui')).toBeVisible();
        await expect(page.getByTestId('ai-status')).toContainText('No model is configured');
        expect(status.status()).toBe(200);
      } else {
        await expect(page.getByTestId('open-ai')).toHaveCount(0);
        expect(status.status()).toBe(404);

        // Not merely hidden: the AI code was never shipped to the browser.
        const scripts = await page.evaluate(() =>
          Array.from(document.scripts)
            .map((s) => s.src)
            .filter(Boolean),
        );
        for (const src of scripts) {
          const body = await (await ctx.request.get(src)).text();
          expect(body, src).not.toContain('inkwell-ai-collaborator-ui');
        }
      }
      await ctx.close();
    },
  );
});

import { expect, test, type BrowserContext } from '@playwright/test';
import { BASE, createDoc, docText, open, share, type, userContext } from './helpers.js';

test.describe('collaboration', () => {
  let ownerCtx: BrowserContext, bobCtx: BrowserContext;
  let docId: string;

  test.beforeEach(async ({ browser }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    ownerCtx = await userContext(browser, `alice-${suffix}@example.com`);
    bobCtx = await userContext(browser, `bob-${suffix}@example.com`);
    docId = await createDoc(ownerCtx);
    await share(ownerCtx, docId, `bob-${suffix}@example.com`, 'editor');
  });

  test.afterEach(async () => {
    await ownerCtx.close();
    await bobCtx.close();
  });

  test('two users typing at the same time converge to identical text', async () => {
    const a = await open(ownerCtx, docId);
    const b = await open(bobCtx, docId);

    // Both type into the same empty document simultaneously, so edits genuinely interleave.
    const textA = 'Alpha writes this sentence. ';
    const textB = 'Bravo writes something else. ';
    await Promise.all([(async () => type(a, textA))(), (async () => type(b, textB))()]);

    await expect
      .poll(async () => {
        const [ta, tb] = await Promise.all([docText(a), docText(b)]);
        return ta === tb && ta.length === textA.length + textB.length;
      })
      .toBe(true);

    // Nothing lost: every character typed by each user is still present, in the order typed.
    const final = await docText(a);
    const subsequence = (s: string, sub: string) => {
      let i = 0;
      for (const ch of s) if (ch === sub[i]) i++;
      return i === sub.length;
    };
    expect(subsequence(final, textA)).toBe(true);
    expect(subsequence(final, textB)).toBe(true);
  });

  test('shows the other user as present, with a remote cursor', async () => {
    const a = await open(ownerCtx, docId);
    const b = await open(bobCtx, docId);
    await type(b, 'hi');
    await expect(a.getByTestId('peer')).toHaveCount(2);
    await expect(b.getByTestId('peer')).toHaveCount(2);
    await expect(a.locator('.cm-ySelectionCaret')).toHaveCount(1);

    await b.close();
    await expect(a.getByTestId('peer')).toHaveCount(1);
  });

  test('offline edits merge on reconnect without losing either side', async () => {
    const a = await open(ownerCtx, docId);
    const b = await open(bobCtx, docId);
    await type(a, 'base. ');
    await expect.poll(() => docText(b)).toBe('base. ');

    await a.evaluate(() => window.__inkwell.goOffline());
    await expect(a.getByTestId('status')).toHaveAttribute('data-status', 'offline');

    await type(a, 'A-offline ');
    await type(b, 'B-online ');
    await expect.poll(() => docText(b)).toContain('B-online');
    expect(await docText(a)).not.toContain('B-online'); // genuinely diverged

    await a.evaluate(() => window.__inkwell.goOnline());
    await expect(a.getByTestId('status')).toHaveAttribute('data-status', 'online');

    await expect
      .poll(async () => {
        const [ta, tb] = await Promise.all([docText(a), docText(b)]);
        return ta === tb && ta.includes('A-offline') && ta.includes('B-online');
      })
      .toBe(true);
  });

  test('viewers see live edits but cannot write', async ({ browser }) => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `carol-${suffix}@example.com`;
    const carolCtx = await userContext(browser, email);
    await share(ownerCtx, docId, email, 'viewer');

    const a = await open(ownerCtx, docId);
    const c = await open(carolCtx, docId);
    await expect(c.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');

    await type(a, 'visible to all');
    await expect.poll(() => docText(c)).toBe('visible to all');

    // The read-only editor ignores typing, and nothing reaches the other collaborators.
    await c.locator('.cm-content').click({ force: true });
    await c.keyboard.type('HACK', { delay: 10 });
    await c.waitForTimeout(500);
    expect(await docText(a)).toBe('visible to all');
    expect(await docText(c)).toBe('visible to all');
    await carolCtx.close();
  });

  test('content persists after everyone leaves', async ({ browser }) => {
    const a = await open(ownerCtx, docId);
    await type(a, 'durable text');
    await expect.poll(() => docText(a)).toBe('durable text');
    await a.waitForTimeout(500); // allow the debounced flush
    await a.close();

    const fresh = await browser.newContext({ baseURL: BASE });
    // Same session, new browser profile: nothing in IndexedDB, so this reads from the server.
    await fresh.addCookies(await ownerCtx.cookies());
    const page = await open(fresh, docId);
    await expect.poll(() => docText(page)).toBe('durable text');
    await fresh.close();
  });

  test('users without access are turned away', async ({ browser }) => {
    const eveCtx = await userContext(
      browser,
      `eve-${Math.random().toString(36).slice(2, 8)}@example.com`,
    );
    const page = await eveCtx.newPage();
    await page.goto(`/doc/${docId}`);
    await expect(page.locator('.error')).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveCount(0);
    await eveCtx.close();
  });
});

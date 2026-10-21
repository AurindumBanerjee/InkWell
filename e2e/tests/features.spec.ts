import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createDoc, docText, open, share, type, uniqueSuffix, userContext } from './helpers.js';

test.describe('comments and history', () => {
  let aliceCtx: BrowserContext, bobCtx: BrowserContext;
  let docId: string;

  test.beforeEach(async ({ browser }) => {
    const s = uniqueSuffix();
    aliceCtx = await userContext(browser, `alice-${s}@example.com`);
    bobCtx = await userContext(browser, `bob-${s}@example.com`);
    docId = await createDoc(aliceCtx);
    await share(aliceCtx, docId, `bob-${s}@example.com`, 'editor');
  });
  test.afterEach(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  /** Select the word "quick" in "The quick brown fox" with the keyboard. */
  async function selectQuick(page: Page) {
    await page.locator('.cm-content').click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  }

  test('a comment on selected text appears live for others, follows edits, and can be resolved', async () => {
    const a = await open(aliceCtx, docId);
    const b = await open(bobCtx, docId);
    await type(a, 'The quick brown fox');
    await expect.poll(() => docText(b)).toBe('The quick brown fox');

    // Alice comments on the selected word.
    await selectQuick(a);
    await a.getByTestId('open-comments').click();
    await expect(a.getByTestId('comment-target')).toContainText('quick');
    await a.getByTestId('comment-input').fill('Is "quick" the right word?');
    await a.getByTestId('comment-submit').click();

    // Bob sees the highlight and the comment without reloading anything.
    await expect(b.locator('.cm-comment')).toHaveText('quick');
    await b.getByTestId('open-comments').click();
    await expect(b.getByTestId('thread')).toHaveCount(1);
    await expect(b.getByTestId('comment-body').first()).toHaveText('Is "quick" the right word?');

    // The anchor follows the text when someone edits before it.
    await type(a, ' '); // keep focus in the editor
    await a.keyboard.press('Control+Home');
    await a.keyboard.type('Hey! ');
    await expect.poll(() => docText(b)).toContain('Hey! The quick brown fox');
    await expect(b.locator('.cm-comment')).toHaveText('quick');

    // Bob replies; Alice sees it live.
    await b.getByTestId('reply-input').fill('Maybe "fast"?');
    await b.getByTestId('reply-submit').click();
    await expect(a.getByTestId('reply')).toHaveCount(1);
    await expect(a.getByTestId('reply').getByTestId('comment-body')).toHaveText('Maybe "fast"?');

    // Resolving removes the highlight for everyone and drops the open-thread count.
    await a.getByTestId('resolve').click();
    await expect(b.locator('.cm-comment')).toHaveCount(0);
    await expect(b.getByTestId('open-comments')).toHaveText('Comments');
  });

  test('a read-only viewer can comment but not edit', async ({ browser }) => {
    const s = uniqueSuffix();
    const carolCtx = await userContext(browser, `carol-${s}@example.com`);
    await share(aliceCtx, docId, `carol-${s}@example.com`, 'viewer');
    const a = await open(aliceCtx, docId);
    const c = await open(carolCtx, docId);
    await type(a, 'Review me');
    await expect.poll(() => docText(c)).toBe('Review me');

    await c.getByTestId('open-comments').click();
    await c.getByTestId('comment-input').fill('Looks fine');
    await c.getByTestId('comment-submit').click();
    await expect(a.getByTestId('open-comments')).toHaveText('Comments (1)');
    await expect(c.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
    await carolCtx.close();
  });

  test('saved versions can be restored into the live document for everyone', async () => {
    const a = await open(aliceCtx, docId);
    const b = await open(bobCtx, docId);
    a.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? 'first draft' : undefined));

    await type(a, 'Draft one.');
    await expect.poll(() => docText(b)).toBe('Draft one.');

    await a.getByTestId('open-history').click();
    await a.getByRole('button', { name: 'Save version' }).click();
    await expect(a.getByTestId('history').getByText('first draft')).toBeVisible();

    await type(a, ' Oops, a mistake.');
    await expect.poll(() => docText(b)).toBe('Draft one. Oops, a mistake.');

    await a.getByTestId('history').getByText('first draft').click();
    await expect(a.getByTestId('version-text')).toHaveText('Draft one.');
    await a.getByRole('button', { name: 'Restore this version' }).click();

    await expect.poll(() => docText(a)).toBe('Draft one.');
    await expect.poll(() => docText(b)).toBe('Draft one.');
    // The replaced text is kept in history, so the restore is itself undoable.
    await expect(a.getByTestId('history').getByText('Before restore')).toBeVisible();
  });
});

test.describe('search', () => {
  test('finds a document from the dashboard with the match highlighted, and hides it from others', async ({
    browser,
  }) => {
    const s = uniqueSuffix();
    const aliceCtx = await userContext(browser, `alice-${s}@example.com`);
    const eveCtx = await userContext(browser, `eve-${s}@example.com`);
    const docId = await createDoc(aliceCtx);
    const word = `zq${s}`; // a token no other document contains

    const doc = await open(aliceCtx, docId);
    await type(doc, `Notes about the ${word} migration plan`);
    await expect.poll(() => docText(doc)).toContain(word);
    await doc.close(); // the room closes and the final text is indexed immediately

    const home = await aliceCtx.newPage();
    await home.goto('/');
    await home.getByTestId('search-input').fill(word);
    const results = home.getByTestId('search-results');
    await expect(results.locator('li a')).toHaveCount(1);
    await expect(results.locator('mark')).toHaveText(word);
    await results.locator('li a').click();
    await expect(home).toHaveURL(new RegExp(`/doc/${docId}$`));

    // Someone with no access to the document searches for the same word.
    const evePage = await eveCtx.newPage();
    await evePage.goto('/');
    await evePage.getByTestId('search-input').fill(word);
    await expect(evePage.getByTestId('search-results')).toContainText('No matches.');

    await aliceCtx.close();
    await eveCtx.close();
  });
});

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const BASE = 'http://localhost:3100';

interface Inkwell {
  goOffline(): void;
  goOnline(): void;
  text(): string;
}
declare global {
  interface Window {
    __inkwell: Inkwell;
  }
}

export async function userContext(browser: Browser, email: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE });
  const res = await ctx.request.post('/api/auth/dev-login', { data: { email } });
  expect(res.ok()).toBeTruthy();
  return ctx;
}

export async function createDoc(ctx: BrowserContext): Promise<string> {
  const ws = (await (await ctx.request.get('/api/workspaces')).json()).workspaces[0].id;
  const res = await ctx.request.post(`/api/workspaces/${ws}/documents`, { data: { title: 'E2E' } });
  return (await res.json()).document.id;
}

export async function share(ctx: BrowserContext, docId: string, email: string, role: string) {
  const res = await ctx.request.put(`/api/documents/${docId}/shares`, { data: { email, role } });
  expect(res.ok()).toBeTruthy();
}

export async function open(ctx: BrowserContext, docId: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`/doc/${docId}`);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'online');
  return page;
}

export const docText = (page: Page) => page.evaluate(() => window.__inkwell.text());

export const type = async (page: Page, text: string, delay = 15) => {
  await page.locator('.cm-content').click();
  await page.keyboard.type(text, { delay });
};

export const uniqueSuffix = () => Math.random().toString(36).slice(2, 8);

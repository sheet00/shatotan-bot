import type { Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './browser.js';

export class PageLog {
  readonly directory: string;
  private sequence = 0;
  constructor(name: string) {
    this.directory = join(dataDir, 'log', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}-${name}`);
  }

  async capture(page: Page, label: string) {
    await mkdir(this.directory, { recursive: true });
    if (page.url() === 'about:blank' && await page.locator('body').evaluate(body => body.childElementCount === 0)) return;
    // Password screens are recorded before entering the password, never while filled.
    const filledLoginInput = await page.locator('input[type="password"]').evaluateAll(inputs =>
      inputs.some(input => !input.hasAttribute('inert') && input.getClientRects().length > 0
        && getComputedStyle(input).visibility !== 'hidden' && getComputedStyle(input).opacity !== '0'
        && (input as HTMLInputElement).value !== '')
    );
    if (filledLoginInput) return;
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    await page.waitForLoadState('load', { timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    const base = join(this.directory, `${String(++this.sequence).padStart(3, '0')}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    await writeFile(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png`, animations: 'disabled' });
    return base;
  }

  async input<T>(page: Page, label: string, action: () => Promise<T>): Promise<T> {
    await this.capture(page, `${label}-before`);
    return action();
  }

  async step<T>(page: Page, label: string, action: () => Promise<T>): Promise<T> {
    await this.capture(page, `${label}-before`);
    let result: T;
    try {
      result = await action();
    } catch (error) {
      await this.capture(page, `${label}-failed`).catch(() => {});
      throw error;
    }
    await this.capture(page, `${label}-after`);
    return result;
  }
}

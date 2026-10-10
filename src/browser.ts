import { chromium } from 'playwright';
import type { Browser, BrowserContextOptions } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

try {
  process.loadEnvFile('.env');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

export const dataDir = process.env.DATA_DIR ?? './data';
export const authFile = join(dataDir, 'x-auth.json');
export async function createContext(browser: Browser, options: BrowserContextOptions = {}) {
  const context = await browser.newContext(options);
  // The notifications stream never completes and prevents networkidle.
  await context.route('https://api.x.com/live_pipeline/events*', route => route.abort());
  return context;
}
export async function openBrowser(headless = false) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let displayProcess: ReturnType<typeof spawn> | undefined;
  let display = process.env.DISPLAY;
  if (!headless && !display) {
    const number = 100 + process.pid % 10_000;
    display = `:${number}`;
    displayProcess = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    let displayError: Error | undefined;
    displayProcess.on('error', error => { displayError = error; });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (displayError || displayProcess.exitCode !== null) break;
      ready = await access(`/tmp/.X11-unix/X${number}`).then(() => true, () => false);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) {
      displayProcess.kill();
      throw new Error('仮想ディスプレイを起動できませんでした。');
    }
  }
  try {
    const browser = await chromium.launch({ headless, env: { ...process.env, ...(display ? { DISPLAY: display } : {}) } });
    browser.on('disconnected', () => displayProcess?.kill());
    return browser;
  } catch (error) {
    displayProcess?.kill();
    throw error;
  }
}

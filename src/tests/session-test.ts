import { chmod } from 'node:fs/promises';
import { authFile, createContext, openBrowser } from '../browser.js';
import { PageLog } from '../pw-log.js';

const browser = await openBrowser();
const log = new PageLog('session-test');
try {
  const context = await createContext(browser, { storageState: authFile, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await log.step(page, 'open-home', () => page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }));
    const switcher = page.getByTestId('SideNav_AccountSwitcher_Button');
    await log.step(page, 'wait-account', () => switcher.waitFor({ timeout: 30_000 }));
    const account = await switcher.innerText();
    console.log(`ログイン中のアカウント: ${account.replaceAll('\n', ' ')}`);
    if (!account.includes('@shaat00')) {
      await log.step(page, 'open-account-menu', () => switcher.click());
      console.log(`アカウントメニュー: ${(await page.locator('body').innerText()).slice(-1800)}`);
      throw new Error('対象アカウント shaat00 の確認が必要です。');
    }
    await context.storageState({ path: authFile, indexedDB: true });
    await chmod(authFile, 0o600);
    await log.capture(page, 'verified');
    console.log('shaat00 のログイン状態を確認しました（未投稿）。');
  } catch (error) {
    await log.capture(page, 'failure');
    throw error;
  }
} finally {
  console.log(`解析ログ: ${log.directory}`);
  await browser.close();
}

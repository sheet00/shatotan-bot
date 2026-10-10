import { access } from 'node:fs/promises';
import { authFile, createContext, openBrowser } from './browser.js';
import { PageLog } from './pw-log.js';

export async function postToX(text: string): Promise<string> {
  await access(authFile).catch(() => { throw new Error('Xのログイン状態がありません。npm run login を実行してください。'); });
  const browser = await openBrowser(true);
  const log = new PageLog('news-post');
  try {
    const context = await createContext(browser, { storageState: authFile });
    const page = await context.newPage();
    await log.step(page, 'open-compose', () => page.goto('https://x.com/compose/post', { timeout: 30_000 }));
    const composer = page.getByRole('dialog').filter({ visible: true });
    const editor = composer.getByTestId('tweetTextarea_0');
    await editor.waitFor({ timeout: 30_000 });
    await log.step(page, 'input-post', () => editor.fill(text));
    const response = await log.step(page, 'send-post', async () => {
      const [response] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'POST' && /\/graphql\/[^/]+\/CreateTweet(?:\?|$)/.test(r.url()), { timeout: 30_000 }),
        composer.getByTestId('tweetButton').click({ timeout: 30_000 }),
      ]);
      return response;
    });
    const body = await response.json();
    const result = body?.data?.create_tweet?.tweet_results?.result;
    if (!response.ok() || body.errors?.length || !result?.rest_id) throw new Error('Xへの投稿成功を確認できません。再送信はしません。');
    return `https://x.com/i/status/${result.rest_id}`;
  } finally { console.log(`投稿ログ: ${log.directory}`); await browser.close(); }
}

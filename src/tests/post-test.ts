import { access } from "node:fs/promises";
import { authFile, createContext, openBrowser } from "../browser.js";
import { PageLog } from "../pw-log.js";
import type { Request } from "playwright";

const text = "テストだよ☆";
const send = process.argv.includes("--send");
await access(authFile).catch(() => {
  throw new Error(
    "ログイン状態がありません。先に npm run login を実行してください。",
  );
});
const browser = await openBrowser();
const log = new PageLog('post-test');
const pending = new Map<Request, { type: string; url: string }>();
try {
  const context = await createContext(browser, { storageState: authFile });
  const page = await context.newPage();
  page.on('request', request => pending.set(request, { type: request.resourceType(), url: new URL(request.url()).origin + new URL(request.url()).pathname }));
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => pending.delete(request));
  await log.step(page, 'open-compose', () => page.goto("https://x.com/compose/post"));
  const composer = page.getByRole("dialog").filter({ visible: true });
  const editor = composer.getByTestId("tweetTextarea_0");
  await log.step(page, 'wait-editor', () => editor.waitFor({ timeout: 30_000 }));
  await log.step(page, 'input-post', () => editor.fill(text));
  if (!send) {
    await log.capture(page, 'preview');
    console.log(`入力確認のみ（未投稿）: ${text}`);
  } else {
    // Response monitoring begins before clicking. Never retry an uncertain submission.
    const response = await log.step(page, 'send-post', async () => {
    const [response] = await Promise.all([page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/graphql\/[^/]+\/CreateTweet(?:\?|$)/.test(response.url()),
      { timeout: 30_000 },
    ), composer.getByTestId("tweetButton").click()]);
    return response;
    });
    const body = await response.json();
    const result = body?.data?.create_tweet?.tweet_results?.result;
    if (!response.ok() || body.errors?.length || !result?.rest_id) {
      throw new Error(
        "投稿成功を確認できません。Xの画面で確認してください。再試行はしません。",
      );
    }
    console.log(`投稿成功: https://x.com/i/status/${result.rest_id}`);
  }
} catch (error) {
  console.error('未完了の通信:', [...pending.values()]);
  console.error(
    send ? "処理を停止しました。送信操作後の失敗では、再実行前にXで投稿の有無を確認してください。" : "投稿画面の入力確認に失敗しました（未投稿）。",
  );
  throw error;
} finally {
  console.log(`解析ログ: ${log.directory}`);
  await browser.close();
}

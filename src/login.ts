import { access, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { authFile, createContext, openBrowser } from "./browser.js";
import { PageLog } from "./pw-log.js";

const identifier = process.env.X_LOGIN_ID;
const password = process.env.X_PASSWORD;
const username = process.env.X_USERNAME;
if (!identifier || !password) throw new Error("ログイン用の環境変数が未設定です。");
const log = new PageLog("login");
const browser = await openBrowser();
let page: Page | undefined;
let stage = "open";
const network: { stage: string; url: string; status?: number; error?: string; signals?: string[]; submittedUsername?: boolean }[] = [];
const pendingResponses: Promise<void>[] = [];
const scripts = new Set<string>();
let serverError: string | undefined;

async function signature(page: Page) {
  return page.evaluate(() => JSON.stringify({
    path: location.pathname,
    errors: document.body.innerText.match(/incorrect answer provided|temporarily limited|try again later|too many attempts|something went wrong|could not log|couldn't log|incorrect password|wrong password|一時的に制限|問題が発生|認証コード|verification code/gi) ?? [],
    inputs: [...document.querySelectorAll<HTMLInputElement>('input:not([inert])')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).opacity !== "0")
      .map(el => [el.name, el.type]),
  }));
}

async function transition(page: Page, label: string, action: () => Promise<void>) {
  const before = await signature(page);
  await log.step(page, label, action);
  await log.step(page, `${label}-transition`, async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (serverError) throw new Error(serverError);
      const next = await signature(page);
      const state = JSON.parse(next);
      if (next !== before && (state.inputs.length || state.errors.length || state.path !== JSON.parse(before).path)) {
        await page.waitForTimeout(500);
        if (await signature(page) === next) return;
      }
      await page.waitForTimeout(250);
    }
    throw new Error("画面が更新されませんでした。");
  });
}

async function submit(page: Page, label: string) {
  await transition(page, label, async () => {
    const pattern = /^(Continue|Next|次へ|続ける|Log in|Login|ログイン|Confirm|確認)$/;
    const button = page.getByRole("button", { name: pattern }).filter({ visible: true });
    if (await button.count()) await button.first().click();
    else await page.getByText(pattern).filter({ visible: true }).first().click();
  });
}

try {
  const storageState = await access(authFile).then(() => authFile, () => undefined);
  const context = await createContext(browser, { viewport: { width: 1280, height: 800 }, storageState });
  page = await context.newPage();
  page.on("response", response => {
    if (response.request().resourceType() === "script") scripts.add(response.url());
    if (["fetch", "xhr"].includes(response.request().resourceType())) network.push({ stage, url: new URL(response.url()).pathname, status: response.status() });
    if (response.url().includes("/onboarding/web/actions/")) {
      const currentStage = stage;
      pendingResponses.push((async () => {
        const body = (await response.body()).toString("utf8");
        if (/temporarily limited|too many attempts|try again later/i.test(body)) serverError = "Xからログイン制限が返されました。";
        else if (body.includes("Sorry, you are not allowed to log in at this time.")) serverError = "Xから Sorry, you are not allowed to log in at this time. が返されました。";
        if (currentStage === "identifier-check") await writeFile(join(log.directory, "identifier-check-response.bin"), await response.body());
        network.push({ stage: currentStage, url: new URL(response.url()).pathname,
          submittedUsername: username ? response.request().postDataBuffer()?.includes(Buffer.from(username)) : undefined,
          signals: ["password", "login_enter_password", "knowledge_check", "Incorrect answer provided", "temporarily limited", "login_success", "verification"].filter(value => body.includes(value)) });
      })().catch(error => { network.push({ stage: currentStage, url: "response-body", error: String(error) }); }));
    }
  });
  page.on("requestfailed", request => network.push({ stage, url: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  page.on("pageerror", error => network.push({ stage, url: "page", error: error.message }));
  await log.step(page, "open", async () => {
    const response = await page!.goto(storageState ? "https://x.com/home" : "https://x.com/i/flow/login", { waitUntil: "domcontentloaded" });
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    await page!.waitForFunction(() => location.pathname === "/home" || [...document.querySelectorAll('input[autocomplete~="username"]')].some(input => input.getClientRects().length > 0), undefined, { timeout: 30_000 });
  });
  const deadline = Date.now() + 120_000;
  const submitted = new Set<string>();
  let done = false;
  let passwordChosen = false;
  for (let attempt = 0; attempt < 12 && Date.now() < deadline; attempt++) {
    stage = `screen-${attempt}`;
    await log.capture(page, stage);
    const body = await page.locator("body").innerText();
    const cookies = await context.cookies("https://x.com");
    if (cookies.some(cookie => cookie.name === "auth_token" && cookie.value) && new URL(page.url()).pathname === "/home") {
      await context.storageState({ path: authFile });
      await chmod(authFile, 0o600);
      done = true;
      break;
    }
    if (/temporarily limited|try again later|too many attempts|一時的に制限|しばらくしてから/i.test(body)) throw new Error("Xからログイン制限が表示されました。");
    if (/something went wrong|could not log|couldn't log|問題が発生|ログインできません/i.test(body)) throw new Error("Xの画面にエラーが表示されました。");
    if (/incorrect answer provided/i.test(body)) throw new Error("ユーザー名確認で Incorrect answer provided が返されました。");

    const passwordInput = page.locator('input[name="password"]:not([inert]):visible');
    const usePassword = page.getByText(/^(Use password|Use a password|Use your password|パスワードを使う|パスワードを使用)$/).filter({ visible: true });
    const challenge = page.locator('input[name="challenge_response"]:not([inert]):visible, input[data-testid="ocfEnterTextTextInput"]:not([inert]):visible');
    const idInput = page.locator('input[autocomplete~="username"]:not([inert]):visible');
    if (!await usePassword.count() && !await passwordInput.count()
      && /verification code|authentication code|verify your identity|認証コード|確認コード|本人確認|captcha/i.test(body)) {
      throw new Error("追加認証が必要です。");
    }
    const screen = await signature(page);
    if (submitted.has(screen)) throw new Error("同じ画面への再送信を止めました。");

    if (await passwordInput.count()) {
      stage = "password";
      submitted.add(screen);
      await log.input(page, "password-input", () => passwordInput.fill(password));
      await submit(page, "password-submit");
    } else if (!passwordChosen && await usePassword.count()) {
      stage = "choose-password";
      await log.step(page, stage, async () => {
        const [response] = await Promise.all([
          page!.waitForResponse(response => response.url().includes("/onboarding/web/actions/begin_login") && response.request().method() === "POST", { timeout: 30_000 }),
          page!.getByRole("button", { name: /^(Use password|Use a password|Use your password|パスワードを使う|パスワードを使用)$/ }).filter({ visible: true }).first().click(),
        ]);
        await response.finished();
        await Promise.all(pendingResponses);
        await page!.waitForTimeout(500);
      });
      passwordChosen = true;
      if (serverError) throw new Error(serverError);
    } else if (await challenge.count()) {
      stage = "identifier-check";
      const answer = /username|ユーザー名/i.test(body) ? username
        : /email|メール/i.test(body) && identifier.includes("@") ? identifier : undefined;
      if (!answer) throw new Error("追加の識別情報が必要です。");
      submitted.add(screen);
      await log.input(page, "identifier-check-input", () => challenge.first().fill(answer));
      await submit(page, "identifier-check-submit");
    } else if (await idInput.count()) {
      stage = "identifier";
      submitted.add(screen);
      await log.input(page, "identifier-input", async () => {
        await idInput.fill(identifier);
        await idInput.press("Tab");
      });
      await submit(page, "identifier-submit");
    } else {
      await log.step(page, "wait-screen", () => page!.waitForTimeout(1000));
    }
  }
  if (!done) throw new Error("ログイン完了を確認できませんでした。");
  await log.capture(page, "success");
  console.log("ログイン成功。状態を保存しました。");
} catch (error) {
  if (page) await log.capture(page, "failure");
  const reason = error instanceof Error ? error.message.split("\n")[0] : "Unknown error";
  console.error(`ログイン失敗（${stage}）: ${reason}`);
  process.exitCode = 1;
} finally {
  await Promise.all(pendingResponses);
  await writeFile(join(log.directory, "network.json"), JSON.stringify({ network, scripts: [...scripts] }, null, 2));
  console.log(`解析ログ: ${log.directory}`);
  await browser.close();
}

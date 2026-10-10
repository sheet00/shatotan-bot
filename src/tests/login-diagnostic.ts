import { openBrowser } from '../browser.js';
import { PageLog } from '../pw-log.js';

// Use a fresh, anonymous context. Do not enter credentials or load saved sessions.
const headed = process.argv.includes('--headed');
const browser = await openBrowser(!headed);
const log = new PageLog(`login-diagnostic-${headed ? 'headed' : 'headless'}`);
try {
  const page = await browser.newPage();
  const failures: { resource: string; error: string | null }[] = [];
  const errors: { resource: string; status: number }[] = [];
  const scripts: string[] = [];
  const resource = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  };
  page.on('requestfailed', request => failures.push({
    resource: resource(request.url()), error: request.failure()?.errorText ?? null,
  }));
  page.on('response', response => {
    if (response.status() >= 400) errors.push({ resource: resource(response.url()), status: response.status() });
    if (response.request().resourceType() === 'script') scripts.push(resource(response.url()));
  });
  page.on('pageerror', error => console.log('Page error:', error.name, error.message.slice(0, 300)));
  const response = await log.step(page, 'open', () => page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30_000 }));
  await log.step(page, 'wait-render', () => page.waitForTimeout(5_000));
  const label = headed ? 'headed' : 'headless';
  await log.capture(page, 'result');
  console.log(JSON.stringify({
    mode: label, status: response?.status(), title: await page.title(),
    bodyLength: (await page.locator('body').innerText()).length,
    text: (await page.locator('body').innerText()).slice(0, 1500),
    inputCount: await page.locator('input').count(), scripts: scripts.length, failures, errors,
    inputs: await page.locator('input').evaluateAll(elements => elements.map(el => ({ name: el.getAttribute('name'), type: el.getAttribute('type'), autocomplete: el.getAttribute('autocomplete'), testid: el.getAttribute('data-testid'), placeholder: el.getAttribute('placeholder') }))),
    buttons: await page.getByRole('button').allTextContents(),
  }, null, 2));
} finally {
  await browser.close();
  console.log(`解析ログ: ${log.directory}`);
}

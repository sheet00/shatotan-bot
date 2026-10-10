import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { openBrowser } from '../browser.js';
import { PageLog } from '../pw-log.js';

const secret = 'fake-sensitive-value';
const log = new PageLog('log-test');
const browser = await openBrowser(true);
try {
  const page = await browser.newPage();
  await page.setContent(`<input value="${secret}"><p>${secret}</p><script type="application/json">{"session_token":"fake-session"}</script>`);
  const base = await log.capture(page, 'raw');
  assert(base);
  const html = await readFile(`${base}.html`, 'utf8');
  assert(html.includes(secret));
  assert(html.includes('fake-session'));
  assert.equal(await page.locator('input').inputValue(), secret, 'Logging must preserve live input');
  assert((await stat(`${base}.png`)).size > 0);
  await assert.rejects(log.step(page, 'failure-case', async () => {
    throw new Error('expected test failure');
  }), /expected test failure/);
  const names = await readdir(log.directory);
  assert(names.some(name => name.endsWith('failure-case-before.html')));
  assert(names.some(name => name.endsWith('failure-case-failed.html')));
  assert(names.some(name => name.endsWith('failure-case-failed.png')));
  await page.setContent('<input type="password">');
  await log.input(page, 'password-input', () => page.locator('input').fill(secret));
  await log.capture(page, 'password-filled');
  const inputNames = await readdir(log.directory);
  assert(inputNames.some(name => name.endsWith('password-input-before.html')));
  assert(inputNames.some(name => name.endsWith('password-input-before.png')));
  assert(!inputNames.some(name => name.includes('password-input-after') || name.includes('password-filled')));
  await page.setContent(`<input inert type="password" value="${secret}" style="opacity:0"><p>Next screen</p>`);
  assert(await log.capture(page, 'next-screen'), 'Hidden password fields must not prevent recording the next screen');
  let release!: () => void;
  let started!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  await page.route('https://fixture.invalid/slow', async route => {
    started();
    await responseGate;
    await route.fulfill({ body: 'Loaded', headers: { 'access-control-allow-origin': '*' } });
  });
  await page.setContent('<p id="status">Loading</p><script>fetch("https://fixture.invalid/slow").then(r=>r.text()).then(text=>document.getElementById("status").textContent=text)</script>', { waitUntil: 'domcontentloaded' });
  await requestStarted;
  const capture = log.capture(page, 'network-ready');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(!(await readdir(log.directory)).some(name => name.includes('network-ready')), 'Must not save while a request is pending');
  release();
  const readyBase = await capture;
  assert(readyBase);
  assert((await readFile(`${readyBase}.html`, 'utf8')).includes('<p id="status">Loaded</p>'));
  console.log('無加工のログ保存・入力前のみの保存・失敗時の保存 OK');
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { generate, validateDraft, type Article } from '../ai.js';
import { extractBody, normalizeUrl, createNews } from '../news.js';
import { State } from '../state.js';
import type { Config } from '../config.js';

const paragraph = '街の食堂が来週から旬の野菜を使った定食を提供する。地元の農家と協力して、毎日届く野菜に合わせて献立を変える。価格は千円で、昼の時間帯に数量限定で販売する。';
const article: Article = { title: '食堂の新しい定食', url: 'https://example.com/article', rssUrl: 'https://news.google.com/rss/articles/example', publishedAt: new Date().toISOString(), body: paragraph.repeat(5) };
const reply = JSON.stringify({ comment: '届く野菜で献立が変わるのが面白い。季節ごとにどんな定食になるのか気になる。', evidence: '地元の農家と協力して、毎日届く野菜に合わせて献立を変える。' });

test('記事本文を抽出し、ナビゲーションだけ・有料記事は拒否する', () => {
  const extracted = extractBody(`<html><head><title>食堂の定食</title></head><body><nav>広告メニュー</nav><article><h1>食堂の定食</h1>${Array.from({ length: 5 }, () => `<p>${paragraph}</p>`).join('')}</article></body></html>`, article.url);
  assert.ok(extracted.body.includes(paragraph));
  const withFooter = extractBody(`<html><head><title>食堂の定食</title></head><body><article>${Array.from({ length: 5 }, () => `<p>${paragraph}</p>`).join('')}</article><footer>${'<p>店舗一覧 営業時間 電話番号 住所</p>'.repeat(200)}</footer></body></html>`, article.url);
  assert.ok(withFooter.body.includes(paragraph));
  assert.ok(!withFooter.body.includes('店舗一覧'));
  assert.throws(() => extractBody('<html><body><nav>記事を探す ログイン</nav></body></html>', article.url));
  assert.throws(() => extractBody(`<script type="application/ld+json">{"isAccessibleForFree":false}</script><article><p>${article.body}</p></article>`, article.url));
});

test('感想・記事タイトル・URLの順で組み立て、根拠と全体の文字数を確認する', () => {
  assert.equal(validateDraft(reply, article), `${JSON.parse(reply).comment}\n[${article.title}]\n${article.url}`);
  assert.throws(() => validateDraft(reply, { ...article, title: ' ' }), /記事タイトル/);
  assert.throws(() => validateDraft(reply, { ...article, title: '長'.repeat(150) }), /文字数制限/);
  assert.throws(() => validateDraft(JSON.stringify({ comment: 'すごい', evidence: '記事にない架空の話を書きました。' }), article));
  assert.throws(() => validateDraft(JSON.stringify({ comment: '長'.repeat(150), evidence: paragraph }), article));
  assert.throws(() => validateDraft(JSON.stringify({ comment: 'https://wrong.example/', evidence: paragraph }), article));
  assert.equal(normalizeUrl('https://example.com/article?id=2&utm_source=rss#top'), 'https://example.com/article?id=2');
});

test('CLIへ本文をstdinで渡して最終出力を取得し、失敗・タイムアウトも検出する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  const command = join(dir, 'fake-cli.cjs');
  try {
    await writeFile(command, `#!/usr/bin/env node\nconst fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes(${JSON.stringify(paragraph)}))process.exit(2);fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],${JSON.stringify(reply)});});`, { mode: 0o700 });
    const config: Config['ai'] = { provider: 'codex', command, timeoutSeconds: 5 };
    assert.ok((await generate(article, config)).includes(article.url));
    await writeFile(command, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const event=JSON.parse(input);if(event.event!=='user'||!event.message.content.includes(${JSON.stringify(paragraph)}))process.exit(2);console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:JSON.parse(${JSON.stringify(reply)})}}));});`, { mode: 0o700 });
    assert.ok((await generate(article, { ...config, provider: 'antigravity' })).includes(article.url));
    await writeFile(command, `#!/usr/bin/env node\nconsole.log(JSON.stringify({event:'result',result:{status:'ERROR',response:''}}));`, { mode: 0o700 });
    await assert.rejects(generate(article, { ...config, provider: 'antigravity' }), /正常な生成結果/);
    await writeFile(command, '#!/usr/bin/env node\nprocess.exit(1);', { mode: 0o700 });
    await assert.rejects(generate(article, config), /生成AIが失敗/);
    await writeFile(command, '#!/usr/bin/env node\nsetInterval(()=>{},1000);', { mode: 0o700 });
    await assert.rejects(generate(article, { ...config, timeoutSeconds: 1 }), /タイムアウト/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('生成結果を保存しても投稿済みにしない。投稿成功時はRSSと元サイトのURLを記録する', async () => {
  const state = new State(':memory:');
  let draftPath: string | undefined;
  try {
    const config = { ai: { provider: 'codex', timeoutSeconds: 5 }, news: { rss: [article.rssUrl], maxAgeHours: 72 } } as Config;
    const draft = await createNews(config, state, { getNews: async () => article, generate: async () => validateDraft(reply, article) });
    draftPath = draft.path;
    assert.equal(JSON.parse(await readFile(draft.path, 'utf8')).article.body, article.body);
    assert.equal(state.hasPosted(article.url), false);
    state.savePosted([article.url, article.rssUrl], 'https://x.com/i/status/test');
    assert.equal(state.hasPosted(article.url), true);
    assert.equal(state.hasPosted(article.rssUrl), true);
  } finally { state.close(); if (draftPath) await rm(draftPath, { force: true }); }
});

test('本文取得・生成の失敗後は別の記事を選び、未投稿のまま保存する', async () => {
  const state = new State(':memory:');
  let path: string | undefined;
  let calls = 0;
  const second = { ...article, url: 'https://example.com/second', rssUrl: 'https://example.com/rss-second' };
  try {
    const config = { news: {}, ai: {} } as Config;
    const result = await createNews(config, state, {
      getNews: async (_config, _state, excluded) => {
        calls++;
        if (calls === 1) throw new Error('本文取得失敗');
        if (calls === 2) return article;
        assert.ok(excluded?.has(article.url));
        assert.ok(excluded?.has(article.rssUrl));
        return second;
      },
      generate: async selected => {
        if (selected.url === article.url) throw new Error('文字数制限');
        return validateDraft(reply, selected);
      },
    });
    path = result.path;
    assert.equal(calls, 3);
    assert.equal(result.article.url, second.url);
    assert.equal(state.hasPosted(second.url), false);
  } finally { state.close(); if (path) await rm(path, { force: true }); }
});

test('ニュース作成の再試行は5回で止まる', async () => {
  const state = new State(':memory:');
  let calls = 0;
  try {
    await assert.rejects(createNews({ news: {}, ai: {} } as Config, state, {
      getNews: async () => { calls++; throw new Error('取得失敗'); },
      generate: async () => { assert.fail('記事がないので生成しない'); },
    }), /5回/);
    assert.equal(calls, 5);
  } finally { state.close(); }
});

test('--news はRSS・本文取得・CLI生成まで実行し、mode: post でも送信しない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-cli-test-'));
  const html = `<html><head><title>食堂の新しい定食</title></head><body><article><h1>食堂の新しい定食</h1>${Array.from({ length: 5 }, () => `<p>${paragraph}</p>`).join('')}</article></body></html>`;
  const server = createServer((request, response) => {
    if (request.url === '/rss') {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      response.setHeader('Content-Type', 'application/rss+xml');
      response.end(`<rss version="2.0"><channel><title>テストRSS</title><link>${base}</link><description>テスト</description><item><title>食堂の定食</title><link>${base}/article</link><pubDate>${new Date().toUTCString()}</pubDate></item><item><title>古い記事</title><link>${base}/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`);
    } else if (request.url === '/article') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
    } else { response.statusCode = 404; response.end('not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // RSS config uses HTTPS in production. A local HTTP fixture is reached through an injected fetch shim.
    const command = join(dir, 'fake-agy.cjs');
    await writeFile(command, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const e=JSON.parse(input);if(!e.message.content.includes(${JSON.stringify(paragraph)}))process.exit(2);console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',structured_output:JSON.parse(${JSON.stringify(reply)})}}));});`, { mode: 0o700 });
    const config: Config = { timezone: 'Asia/Tokyo', mode: 'post', ai: { provider: 'antigravity', command, timeoutSeconds: 5 }, news: { rss: ['https://fixture.invalid/rss'], maxAgeHours: 72 }, schedule: { news: [] } };
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, stringify(config));
    const shim = join(dir, 'fetch-shim.mjs');
    await writeFile(shim, `const original=globalThis.fetch;globalThis.fetch=(url,options)=>original(String(url)==='https://fixture.invalid/rss'?${JSON.stringify(`${base}/rss`)}:url,options);`);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', shim, '--import', 'tsx', 'start.ts', '--news', '--config', configPath], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    assert.ok(output.includes(`${base}/article`));
    assert.ok(output.includes('届く野菜で献立が変わる'));
    const state = new State(join(dir, 'bot.sqlite'));
    try { assert.equal(state.hasPosted(`${base}/article`), false); assert.deepEqual(state.plans(new Date().toISOString().slice(0, 10)), []); }
    finally { state.close(); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

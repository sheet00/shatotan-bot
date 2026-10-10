import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { dataDir, openBrowser } from './browser.js';
import { generate, type Article } from './ai.js';
import type { Config } from './config.js';
import { State } from './state.js';

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('記事URLがHTTP(S)ではありません。');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/.test(key)) url.searchParams.delete(key);
  return url.href;
}

export function extractBody(html: string, url: string): { title: string; body: string } {
  const dom = new JSDOM(html, { url });
  try {
    for (const script of dom.window.document.querySelectorAll('script[type="application/ld+json"]')) {
      if (/"isAccessibleForFree"\s*:\s*(?:false|"false")/.test(script.textContent ?? '')) throw new Error('記事が有料公開のため本文確認を見送りました。');
    }
    // Prefer the explicit article container; a long store directory/footer can otherwise win.
    for (const selector of ['[itemprop="articleBody"]', 'article', 'main']) {
      const candidates = dom.window.document.querySelectorAll(selector);
      if (candidates.length !== 1) continue;
      dom.window.document.body.replaceChildren(candidates[0].cloneNode(true));
      break;
    }
    dom.window.document.querySelectorAll('nav, aside, footer, [role="navigation"], [role="contentinfo"]').forEach(element => element.remove());
    // Japanese paragraphs are shorter in character count than English paragraphs.
    if (!isProbablyReaderable(dom.window.document, { minContentLength: 80, minScore: 10 })) throw new Error('記事本文を確認できません。');
    const result = new Readability(dom.window.document).parse();
    const body = result?.textContent?.replace(/[\t\r ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    if (!body || body.length < 200 || body.length > 80_000) throw new Error('記事本文が短すぎるか、取得範囲を確認できません。');
    return { title: result?.title ?? '', body };
  } finally { dom.window.close(); }
}

export async function readArticle(page: Page, link: string): Promise<{ title: string; body: string; url: string }> {
  const response = await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (response && !response.ok()) throw new Error(`記事取得に失敗: HTTP ${response.status()}`);
  if (new URL(link).hostname === 'news.google.com') {
    await page.waitForURL(url => url.hostname !== 'news.google.com' && !url.hostname.endsWith('.google.com'), { timeout: 30_000, waitUntil: 'domcontentloaded' });
  }
  const url = normalizeUrl(page.url());
  const result = extractBody(await page.content(), url);
  return { ...result, url };
}

export async function getNews(config: Config['news'], state: State, excluded = new Set<string>()): Promise<Article> {
  const feedUrl = config.rss[randomInt(config.rss.length)];
  console.log(`RSS: ${feedUrl}`);
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`RSS取得に失敗: HTTP ${response.status}`);
  const xml = await response.text();
  if (xml.length > 5_000_000) throw new Error('RSSが大きすぎます。');
  const feed = await new Parser().parseString(xml);
  const now = Date.now();
  const candidates = feed.items.filter(item => {
    if (!item.link) return false;
    try {
      const date = Date.parse(item.isoDate ?? item.pubDate ?? '');
      const url = normalizeUrl(item.link);
      return !excluded.has(url) && !state.hasPosted(url) && Number.isFinite(date)
        && date <= now + 300_000 && date >= now - config.maxAgeHours * 3_600_000;
    } catch { return false; }
  });
  if (!candidates.length) throw new Error('対象期間内の未投稿記事がありません。');
  const item = candidates[randomInt(candidates.length)];
  const rssUrl = normalizeUrl(item.link!);
  excluded.add(rssUrl);
  console.log(`選んだ記事: ${item.title}`);
  let browser: Browser | undefined;
  try {
    browser = await openBrowser(true);
    const page = await browser.newPage();
    const article = await readArticle(page, rssUrl);
    if (excluded.has(article.url) && article.url !== rssUrl) throw new Error('リンク先の記事は今回すでに試した記事です。');
    if (state.hasPosted(article.url)) throw new Error('リンク先の記事は投稿済みです。');
    console.log(`本文確認: ${article.body.length}文字 / ${article.url}`);
    return { ...article, title: article.title || item.title || '', rssUrl, publishedAt: item.isoDate ?? item.pubDate! };
  } finally { await browser?.close(); }
}

export async function createNews(config: Config, state: State,
  dependencies: { getNews?: typeof getNews; generate?: typeof generate } = {}) {
  const excluded = new Set<string>();
  let draft: { article: Article; text: string } | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const article = await (dependencies.getNews ?? getNews)(config.news, state, excluded);
      excluded.add(article.rssUrl);
      excluded.add(article.url);
      const text = await (dependencies.generate ?? generate)(article, config.ai);
      draft = { article, text };
      break;
    } catch (error) {
      lastError = error;
      console.warn(`ニュース作成失敗 (${attempt}/5): ${error instanceof Error ? error.message : String(error)}${attempt < 5 ? ' 別のニュースを選びます。' : ''}`);
    }
  }
  if (!draft) throw new Error('5回試しましたがニュース投稿文を作成できませんでした。', { cause: lastError });
  const { article, text } = draft;
  const directory = join(dataDir, 'drafts');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.json`);
  // Persist provenance and text for inspection, without registering a successful post.
  await writeFile(path, JSON.stringify({ createdAt: new Date().toISOString(), article, text }, null, 2), { mode: 0o600 });
  console.log(`\n${text}\n\n生成結果: ${path}`);
  return { article, text, path };
}

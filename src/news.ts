import Parser from 'rss-parser';
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { randomInt } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { openBrowser } from './browser.js';
import { generate, selectNews, validateSelection, type Article, type NewsCandidate } from './ai.js';
import type { Config } from './config.js';
import { State } from './state.js';
import { saveDraft } from './draft.js';

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

export async function getNewsCandidates(config: Config['news'], state: State): Promise<NewsCandidate[]> {
  const feedUrl = config.rss[randomInt(config.rss.length)];
  console.log(`RSS: ${feedUrl}`);
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`RSS取得に失敗: HTTP ${response.status}`);
  const xml = await response.text();
  if (xml.length > 5_000_000) throw new Error('RSSが大きすぎます。');
  const feed = await new Parser().parseString(xml);
  const now = Date.now();
  const seen = new Set<string>();
  const candidates = feed.items.filter(item => {
    if (!item.link) return false;
    try {
      const date = Date.parse(item.isoDate ?? item.pubDate ?? '');
      const url = normalizeUrl(item.link);
      const eligible = !seen.has(url) && !state.hasPosted(url) && Number.isFinite(date)
        && date <= now + 300_000 && date >= now - config.maxAgeHours * 3_600_000;
      if (eligible) seen.add(url);
      return eligible;
    } catch { return false; }
  });
  if (!candidates.length) throw new Error('対象期間内の未投稿記事がありません。');
  const selected: NewsCandidate[] = [];
  while (candidates.length && selected.length < 10) {
    const [item] = candidates.splice(randomInt(candidates.length), 1);
    selected.push({
      id: `candidate-${selected.length + 1}`,
      title: (item.title ?? '').slice(0, 1000),
      rssUrl: normalizeUrl(item.link!),
      publishedAt: item.isoDate ?? item.pubDate!,
    });
  }
  console.log(`ニュース候補: ${selected.length}件`);
  return selected;
}

export async function getNews(candidate: NewsCandidate, state: State, excluded: Set<string>): Promise<Article> {
  const rssUrl = candidate.rssUrl;
  if (excluded.has(rssUrl) || state.hasPosted(rssUrl)) throw new Error('候補記事は投稿済みか今回すでに試した記事です。');
  excluded.add(rssUrl);
  console.log(`選んだ記事: ${candidate.title}`);
  let browser: Browser | undefined;
  try {
    browser = await openBrowser(true);
    const page = await browser.newPage();
    const article = await readArticle(page, rssUrl);
    if (excluded.has(article.url) && article.url !== rssUrl) throw new Error('リンク先の記事は今回すでに試した記事です。');
    excluded.add(article.url);
    if (state.hasPosted(article.url)) throw new Error('リンク先の記事は投稿済みです。');
    console.log(`本文確認: ${article.body.length}文字 / ${article.url}`);
    return { ...article, title: article.title || candidate.title, rssUrl, publishedAt: candidate.publishedAt };
  } finally { await browser?.close(); }
}

export async function createNews(config: Config, state: State,
  dependencies: { getNewsCandidates?: typeof getNewsCandidates; selectNews?: typeof selectNews; getNews?: typeof getNews; generate?: typeof generate } = {}) {
  const candidates = await (dependencies.getNewsCandidates ?? getNewsCandidates)(config.news, state);
  const selectedIds = validateSelection(JSON.stringify({ selectedIds: await (dependencies.selectNews ?? selectNews)(candidates, config.ai) }), candidates);
  if (!selectedIds.length) throw new Error('宣伝記事を除外した結果、取り上げるニュース候補がありません。');
  const selected = selectedIds.map(id => candidates.find(candidate => candidate.id === id)!);
  console.log(`宣伝除外後: ${selected.length}件（候補の入力順に本文を取得）`);
  const excluded = new Set<string>();
  let draft: { article: Article; text: string } | undefined;
  let lastError: unknown;
  const attempts = selected.slice(0, 5);
  for (const [index, candidate] of attempts.entries()) {
    try {
      const article = await (dependencies.getNews ?? getNews)(candidate, state, excluded);
      excluded.add(article.rssUrl);
      excluded.add(article.url);
      const text = await (dependencies.generate ?? generate)(article, config.ai);
      draft = { article, text };
      break;
    } catch (error) {
      lastError = error;
      console.warn(`ニュース作成失敗 (${index + 1}/${attempts.length}): ${error instanceof Error ? error.message : String(error)}${index + 1 < attempts.length ? ' 次の候補を確認します。' : ''}`);
    }
  }
  if (!draft) throw new Error(`${attempts.length}件の候補を試しましたがニュース投稿文を作成できませんでした。`, { cause: lastError });
  const { article, text } = draft;
  const path = await saveDraft('news', { article, text });
  console.log(`\n${text}\n\n生成結果: ${path}`);
  return { article, text, path };
}

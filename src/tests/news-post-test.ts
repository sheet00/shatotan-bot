import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import twitterText from 'twitter-text';
import { dataDir } from '../browser.js';
import { loadConfig } from '../config.js';
import { createNews, getNewsCandidates, getNews, normalizeUrl } from '../news.js';
import { State } from '../state.js';
import { postToX } from '../post.js';
import { selectNews, generate, type Article } from '../ai.js';

async function measure<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.log(`計測開始: ${label}`);
  try { return await action(); }
  finally { console.log(`所要時間: ${label} ${((performance.now() - started) / 1000).toFixed(2)}秒`); }
}

const { values } = parseArgs({ options: {
  send: { type: 'boolean' }, draft: { type: 'string' }, config: { type: 'string' },
} });
const config = await loadConfig(values.config);
const state = new State(join(dataDir, 'bot.sqlite'));
if (!state.acquire()) { state.close(); throw new Error('他のニュース処理が実行中です。'); }
const renewal = setInterval(() => state.renew(), 60_000);
let sending = false;
try {
  const draft: { article: Article; text: string } = values.draft
    ? JSON.parse(await readFile(values.draft, 'utf8'))
    : await measure('ニュース処理全体', () => createNews(config, state, {
      getNewsCandidates: (newsConfig, currentState) => measure('RSS候補収集', () => getNewsCandidates(newsConfig, currentState)),
      selectNews: (candidates, aiConfig) => measure('宣伝除外・選定', () => selectNews(candidates, aiConfig)),
      getNews: (candidate, currentState, excluded) => measure(`本文取得 ${candidate.id}`, () => getNews(candidate, currentState, excluded)),
      generate: (article, aiConfig) => measure('コメント生成', () => generate(article, aiConfig)),
    }));
  if (!draft.article?.body || !draft.article.title || typeof draft.text !== 'string'
    || !twitterText.parseTweet(draft.text).valid
    || !draft.text.endsWith(`\n[${draft.article.title.trim()}]\n${draft.article.url}`)) {
    throw new Error('ニュース下書きの形式を確認できません。');
  }
  const urls = [normalizeUrl(draft.article.rssUrl), normalizeUrl(draft.article.url)];
  if (urls.some(url => state.hasPosted(url))) throw new Error('記事は投稿済みです。');
  if (!values.send) {
    console.log(`未投稿（送信には --send が必要）:\n${draft.text}`);
  } else {
    sending = true;
    const postUrl = await postToX(draft.text);
    state.savePosted(urls, postUrl);
    console.log(`投稿成功: ${postUrl}`);
  }
} catch (error) {
  if (sending) console.error('送信処理で失敗しました。自動再送しません。再実行前にXで投稿の有無を確認してください。');
  throw error;
} finally {
  clearInterval(renewal);
  state.release();
  state.close();
}

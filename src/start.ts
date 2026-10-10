import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDir } from './browser.js';
import { loadConfig } from './config.js';
import { State } from './state.js';
import { createNews } from './news.js';
import { createWeather } from './weather.js';
import { postToX } from './post.js';
import { japanDate, planDay, tick } from './scheduler.js';

async function main() {
  const { values } = parseArgs({ options: { news: { type: 'boolean' }, weather: { type: 'boolean' }, help: { type: 'boolean' }, config: { type: 'string' }, 'show-schedule': { type: 'boolean' } } });
  if (values.help) {
    console.log('npm start                         内部スケジューラーを起動\nnpm start -- --news                ニュース投稿文を1回生成（未投稿）\nnpm start -- --weather             天気投稿文を1回生成（未投稿）\nnpm start -- --show-schedule       今日の抽選時刻・状態を確認\n--config <path>                    設定ファイルを指定');
    return;
  }
  const config = await loadConfig(values.config);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const state = new State(join(dataDir, 'bot.sqlite'));
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  async function job(send: boolean, isWeather = false) {
    if (isWeather) {
      const draft = await createWeather(config, state);
      if (!send) return `生成のみ: ${draft.path}`;
      const postUrl = await postToX(draft.text);
      console.log(`天気投稿成功: ${postUrl}`);
      return postUrl;
    }
    const draft = await createNews(config, state);
    if (!send) return `生成のみ: ${draft.path}`;
    const postUrl = await postToX(draft.text);
    state.savePosted([draft.article.rssUrl, draft.article.url], postUrl);
    console.log(`投稿成功: ${postUrl}`);
    return postUrl;
  }
  try {
    if (values.news) {
      if (!state.acquire()) throw new Error('他のニュース処理が実行中です。');
      const renewal = setInterval(() => state.renew(), 60_000);
      try { await job(false, false); } finally { clearInterval(renewal); state.release(); }
      return;
    }
    if (values.weather) {
      if (!state.acquire()) throw new Error('他の処理が実行中です。');
      const renewal = setInterval(() => state.renew(), 60_000);
      try { await job(false, true); } finally { clearInterval(renewal); state.release(); }
      return;
    }
    if (values['show-schedule']) {
      planDay(state, config);
      const plans = state.plans(japanDate(Date.now()));
      if (!plans.length) console.log('今日の予定はありません。設定した時間帯が過ぎている場合、翌日から実行します。');
      for (const p of plans) console.log(`${p.date}/${p.window_id} ${new Date(p.scheduled_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} ${p.status}${p.detail ? ` ${p.detail}` : ''}`);
      return;
    }
    state.skipMissedOnStart(Date.now());
    console.log(`内部スケジューラー起動（日本時間 / ${config.mode}）。終了にはSIGTERMまたはCtrl+C。`);
    while (!shutdown.signal.aborted) {
      await tick(state, config, plan => job(config.mode === 'post', plan.window_id.startsWith('weather')));
      await delay(15_000, undefined, { signal: shutdown.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    }
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    state.close();
  }
}

try { await main(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  await mkdir(dataDir, { recursive: true }).then(() => appendFile(join(dataDir, 'errors.log'), `${new Date().toISOString()} ${message}\n`)).catch(() => {});
  process.exitCode = 1;
}

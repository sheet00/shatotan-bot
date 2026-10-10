import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promptForWeather, validateWeatherDraft, type WeatherInfo } from '../ai.js';
import { validateConfig, type Config } from '../config.js';
import { State } from '../state.js';
import { planDay, tick } from '../scheduler.js';
import { createWeather } from '../weather.js';

const mockWeather: WeatherInfo = {
  url: 'https://tenki.jp/forecast/3/',
  comment: '関東地方は日差しがたっぷり届いています。午後3時までの最高気温は、きのうと同じくらいで、東京都心は26.5度でした。このあとも広く晴れるでしょう。昼間は過ごしやすい陽気でしたが、夜は薄着だとヒンヤリ感じられそうです。羽織るもので調節してください。あすあさっての連休も秋晴れが続くでしょう。朝晩と昼間の寒暖差が大きくなります。体調管理にご注意ください。',
  area: '東京',
  dateText: '11(日)',
  weather: '晴',
  maxTemp: 27,
  minTemp: 16,
  probPrecip: 10,
  wind: '北の風　後　北東の風',
  announceDatetime: '2026-10-10 14:00:00',
};

const testConfig: Config = {
  timezone: 'Asia/Tokyo',
  mode: 'preview',
  ai: { provider: 'antigravity', timeoutSeconds: 30 },
  news: { rss: ['https://example.com/rss'], maxAgeHours: 72 },
  weather: { url: 'https://tenki.jp/forecast/3/' },
  schedule: {
    news: [{ id: 'news_12', between: ['12:00', '13:00'], count: 1 }],
    weather: [{ id: 'weather_21', between: ['21:00', '22:00'], count: 1 }],
  },
};

test('天気プロンプトに概況・気温・日付などのデータと文字数制限が埋め込まれる', async () => {
  const prompt = await promptForWeather(mockWeather);
  assert.match(prompt, /日差しがたっぷり届いています/);
  assert.match(prompt, /27℃/);
  assert.match(prompt, /16℃/);
  assert.match(prompt, /11\(日\)/);
  assert.match(prompt, /しゃとたん/);
});

test('天気生成文の形式・文字数・不要URLの除外を検証する（URLは付与しない）', () => {
  // 正常系
  const validComment = '明日は秋晴れが続いて最高27度まで上がるよ☀️でも朝晩はヒンヤリするから羽織るものがあると安心かも🧥体調管理に気をつけてね☆';
  const validJson = JSON.stringify({ comment: validComment });
  const text = validateWeatherDraft(validJson, mockWeather);
  assert.equal(text, validComment);

  // 二重エンコードされたJSONのアンラップ
  const doubleEncoded = JSON.stringify({ comment: validJson });
  assert.equal(validateWeatherDraft(doubleEncoded, mockWeather), text);

  // 空文字は拒否
  assert.throws(() => validateWeatherDraft(JSON.stringify({ comment: '' }), mockWeather));

  // 不正なURLやメンションを含む場合は拒否
  assert.throws(() => validateWeatherDraft(JSON.stringify({ comment: '詳細は https://example.com を見てね' }), mockWeather));
  assert.throws(() => validateWeatherDraft(JSON.stringify({ comment: '@shatotan 明日は晴れだよ' }), mockWeather));

  // 文字数超過は拒否
  const tooLong = 'あ'.repeat(300);
  assert.throws(() => validateWeatherDraft(JSON.stringify({ comment: tooLong }), mockWeather));
});

test('天気ドラフトを作成してJSONファイルに保存する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-test-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const result = await createWeather(testConfig, undefined, {
      getWeather: async () => mockWeather,
      generateWeather: async () => '明日の東京は晴れだよ☀️',
    });
    assert.equal(result.weather.area, '東京');
    assert.match(result.text, /明日の東京は晴れだよ/);
    assert.match(result.path, /\d{4}-\d{2}-\d{2}-\d{6}-weather\.json$/);
  } finally {
    process.env.DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test('天気とニュースのスケジュール枠を独立して抽選し、実行できる', async () => {
  assert.deepEqual(validateConfig(testConfig), testConfig);
  const state = new State(':memory:');
  try {
    const at = (time: string) => Date.parse(`2026-10-10T${time}:00+09:00`);
    planDay(state, testConfig, at('10:00'), () => 15);
    const plans = state.plans('2026-10-10');
    assert.equal(plans.length, 2);
    const newsPlan = plans.find(p => p.window_id === 'news_12')!;
    const weatherPlan = plans.find(p => p.window_id === 'weather_21')!;
    assert.equal(newsPlan.scheduled_at, at('12:15'));
    assert.equal(weatherPlan.scheduled_at, at('21:15'));

    const executed: string[] = [];
    const run = async (plan: { date: string; window_id: string }) => {
      executed.push(plan.window_id);
      return 'ok';
    };

    await tick(state, testConfig, run, at('12:15'));
    assert.deepEqual(executed, ['news_12']);
    await tick(state, testConfig, run, at('21:15'));
    assert.deepEqual(executed, ['news_12', 'weather_21']);
  } finally {
    state.close();
  }
});

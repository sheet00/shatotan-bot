import type { Browser } from 'playwright';
import { openBrowser } from './browser.js';
import { generateWeather, type WeatherInfo } from './ai.js';
import type { Config } from './config.js';
import type { State } from './state.js';
import { saveDraft } from './draft.js';

export async function getWeather(
  url = 'https://tenki.jp/forecast/3/',
  existingBrowser?: Browser,
): Promise<WeatherInfo> {
  const browser = existingBrowser ?? (await openBrowser(true));
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (response && !response.ok()) throw new Error(`天気予報の取得に失敗: HTTP ${response.status()}`);

    const comment = await page.$eval('.forecast-comment', el => el.textContent?.trim()).catch(() => '');
    if (!comment) throw new Error('天気概況（forecast-comment）を取得できませんでした。');

    const dateText = await page
      .$eval('#forecast-public-date-entry-2', el => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .catch(() => '明日') || '明日';

    const dl = await page.evaluate(() => {
      const w = window as any;
      if (!Array.isArray(w.dataLayer)) return null;
      for (const item of w.dataLayer) {
        if (item && item.tomorrow_map_telop_forecast_telop !== undefined) return item;
      }
      return null;
    });

    if (!dl) throw new Error('天気データ（dataLayer）を取得できませんでした。');

    const weather = dl.tomorrow_map_telop_forecast_telop || dl.tomorrow_weather || '';
    const maxTemp = Number(dl.tomorrow_max_temp);
    const minTemp = Number(dl.tomorrow_min_temp);
    const probPrecip = Number(dl.tomorrow_prob_precip);
    const wind = dl.tomorrow_wind || undefined;
    const announceDatetime = dl.forecast_announce_datetime || undefined;

    if (!weather || !Number.isFinite(maxTemp) || !Number.isFinite(minTemp)) {
      throw new Error('明日の天気予報の数値が不正です。');
    }

    console.log(`天気予報取得成功: ${dateText} 東京 ${weather} 最高${maxTemp}℃ 最低${minTemp}℃ 降水${probPrecip}%`);

    return {
      url,
      comment,
      area: '東京',
      dateText,
      weather,
      maxTemp,
      minTemp,
      probPrecip,
      wind,
      announceDatetime,
    };
  } finally {
    if (!existingBrowser) await browser.close();
  }
}

export async function createWeather(
  config: Config,
  _state?: State,
  dependencies: {
    getWeather?: typeof getWeather;
    generateWeather?: typeof generateWeather;
  } = {},
) {
  let draft: { weather: WeatherInfo; text: string } | undefined;
  let lastError: unknown;
  const weatherUrl = config.weather?.url ?? 'https://tenki.jp/forecast/3/';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const weather = await (dependencies.getWeather ?? getWeather)(weatherUrl);
      const text = await (dependencies.generateWeather ?? generateWeather)(weather, config.ai);
      draft = { weather, text };
      break;
    } catch (error) {
      lastError = error;
      console.warn(`天気投稿文作成失敗 (${attempt}/3): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!draft) throw new Error('3回試しましたが天気投稿文を作成できませんでした。', { cause: lastError });

  const { weather, text } = draft;
  const path = await saveDraft('weather', { type: 'weather', weather, text });
  console.log(`\n${text}\n\n生成結果: ${path}`);
  return { weather, text, path };
}

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export interface WindowConfig { id: string; between: [string, string]; count: 1 }
export interface Config {
  timezone: 'Asia/Tokyo';
  mode: 'preview' | 'post';
  ai: { provider: 'codex' | 'antigravity'; command?: string; timeoutSeconds: number };
  news: { rss: string[]; maxAgeHours: number };
  weather?: { url: string };
  schedule: { news: WindowConfig[]; weather?: WindowConfig[] };
}

export function minutes(time: string): number {
  if (time === '24:00') return 24 * 60;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`時刻が不正です: ${time}`);
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function validateWindows(windows: WindowConfig[], ids: Set<string>): void {
  const ranges: [number, number][] = [];
  for (const w of windows) {
    if (!w || typeof w.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(w.id) || ids.has(w.id)
      || w.count !== 1 || !Array.isArray(w.between) || w.between.length !== 2
      || w.between.some(t => typeof t !== 'string')) throw new Error('各時間帯には一意のid、between、count: 1 が必要です。');
    ids.add(w.id);
    const range: [number, number] = [minutes(w.between[0]), minutes(w.between[1])];
    if (range[0] >= range[1]) throw new Error('時間帯は開始より終了を後にしてください。日跨ぎは24:00で分割します。');
    if (ranges.some(([s, e]) => range[0] < e && range[1] > s)) throw new Error('時間帯が重複しています。');
    ranges.push(range);
  }
}

export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || c.timezone !== 'Asia/Tokyo') throw new Error('timezone は Asia/Tokyo を指定してください。');
  if (!['preview', 'post'].includes(c.mode)) throw new Error('mode は preview / post を指定してください。');
  if (!c.ai || !['codex', 'antigravity'].includes(c.ai.provider)
    || !Number.isFinite(c.ai.timeoutSeconds) || c.ai.timeoutSeconds < 1 || c.ai.timeoutSeconds > 300
    || (c.ai.command !== undefined && (typeof c.ai.command !== 'string' || !c.ai.command.trim()))) {
    throw new Error('ai 設定が不正です。timeoutSeconds は1〜300秒です。');
  }
  if (!c.news || !Array.isArray(c.news.rss) || !c.news.rss.length
    || c.news.rss.some(url => typeof url !== 'string' || !/^https:\/\//.test(url))
    || !Number.isFinite(c.news.maxAgeHours) || c.news.maxAgeHours <= 0) throw new Error('news 設定が不正です。');
  for (const url of c.news.rss) new URL(url);
  if (c.weather !== undefined) {
    if (!c.weather || typeof c.weather.url !== 'string' || !/^https?:\/\//.test(c.weather.url)) {
      throw new Error('weather 設定が不正です。url を指定してください。');
    }
    new URL(c.weather.url);
  }
  if (!Array.isArray(c.schedule?.news)) throw new Error('schedule.news を指定してください。');
  const ids = new Set<string>();
  validateWindows(c.schedule.news, ids);
  if (c.schedule.weather !== undefined) {
    if (!Array.isArray(c.schedule.weather)) throw new Error('schedule.weather は配列で指定してください。');
    validateWindows(c.schedule.weather, ids);
  }
  return c;
}

export async function loadConfig(path = process.env.BOT_CONFIG ?? './config.yaml'): Promise<Config> {
  return validateConfig(parse(await readFile(path, 'utf8')));
}

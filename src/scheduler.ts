import { randomInt } from 'node:crypto';
import { minutes, type Config } from './config.js';
import { type Plan, State } from './state.js';

export function japanDate(now: number): string { return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10); }

export function planDay(state: State, config: Config, now = Date.now(), pick = randomInt) {
  const date = japanDate(now);
  const midnight = Date.parse(`${date}T00:00:00+09:00`);
  const existing = new Set(state.plans(date).map(p => p.window_id));
  for (const window of config.schedule.news) {
    if (existing.has(window.id)) continue;
    const starts = midnight + minutes(window.between[0]) * 60_000;
    const ends = midnight + minutes(window.between[1]) * 60_000;
    // Pick whole minutes, end-exclusive; a first start midway uses the remaining window.
    const first = Math.max(starts, Math.ceil(now / 60_000) * 60_000);
    if (first >= ends) continue;
    state.addPlan({ date, window_id: window.id, scheduled_at: first + pick((ends - first) / 60_000) * 60_000, ends_at: ends });
  }
}

export async function tick(state: State, config: Config, run: (plan: Plan) => Promise<string>, now = Date.now()) {
  state.expire(now);
  planDay(state, config, now);
  const activeIds = new Set(config.schedule.news.map(w => w.id));
  for (const plan of state.plans(japanDate(now))) {
    if (!activeIds.has(plan.window_id) || plan.status !== 'pending' || plan.scheduled_at > now) continue;
    if (!state.acquire(now)) return;
    const renewal = setInterval(() => state.renew(), 60_000);
    try {
      if (!state.claim(plan, now)) continue;
      try { state.finish(plan, 'done', await run(plan)); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.finish(plan, 'failed', message);
        console.error(`[${plan.date}/${plan.window_id}] ${message}`);
      }
    } finally { clearInterval(renewal); state.release(); }
  }
}

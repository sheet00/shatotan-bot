import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig, type Config } from '../config.js';
import { State } from '../state.js';
import { japanDate, planDay, tick } from '../scheduler.js';

const config: Config = {
  timezone: 'Asia/Tokyo', mode: 'preview',
  ai: { provider: 'codex', timeoutSeconds: 10 },
  news: { rss: ['https://example.com/rss'], maxAgeHours: 72 },
  schedule: { news: [{ id: 'lunch', between: ['12:00', '14:00'], count: 1 }] },
};
const at = (time: string) => Date.parse(`2026-10-10T${time}:00+09:00`);

test('抽選は指定枠内、翌日は別枠、日本時間で日付を切り替える', () => {
  const state = new State(':memory:');
  try {
    planDay(state, config, at('10:00'), upper => upper - 1);
    const [plan] = state.plans('2026-10-10');
    assert.equal(plan.scheduled_at, at('13:59'));
    assert.equal(plan.ends_at, at('14:00'));
    assert.equal(japanDate(Date.parse('2026-10-10T15:00:00Z')), '2026-10-11');
    planDay(state, config, at('10:00') + 86_400_000, () => 0);
    assert.equal(state.plans('2026-10-11')[0].scheduled_at, at('12:00') + 86_400_000);
  } finally { state.close(); }
});

test('SQLiteを開き直しても時刻は引き直さず、成功した枠は再実行しない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-test-'));
  let state = new State(join(dir, 'state.sqlite'));
  try {
    planDay(state, config, at('10:00'), () => 37);
    state.close(); state = new State(join(dir, 'state.sqlite'));
    planDay(state, config, at('11:00'), () => { throw new Error('引き直してはいけない'); });
    assert.equal(state.plans('2026-10-10')[0].scheduled_at, at('12:37'));
    let runs = 0;
    const run = async () => { runs++; return 'preview'; };
    await tick(state, config, run, at('12:36'));
    assert.equal(runs, 0);
    await tick(state, config, run, at('12:37'));
    await tick(state, config, run, at('12:38'));
    assert.equal(runs, 1);
    assert.equal(state.plans('2026-10-10')[0].status, 'done');
  } finally { state.close(); await rm(dir, { recursive: true, force: true }); }
});

test('途中から初起動した場合は残りの時間帯から抽選、過ぎた枠は実行しない', async () => {
  const state = new State(':memory:');
  try {
    planDay(state, config, at('13:15') + 1000, () => 0);
    assert.equal(state.plans('2026-10-10')[0].scheduled_at, at('13:16'));
    await tick(state, config, async () => { throw new Error('実行してはいけない'); }, at('14:00'));
    assert.equal(state.plans('2026-10-10')[0].status, 'skipped');
  } finally { state.close(); }
});

test('失敗・処理中のクラッシュ・停止中に過ぎた枠を再送しない', async () => {
  for (const condition of ['failed', 'running', 'offline']) {
    const state = new State(':memory:');
    try {
      planDay(state, config, at('10:00'), () => 0);
      if (condition === 'running') state.claim(state.plans('2026-10-10')[0], at('12:00'));
      if (condition === 'offline') state.skipMissedOnStart(at('12:01'));
      let count = 0;
      const run = async () => { count++; throw new Error('テスト用失敗'); };
      await tick(state, config, run, at('12:01'));
      await tick(state, config, run, at('12:02'));
      assert.equal(count, condition === 'failed' ? 1 : 0);
    } finally { state.close(); }
  }
});

test('二つのプロセス相当の接続から同じ処理を同時実行できない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lock-test-'));
  const a = new State(join(dir, 'state.sqlite')); const b = new State(join(dir, 'state.sqlite'));
  try {
    assert.equal(a.acquire(at('12:00')), true);
    assert.equal(b.acquire(at('12:00')), false);
    a.release(); assert.equal(b.acquire(at('12:00')), true); b.release();
    planDay(a, config, at('10:00'), () => 0);
    const plan = a.plans('2026-10-10')[0];
    assert.equal(a.claim(plan, at('12:00')), true);
    assert.equal(b.claim(plan, at('12:00')), false);
  } finally { a.close(); b.close(); await rm(dir, { recursive: true, force: true }); }
});

test('不正時刻・重複枠・countの誤設定を起動前に拒否する', () => {
  assert.deepEqual(validateConfig(config), config);
  for (const schedule of [
    [{ id: 'a', between: ['24:00', '25:00'], count: 1 }],
    [{ id: 'a', between: ['14:00', '12:00'], count: 1 }],
    [{ id: 'a', between: ['12:00', '14:00'], count: 2 }],
    [{ id: 'a', between: ['12:00', '14:00'], count: 1 }, { id: 'b', between: ['13:00', '15:00'], count: 1 }],
  ]) assert.throws(() => validateConfig({ ...config, schedule: { news: schedule } }));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { draftFilename, saveDraft } from '../draft.js';

test('draftFilename は日本時間で yyyy-mm-dd-hhmmss-category.json 形式のファイル名を返す', () => {
  // UTC 2026-10-10T07:24:05.954Z は JST 2026-10-10T16:24:05.954
  const date = new Date('2026-10-10T07:24:05.954Z');
  const filename = draftFilename('news', date);
  assert.equal(filename, '2026-10-10-162405-news.json');

  const weatherFilename = draftFilename('weather', date);
  assert.equal(weatherFilename, '2026-10-10-162405-weather.json');

  // 日付指定なしのデフォルトでも形式に合致する
  assert.match(draftFilename('news'), /^\d{4}-\d{2}-\d{2}-\d{6}-news\.json$/);
});

test('saveDraft はドラフト内容を mode: 0o600 で保存し、createdAt を含む', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draft-test-'));
  const originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const fixedDate = new Date('2026-10-10T07:24:05.954Z');
    const path = await saveDraft('news', { title: 'テスト記事', text: 'テスト投稿文' }, fixedDate);
    assert.equal(path, join(dir, 'drafts', '2026-10-10-162405-news.json'));

    const content = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(content.createdAt, '2026-10-10T07:24:05.954Z');
    assert.equal(content.title, 'テスト記事');
    assert.equal(content.text, 'テスト投稿文');

    const fileStat = await stat(path);
    // mode 0o600 のパーミッション確認（下位9ビット）
    assert.equal(fileStat.mode & 0o777, 0o600);
  } finally {
    process.env.DATA_DIR = originalDataDir;
    await rm(dir, { recursive: true, force: true });
  }
});

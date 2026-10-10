import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './browser.js';

export function draftFilename(category: string, date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 3_600_000);
  const iso = jst.toISOString();
  const yyyy = iso.slice(0, 4);
  const mm = iso.slice(5, 7);
  const dd = iso.slice(8, 10);
  const hh = iso.slice(11, 13);
  const min = iso.slice(14, 16);
  const ss = iso.slice(17, 19);
  return `${yyyy}-${mm}-${dd}-${hh}${min}${ss}-${category}.json`;
}

export async function saveDraft(
  category: string,
  payload: Record<string, unknown>,
  date = new Date(),
  baseDir = process.env.DATA_DIR ?? dataDir,
): Promise<string> {
  const directory = join(baseDir, 'drafts');
  await mkdir(directory, { recursive: true });
  const path = join(directory, draftFilename(category, date));
  await writeFile(
    path,
    JSON.stringify({ createdAt: date.toISOString(), ...payload }, null, 2),
    { mode: 0o600 },
  );
  return path;
}

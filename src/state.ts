import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface Plan {
  date: string; window_id: string; scheduled_at: number; ends_at: number;
  status: string; detail: string | null;
}

export class State {
  readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS posted_urls (url TEXT PRIMARY KEY, post_url TEXT NOT NULL, posted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plans (
        date TEXT NOT NULL, window_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', detail TEXT, PRIMARY KEY (date, window_id)
      );
      CREATE TABLE IF NOT EXISTS job_lock (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }
  hasPosted(url: string): boolean { return !!this.db.prepare('SELECT 1 FROM posted_urls WHERE url = ?').get(url); }
  savePosted(urls: string[], postUrl: string, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const url of new Set(urls)) this.db.prepare('INSERT OR IGNORE INTO posted_urls VALUES (?, ?, ?)').run(url, postUrl, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addPlan(plan: Omit<Plan, 'status' | 'detail'>) {
    this.db.prepare('INSERT OR IGNORE INTO plans (date, window_id, scheduled_at, ends_at) VALUES (?, ?, ?, ?)')
      .run(plan.date, plan.window_id, plan.scheduled_at, plan.ends_at);
  }
  plans(date: string): Plan[] {
    return this.db.prepare('SELECT * FROM plans WHERE date = ? ORDER BY scheduled_at').all(date) as unknown as Plan[];
  }
  finish(plan: Plan, status: string, detail: string) {
    this.db.prepare('UPDATE plans SET status = ?, detail = ? WHERE date = ? AND window_id = ?')
      .run(status, detail, plan.date, plan.window_id);
  }
  expire(now: number) {
    this.db.prepare("UPDATE plans SET status = 'skipped', detail = '時間帯を過ぎたため見送り' WHERE status = 'pending' AND ends_at <= ?").run(now);
  }
  skipMissedOnStart(now: number) {
    this.db.prepare("UPDATE plans SET status = 'skipped', detail = '停止中に実行時刻を過ぎたため見送り' WHERE status = 'pending' AND scheduled_at < ?").run(now);
  }
  claim(plan: Plan, now: number): boolean {
    return this.db.prepare("UPDATE plans SET status = 'running' WHERE date = ? AND window_id = ? AND status = 'pending' AND scheduled_at <= ? AND ends_at > ?")
      .run(plan.date, plan.window_id, now, now).changes === 1;
  }
  acquire(now = Date.now()): boolean {
    // A job has bounded I/O timeouts; lease renewal also covers slow browser shutdowns.
    return this.db.prepare(`INSERT INTO job_lock VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE
      SET owner = excluded.owner, expires_at = excluded.expires_at WHERE job_lock.expires_at <= ?`)
      .run(this.owner, now + 15 * 60_000, now).changes === 1;
  }
  renew() { this.db.prepare('UPDATE job_lock SET expires_at = ? WHERE owner = ?').run(Date.now() + 15 * 60_000, this.owner); }
  release() { this.db.prepare('DELETE FROM job_lock WHERE owner = ?').run(this.owner); }
  close() { this.db.close(); }
}

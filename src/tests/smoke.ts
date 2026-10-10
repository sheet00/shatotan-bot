import { DatabaseSync } from "node:sqlite";
import { openBrowser } from "../browser.js";
import { PageLog } from "../pw-log.js";

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE posted_urls (url TEXT PRIMARY KEY)");
db.prepare("INSERT INTO posted_urls VALUES (?)").run(
  "https://example.com/article",
);
if (!db.prepare("SELECT url FROM posted_urls").get())
  throw new Error("SQLite failed");
db.close();
const browser = await openBrowser(true);
const log = new PageLog('smoke');
try {
  const page = await browser.newPage();
  await log.step(page, 'set-content', () => page.setContent("<title>Playwright ready</title>"));
  if ((await page.title()) !== "Playwright ready")
    throw new Error("Chromium failed");
  console.log("Chromium / SQLite OK");
} finally {
  console.log(`解析ログ: ${log.directory}`);
  await browser.close();
}

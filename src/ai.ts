import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import twitterText from "twitter-text";
import type { Config } from "./config.js";
import { dataDir } from "./browser.js";

export interface Article {
  title: string;
  url: string;
  rssUrl: string;
  publishedAt: string;
  body: string;
}

export interface WeatherInfo {
  url: string;
  comment: string;
  area: string;
  dateText: string;
  weather: string;
  maxTemp: number;
  minTemp: number;
  probPrecip: number;
  wind?: string;
  announceDatetime?: string;
}

export async function promptFor(
  article: Article,
): Promise<string> {
  const templates = await Promise.all([
    readFile(new URL("./prompts/system.md", import.meta.url), "utf8"),
    readFile(new URL("./prompts/news.md", import.meta.url), "utf8"),
  ]);
  const template = templates.map((text) => text.trim()).join("\n\n");
  const values = {
    commentLimit: String(Math.max(0, 280 - twitterText.parseTweet(`\n[${article.title.trim()}]\n${article.url}`).weightedLength)),
    article: JSON.stringify({
      title: article.title,
      publishedAt: article.publishedAt,
      body: article.body,
    }),
  };
  return template.replace(
    /\{\{(article|commentLimit)\}\}/g,
    (_, key: keyof typeof values) => values[key],
  );
}

export async function promptForWeather(
  weather: WeatherInfo,
): Promise<string> {
  const templates = await Promise.all([
    readFile(new URL("./prompts/system.md", import.meta.url), "utf8"),
    readFile(new URL("./prompts/weather.md", import.meta.url), "utf8"),
  ]);
  const template = templates.map((text) => text.trim()).join("\n\n");
  const commentLimit = "280";
  const weatherData = JSON.stringify(
    {
      targetArea: weather.area,
      targetDate: weather.dateText,
      forecast: {
        weather: weather.weather,
        maxTemp: `${weather.maxTemp}℃`,
        minTemp: `${weather.minTemp}℃`,
        probPrecip: `${weather.probPrecip}%`,
        wind: weather.wind,
      },
      overview: weather.comment,
    },
    null,
    2,
  );
  return template
    .replace(/\{\{commentLimit\}\}/g, commentLimit)
    .replace(/\{\{weatherData\}\}/g, weatherData);
}

export function validateDraft(raw: string, article: Article): string {
  const parsed = JSON.parse(
    raw
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim(),
  );
  if (
    typeof parsed.comment !== "string" ||
    !parsed.comment.trim() ||
    typeof parsed.evidence !== "string" ||
    parsed.evidence.trim().length < 12 ||
    !article.body.includes(parsed.evidence.trim())
  )
    throw new Error("生成文の形式または本文の根拠を確認できません。");
  const comment = parsed.comment.trim();
  if (/https?:\/\/|www\.|[@＠]/i.test(comment))
    throw new Error("感想に不要なURLやメンションが含まれています。");
  const title = article.title.trim();
  if (!title) throw new Error("記事タイトルがないため投稿文を作成できません。");
  const text = `${comment}\n[${title}]\n${article.url}`;
  if (!twitterText.parseTweet(text).valid)
    throw new Error(
      "生成文がXの文字数制限を超えるか、不正な文字を含んでいます。",
    );
  return text;
}

export function validateWeatherDraft(raw: string, weather: WeatherInfo): string {
  const parsed = JSON.parse(
    raw
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim(),
  );
  let comment = parsed.comment;
  if (typeof comment === "string" && comment.trim().startsWith("{")) {
    try {
      const inner = JSON.parse(comment);
      if (typeof inner.comment === "string") comment = inner.comment;
    } catch {}
  }
  if (typeof comment !== "string" || !comment.trim()) {
    throw new Error("生成文の形式を確認できません。");
  }
  comment = comment.trim();
  if (/https?:\/\/|www\.|[@＠]/i.test(comment)) {
    throw new Error("発言に不要なURLやメンションが含まれています。");
  }
  const text = comment;
  if (!twitterText.parseTweet(text).valid) {
    throw new Error("生成文がXの文字数制限を超えるか、不正な文字を含んでいます。");
  }
  return text;
}

async function runAiCli(
  prompt: string,
  schema: object | null,
  config: Config["ai"],
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "shatotan-ai-"));
  const output = join(cwd, "result.json");
  const codexHome = resolve(process.env.CODEX_HOME ?? join(dataDir, "codex"));
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const command =
    config.command ?? (config.provider === "codex" ? "codex" : "agy");
  const args =
    config.provider === "codex"
      ? [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "-o",
          output,
          "-",
        ]
      : [
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--disable-slash-commands",
          "--print-timeout",
          `${config.timeoutSeconds}s`,
          ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
        ];
  try {
    const raw = await new Promise<string>((resolveOutput, reject) => {
      // No shell interpolation; X credentials are not passed into the AI process.
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CODEX_HOME: codexHome,
          LANG: "C.UTF-8",
        },
      });
      let stdout = "";
      let stderr = "";
      let failure: Error | undefined;
      function stop(message: string) {
        failure = new Error(message);
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      const timer = setTimeout(
        () => stop("生成AIがタイムアウトしました。"),
        config.timeoutSeconds * 1000,
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 1_000_000) stop("生成AIの出力が大きすぎます。");
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.stdin.on("error", () => {
        /* exit/error reports failed input */
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`生成AI CLIを起動できません: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              `生成AIが失敗しました（終了コード ${code}）。CLIの認証・利用枠を確認してください。${/not logged|authentication|unauthorized|401/i.test(stderr) ? " 認証が必要です。" : ""}`,
            ),
          );
        else resolveOutput(stdout);
      });
      child.stdin.end(
        config.provider === "codex"
          ? prompt
          : `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
      );
    });
    if (config.provider === "codex")
      return await readFile(output, "utf8");
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const envelope = events.findLast(
      (event) => event.event === "result",
    )?.result;
    if (!envelope) throw new Error("Antigravityの最終生成結果がありません。");
    if (envelope.status !== "SUCCESS")
      throw new Error("Antigravityが正常な生成結果を返しませんでした。");
    return envelope.structured_output
      ? JSON.stringify(envelope.structured_output)
      : envelope.response;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function generate(
  article: Article,
  config: Config["ai"],
): Promise<string> {
  const prompt = await promptFor(article);
  const schema = {
    type: "object",
    properties: {
      comment: { type: "string" },
      evidence: { type: "string", minLength: 12 },
    },
    required: ["comment", "evidence"],
    additionalProperties: false,
  };
  const raw = await runAiCli(prompt, schema, config);
  return validateDraft(raw, article);
}

export async function generateWeather(
  weather: WeatherInfo,
  config: Config["ai"],
): Promise<string> {
  const prompt = await promptForWeather(weather);
  const schema = {
    type: "object",
    properties: {
      comment: { type: "string" },
    },
    required: ["comment"],
    additionalProperties: false,
  };
  const raw = await runAiCli(prompt, schema, config);
  return validateWeatherDraft(raw, weather);
}

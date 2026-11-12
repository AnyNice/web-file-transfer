import { appendFile, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// 轻量文件日志（2026-11-12）：按天落盘 logs/app-YYYY-MM-DD.log，保留 14 天，
// 同时镜像到控制台（生产日志文件里也能看到）。日志写失败绝不影响主流程。
// 行格式：2026-11-12 14:03:22.123 [INFO] [auth] 登录成功 ip=1.2.3.4

const LOG_DIR = join(process.cwd(), "logs");
const RETENTION_DAYS = 14;

export type LogLevel = "INFO" | "WARN" | "ERROR";

const pad = (n: number, l = 2) => String(n).padStart(l, "0");

export function logDay(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(d = new Date()): string {
  return `${logDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function logFilePath(date?: string): string {
  return join(LOG_DIR, `app-${date || logDay()}.log`);
}

let cleaned = false;
async function cleanupOld(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  try {
    const files = await readdir(LOG_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of files) {
      const m = f.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && new Date(`${m[1]}T00:00:00`).getTime() < cutoff) {
        await rm(join(LOG_DIR, f), { force: true });
      }
    }
  } catch { /* 忽略 */ }
}

function safeExtra(extra: unknown): string {
  if (extra === undefined) return "";
  try {
    return " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
  } catch {
    return " [unserializable]";
  }
}

export function log(level: LogLevel, tag: string, msg: string, extra?: unknown): void {
  const line = `${stamp()} [${level}] [${tag}] ${msg}${safeExtra(extra)}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
  void (async () => {
    try {
      if (!existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });
      await cleanupOld();
      await appendFile(logFilePath(), line + "\n", "utf-8");
    } catch { /* 日志失败不影响业务 */ }
  })();
}

export const logInfo = (tag: string, msg: string, extra?: unknown) => log("INFO", tag, msg, extra);
export const logWarn = (tag: string, msg: string, extra?: unknown) => log("WARN", tag, msg, extra);
export const logError = (tag: string, msg: string, extra?: unknown) => log("ERROR", tag, msg, extra);

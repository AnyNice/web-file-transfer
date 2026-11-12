import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { isAbsolute, join, resolve } from "path";

// 运行设置（data/settings.json）：目前只有服务器中转目录 storageDir。
// 未配置时用默认目录 <项目>/uploads。管理员可在页面顶栏「管理」里修改。
// 读取按文件 mtime 缓存，改设置后即时生效、无需重启。

const DATA_DIR = join(process.cwd(), "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

export const DEFAULT_STORAGE_DIR = join(process.cwd(), "uploads");

interface Settings {
  storageDir?: string;
}

let cache: { mtimeMs: number; settings: Settings } | null = null;

function readSettings(): Settings {
  try {
    const st = statSync(SETTINGS_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.settings;
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Settings;
    cache = { mtimeMs: st.mtimeMs, settings: parsed && typeof parsed === "object" ? parsed : {} };
    return cache.settings;
  } catch {
    return {};
  }
}

/** 当前生效的中转目录（绝对路径） */
export function getStorageDir(): string {
  const s = readSettings().storageDir;
  if (s && isAbsolute(s)) return resolve(s);
  return DEFAULT_STORAGE_DIR;
}

/** 管理员显式配置的目录；未配置（用默认）时为 null */
export function getConfiguredStorageDir(): string | null {
  const s = readSettings().storageDir;
  return s && isAbsolute(s) ? resolve(s) : null;
}

export function setStorageDir(dir: string | null): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const next: Settings = dir ? { storageDir: resolve(dir) } : {};
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf-8");
  cache = null;
}

/** 确保中转目录存在并返回它 */
export function ensureStorageDir(): string {
  const dir = getStorageDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* 调用方会在读写时拿到真实错误 */ }
  return dir;
}

/** 校验目录可作中转目录：必须绝对路径、可创建、可写。返回错误文案或 null */
export function validateStorageDir(dir: string): string | null {
  const trimmed = (dir || "").trim();
  if (!trimmed) return "目录不能为空";
  if (!isAbsolute(trimmed)) return "必须是绝对路径（如 E:\\文件暂存 或 /data/files）";
  const abs = resolve(trimmed);
  try {
    mkdirSync(abs, { recursive: true });
  } catch (e) {
    return `无法创建该目录：${e instanceof Error ? e.message : String(e)}`;
  }
  const probe = join(abs, `.wft-probe-${Date.now()}`);
  try {
    writeFileSync(probe, "ok", "utf-8");
    rmSync(probe, { force: true });
  } catch (e) {
    return `目录不可写：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!existsSync(abs)) return "目录不存在";
  return null;
}

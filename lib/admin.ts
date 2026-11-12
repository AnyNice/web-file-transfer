import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

// 管理员鉴权：与普通访问口令分开的第二道口令。
// 来源：环境变量 ADMIN_CODE；未设置时首次使用自动生成 8 位数字，存 data/admin-code.txt
// （主机上打开文件查看）。会话 cookie wft_admin，值为管理员口令的 HMAC，不存明文。

export const ADMIN_COOKIE = "wft_admin";

const DATA_DIR = join(process.cwd(), "data");
const ADMIN_FILE = join(DATA_DIR, "admin-code.txt");

let cachedCode: string | null = null;

export function getAdminCode(): string {
  const env = (process.env.ADMIN_CODE || "").trim();
  if (env) return env;
  if (cachedCode) return cachedCode;
  try {
    if (existsSync(ADMIN_FILE)) {
      const fromFile = readFileSync(ADMIN_FILE, "utf8").trim();
      if (fromFile) {
        cachedCode = fromFile;
        return cachedCode;
      }
    }
  } catch { /* fall through */ }
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ADMIN_FILE, code + "\n", "utf8");
  } catch { /* 内存兜底 */ }
  cachedCode = code;
  return code;
}

export function adminSessionToken(): string {
  return createHmac("sha256", "wft-admin-v1").update(getAdminCode()).digest("hex");
}

export function checkAdminCode(input: unknown): boolean {
  if (typeof input !== "string" || !input) return false;
  const expected = Buffer.from(getAdminCode(), "utf8");
  const actual = Buffer.from(input.trim(), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function isAdminFromCookieHeader(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  const expected = adminSessionToken();
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === ADMIN_COOKIE) {
      const v = rest.join("=").trim();
      const a = Buffer.from(v, "utf8");
      const b = Buffer.from(expected, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    }
  }
  return false;
}

/** 管理员路由守卫：先普通登录（401），再管理员会话（403 + adminRequired） */
export function requireAdmin(req: { headers: { get(name: string): string | null } }): Response | null {
  const denied = requireAuth(req);
  if (denied) return denied;
  if (!isAdminFromCookieHeader(req.headers.get("cookie"))) {
    return NextResponse.json({ error: "需要管理员登录", adminRequired: true }, { status: 403 });
  }
  return null;
}

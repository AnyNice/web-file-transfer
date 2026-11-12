// 访问口令鉴权（服务端）
// 口令来源：环境变量 ACCESS_CODE；未设置时首次使用自动生成 6 位数字口令，
// 存放在 data/access-code.txt（主机上可直接打开查看，改口令改这个文件或设环境变量后重启）。
// 会话：登录成功后下发 httpOnly cookie，值为口令的 HMAC-SHA256，不存明文口令。
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const AUTH_COOKIE = "wft_auth";

const DATA_DIR = join(process.cwd(), "data");
const CODE_FILE = join(DATA_DIR, "access-code.txt");

let cachedCode: string | null = null;

export function getAccessCode(): string {
  const env = (process.env.ACCESS_CODE || "").trim();
  if (env) return env;
  if (cachedCode) return cachedCode;
  try {
    if (existsSync(CODE_FILE)) {
      const fromFile = readFileSync(CODE_FILE, "utf8").trim();
      if (fromFile) {
        cachedCode = fromFile;
        return cachedCode;
      }
    }
  } catch { /* fall through to generate */ }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CODE_FILE, code + "\n", "utf8");
  } catch { /* 内存兜底 */ }
  cachedCode = code;
  console.log(`[wft] 本机访问口令: ${code}（保存在 data/access-code.txt，可修改）`);
  return code;
}

export function sessionToken(): string {
  return createHmac("sha256", "wft-session-v1").update(getAccessCode()).digest("hex");
}

export function checkCode(input: unknown): boolean {
  if (typeof input !== "string" || !input) return false;
  const expected = Buffer.from(getAccessCode(), "utf8");
  const actual = Buffer.from(input.trim(), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function isAuthedFromCookieHeader(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  const expected = sessionToken();
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === AUTH_COOKIE) {
      const v = rest.join("=").trim();
      const a = Buffer.from(v, "utf8");
      const b = Buffer.from(expected, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    }
  }
  return false;
}

/** 路由内鉴权（Node runtime）：未登录返回 401 响应，已登录返回 null */
export function requireAuth(req: { headers: { get(name: string): string | null } }): Response | null {
  if (isAuthedFromCookieHeader(req.headers.get("cookie"))) return null;
  return new Response(JSON.stringify({ error: "未登录或口令已失效", needAuth: true }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

// 简单的登录爆破限速：同一 IP 5 分钟内失败 >= 10 次则拒绝
const failMap = new Map<string, { count: number; resetAt: number }>();
export function loginRateLimited(ip: string): boolean {
  const rec = failMap.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    failMap.delete(ip);
    return false;
  }
  return rec.count >= 10;
}
export function recordLoginFailure(ip: string) {
  const now = Date.now();
  const rec = failMap.get(ip);
  if (!rec || now > rec.resetAt) {
    failMap.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
  } else {
    rec.count += 1;
  }
}
export function recordLoginSuccess(ip: string) {
  failMap.delete(ip);
}

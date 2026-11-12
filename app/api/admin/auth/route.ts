import { NextRequest, NextResponse } from "next/server";
import { loginRateLimited, recordLoginFailure, recordLoginSuccess, requireAuth } from "@/lib/auth";
import { ADMIN_COOKIE, adminSessionToken, checkAdminCode, getAdminCode, isAdminFromCookieHeader } from "@/lib/admin";
import { logInfo, logWarn } from "@/lib/log";

export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

// 管理员登录状态查询（需普通登录）：{ admin: boolean }
export async function GET(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;
  getAdminCode(); // 首次查询即生成管理员口令文件，方便主机查看
  return NextResponse.json({ admin: isAdminFromCookieHeader(req.headers.get("cookie")) });
}

export async function POST(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const ip = clientIp(req);
  if (loginRateLimited(ip)) {
    logWarn("admin", `管理员登录尝试过多被限速 ip=${ip}`);
    return NextResponse.json({ error: "尝试次数过多，请 5 分钟后再试" }, { status: 429 });
  }
  let code = "";
  try {
    const body = await req.json();
    code = typeof body?.code === "string" ? body.code : "";
  } catch { /* invalid body */ }
  if (!checkAdminCode(code)) {
    recordLoginFailure(ip);
    logWarn("admin", `管理员口令错误 ip=${ip}`);
    return NextResponse.json({ error: "管理员口令不正确" }, { status: 401 });
  }
  recordLoginSuccess(ip);
  logInfo("admin", `管理员登录成功 ip=${ip}`);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, adminSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 3600,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  checkCode,
  getAccessCode,
  isAuthedFromCookieHeader,
  loginRateLimited,
  recordLoginFailure,
  recordLoginSuccess,
  sessionToken,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

export async function GET(req: NextRequest) {
  getAccessCode(); // 确保口令文件在首次打开页面时就生成，主机上可查
  const authed = isAuthedFromCookieHeader(req.headers.get("cookie"));
  return NextResponse.json({ authed, required: true });
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (loginRateLimited(ip)) {
    return NextResponse.json(
      { error: "尝试次数过多，请 5 分钟后再试" },
      { status: 429 }
    );
  }
  let code = "";
  try {
    const body = await req.json();
    code = typeof body?.code === "string" ? body.code : "";
  } catch { /* invalid body */ }
  if (!checkCode(code)) {
    recordLoginFailure(ip);
    return NextResponse.json({ error: "口令不正确" }, { status: 401 });
  }
  recordLoginSuccess(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 3600,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

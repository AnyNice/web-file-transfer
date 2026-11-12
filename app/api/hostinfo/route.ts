import { NextRequest, NextResponse } from "next/server";
import os from "os";
import { getAccessCode, requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 已登录用户可见的主机信息：访问口令 + 本机局域网地址列表
// （顶栏「口令」弹层与「二维码」弹层用；未登录一律 401，不泄露）
export async function GET(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const port = req.nextUrl.port || "3000";
  const lanUrls: string[] = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) {
        lanUrls.push(`http://${n.address}:${port}`);
      }
    }
  }
  return NextResponse.json({ accessCode: getAccessCode(), lanUrls });
}

import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "crypto";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/auth";
import { logInfo, logWarn } from "@/lib/log";

// P2P 信令（2026-11-12 重写）
// 旧实现的问题：host-create 只写内存不落盘（重启即丢）、过期判断用文件整体时间
// 而非每个房间自己的创建时间、惰性加载是死代码、TTL 只有 30 秒手输码来不及、
// 邀请码不查重复可能覆盖他人房间、猜码无限速。
// 新实现：每次请求从磁盘加载、变更即原子落盘；房间按各自 createdAt 计 10 分钟
// TTL；邀请码生成查重；guest-join 按 IP 限速猜码。

export const dynamic = "force-dynamic";

interface Room {
  code: string;
  offer: string;
  answer?: string;
  createdAt: number;
  hostId?: string; // 建房浏览器的 clientId，用于拒绝「连自己的码」
}

const ROOM_TTL_MS = 10 * 60_000; // 10 分钟，与前端轮询超时一致
const STORE_FILE = path.join(process.cwd(), "p2p-rooms.json");

function loadStore(): Map<string, Room> {
  const m = new Map<string, Room>();
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as {
        rooms: Record<string, Room>;
      };
      const now = Date.now();
      for (const [k, v] of Object.entries(raw.rooms || {})) {
        if (v && typeof v.createdAt === "number" && now - v.createdAt < ROOM_TTL_MS) {
          m.set(k, v);
        }
      }
    }
  } catch { /* 文件损坏则按空处理 */ }
  return m;
}

function saveStore(m: Map<string, Room>) {
  try {
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rooms: Object.fromEntries(m) }), "utf8");
    fs.renameSync(tmp, STORE_FILE);
  } catch { /* best-effort */ }
}

function genCode(m: Map<string, Room>): string {
  for (let i = 0; i < 20; i++) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!m.has(code)) return code;
  }
  // 极小概率连续冲突：用时间戳尾数兜底
  return String(Date.now() % 1_000_000).padStart(6, "0");
}

// 猜码限速：同一 IP 10 分钟内 guest-join 失败 >= 30 次 → 429
const guessFail = new Map<string, { count: number; resetAt: number }>();
function guessLimited(ip: string): boolean {
  const rec = guessFail.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    guessFail.delete(ip);
    return false;
  }
  return rec.count >= 30;
}
function recordGuessFail(ip: string) {
  const now = Date.now();
  const rec = guessFail.get(ip);
  if (!rec || now > rec.resetAt) guessFail.set(ip, { count: 1, resetAt: now + 10 * 60_000 });
  else rec.count += 1;
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

export async function POST(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const { action, code, sdp, clientId } = body as { action?: string; code?: string; sdp?: string; clientId?: string };
  const normalized = (code || "").toUpperCase().trim();
  const rooms = loadStore();
  const ip = clientIp(req);

  if (action === "host-create") {
    if (!sdp) return NextResponse.json({ error: "缺少 offer" }, { status: 400 });
    const newCode = genCode(rooms);
    rooms.set(newCode, { code: newCode, offer: sdp, createdAt: Date.now(), hostId: clientId || undefined });
    saveStore(rooms);
    logInfo("p2p", `建房 code=${newCode} ip=${ip}`);
    return NextResponse.json({ code: newCode, ttlMs: ROOM_TTL_MS });
  }

  if (action === "guest-join") {
    if (guessLimited(ip)) {
      logWarn("p2p", `猜码过多被限速 ip=${ip}`);
      return NextResponse.json({ error: "尝试次数过多，请稍后再试" }, { status: 429 });
    }
    const entry = rooms.get(normalized);
    if (!entry) {
      recordGuessFail(ip);
      logWarn("p2p", `无效邀请码 code=${normalized} ip=${ip}`);
      return NextResponse.json({ error: "邀请码无效或已过期" }, { status: 404 });
    }
    if (entry.hostId && clientId && entry.hostId === clientId) {
      logWarn("p2p", `拒绝自连 code=${normalized} ip=${ip}`);
      return NextResponse.json({ error: "这是你自己生成的邀请码，不能连接自己" }, { status: 403 });
    }
    return NextResponse.json({ offer: entry.offer });
  }

  if (action === "guest-answer") {
    const entry = rooms.get(normalized);
    if (!entry) return NextResponse.json({ error: "邀请码无效或已过期" }, { status: 404 });
    if (!sdp) return NextResponse.json({ error: "缺少 answer" }, { status: 400 });
    entry.answer = sdp;
    saveStore(rooms);
    return NextResponse.json({ ok: true });
  }

  if (action === "host-poll") {
    const entry = rooms.get(normalized);
    if (!entry) return NextResponse.json({ error: "邀请码无效或已过期" }, { status: 404 });
    if (entry.answer) {
      const ans = entry.answer;
      rooms.delete(normalized);
      saveStore(rooms);
      logInfo("p2p", `配对成功 code=${normalized}`);
      return NextResponse.json({ joined: true, answer: ans });
    }
    return NextResponse.json({ joined: false, expiresInMs: ROOM_TTL_MS - (Date.now() - entry.createdAt) });
  }

  if (action === "host-cancel") {
    rooms.delete(normalized);
    saveStore(rooms);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

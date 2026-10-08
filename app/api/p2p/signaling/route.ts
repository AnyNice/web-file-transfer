import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// 信令存储：邀请码 → 房间状态（落盘持久化，跨热重载保留）
interface Room {
  code: string;
  offer: string;      // host 的 SDP offer
  answer?: string;    // guest 的 SDP answer
  createdAt: number;
}

const ROOM_TTL_MS = 30_000; // host 创建后 30s 内未连上即过期
const STORE_FILE = path.join(process.cwd(), "p2p-rooms.json");

function loadStore(): Map<string, Room> {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as { now: number; rooms: Record<string, Room> };
      const m = new Map<string, Room>();
      for (const [k, v] of Object.entries(raw.rooms)) {
        if (raw.now + ROOM_TTL_MS >= Date.now()) m.set(k, v);
      }
      return m;
    }
  } catch { /* 文件损坏则忽略 */ }
  return new Map<string, Room>();
}

function saveStore(m: Map<string, Room>) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ now: Date.now(), rooms: Object.fromEntries(m) }), "utf8");
  } catch { /* best-effort */ }
}

const rooms = loadStore();

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(req: NextRequest) {
  const now = Date.now();
  // 惰性清理过期房间
  for (const [c, r] of rooms) {
    if (now - r.createdAt > ROOM_TTL_MS) rooms.delete(c);
  }
  const body = await req.json();
  const { action, code, sdp } = body as {
    action: string;
    code?: string;
    sdp?: string;
  };
  const normalized = (code || "").toUpperCase().trim();

  // 发送方：创建房间，拿到 6 位邀请码
  if (action === "host-create") {
    if (!sdp) return NextResponse.json({ error: "缺少 offer" }, { status: 400 });
    const newCode = genCode();
    rooms.set(newCode, { code: newCode, offer: sdp, createdAt: Date.now() });
    return NextResponse.json({ code: newCode });
  }

  // 接收方：凭邀请码拉取 offer
  if (action === "guest-join") {
    let entry = rooms.get(normalized);
    if (!entry) {
      // 惰性加载：跨进程重启后从磁盘恢复
      for (const [c, r] of rooms) if (c === normalized) entry = r;
      if (!entry) {
        return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
      }
    }
    return NextResponse.json({ offer: entry.offer });
  }

  // 接收方：回传自己的 answer
  if (action === "guest-answer") {
    const entry = rooms.get(normalized);
    if (!entry) {
      return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
    }
    if (!sdp) return NextResponse.json({ error: "缺少 answer" }, { status: 400 });
    entry.answer = sdp;
    saveStore(rooms);
    return NextResponse.json({ ok: true });
  }

  // 发送方：轮询，直到拿到 guest 的 answer
  if (action === "host-poll") {
    let entry = rooms.get(normalized);
    if (!entry) {
      // 惰性加载：跨进程重启后从磁盘恢复
      for (const [c, r] of rooms) if (c === normalized) entry = r;
      if (!entry) {
        return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
      }
    }
    if (entry.answer) {
      const ans = entry.answer;
      rooms.delete(normalized);
      saveStore(rooms);
      return NextResponse.json({ joined: true, answer: ans });
    }
    return NextResponse.json({ joined: false });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

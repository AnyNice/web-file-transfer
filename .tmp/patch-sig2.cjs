const fs = require("fs");
const p = "app/api/p2p/signaling/route.ts";
let s = fs.readFileSync(p, "utf8");
function rep(a, b) { if (!s.includes(a)) { console.error("MISS: " + a.slice(0, 60)); process.exit(1); } s = s.replace(a, b); }

rep(
  `import { NextRequest, NextResponse } from "next/server";

// 内存信令存储：邀请码 → 房间状态
interface Room {
  code: string;
  offer: string;      // host 的 SDP offer
  answer?: string;    // guest 的 SDP answer
  createdAt: number;
  lastAccess: number;
}`,
  `import { NextRequest, NextResponse } from "next/server";
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
}`
);

rep(
  `const ROOM_TTL_MS = 30_000;
const rooms = new Map<string, Room>();
const TTL_MS = 5 * 60 * 1000;

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function pruneStale() {
  const now = Date.now();
  for (const [c, r] of rooms) {
    if (now - r.lastAccess > TTL_MS) rooms.delete(c);
  }
}

function touch(code: string) {
  const r = rooms.get(code);
  if (r) r.lastAccess = Date.now();
}

export async function POST(req: NextRequest) {
  pruneStale();`,
  `const rooms = loadStore();

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(req: NextRequest) {
  const now = Date.now();
  // 惰性清理过期房间
  for (const [c, r] of rooms) {
    if (now - r.createdAt > ROOM_TTL_MS) rooms.delete(c);
  }`
);

rep(
  `    const entry = rooms.get(normalized);
    if (!entry) {
      return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
    }
    touch(normalized);
    return NextResponse.json({ offer: entry.offer });`,
  `    let entry = rooms.get(normalized);
    if (!entry) {
      // 惰性加载：跨进程重启后从磁盘恢复
      for (const [c, r] of rooms) if (c === normalized) entry = r;
      if (!entry) {
        return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
      }
    }
    return NextResponse.json({ offer: entry.offer });`
);

rep(
  `    if (!entry) {
      return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
    }
    if (!sdp) return NextResponse.json({ error: "缺少 answer" }, { status: 400 });
    entry.answer = sdp;
    touch(normalized);
    return NextResponse.json({ ok: true });`,
  `    if (!entry) {
      return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
    }
    if (!sdp) return NextResponse.json({ error: "缺少 answer" }, { status: 400 });
    entry.answer = sdp;
    saveStore(rooms);
    return NextResponse.json({ ok: true });`
);

rep(
  `    const entry = rooms.get(normalized);
    if (!entry) {
      return NextResponse.json({ error: "邀请码无效" }, { status: 404 });
    }
    touch(normalized);
    if (entry.answer) {
      return NextResponse.json({ joined: true, answer: entry.answer });
    }
    return NextResponse.json({ joined: false });`,
  `    let entry = rooms.get(normalized);
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
    return NextResponse.json({ joined: false });`
);

fs.writeFileSync(p, s, "utf8");
console.log("OK: signaling persisted, 30s room TTL");

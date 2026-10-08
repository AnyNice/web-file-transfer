const fs = require("fs");

// ── webrtc.ts: host 侧 30s 无 guest-answer 时房间自动过期 ──
let w = fs.readFileSync("lib/webrtc.ts", "utf8");
const oldPoll = `      const data = await res.json();
      if (res.ok && data.joined && data.answer) {
        await this.applyRemoteSdp(data.answer);
        this.startKeepAlive();
        this._onStatus?.("连接已建立");
        return;
      }
      if (res.status === 404) {
        throw new Error("房间已过期，请重新生成邀请码");
      }
      if (!res.ok) throw new Error(data.error || "轮询失败");
      await new Promise((r) => setTimeout(r, 1500));`;
const newPoll = `      const data = await res.json();
      if (res.ok && data.joined && data.answer) {
        await this.applyRemoteSdp(data.answer);
        this.startKeepAlive();
        this._onStatus?.("连接已建立");
        return;
      }
      if (res.status === 404) {
        throw new Error("房间已过期，请重新生成邀请码");
      }
      if (!res.ok) throw new Error(data.error || "轮询失败");
      // 30 秒内无人连接 → 主动放弃（避免无限空转）
      if (Date.now() - startedAt > 30000) {
        throw new Error("等待连接超时（30秒），请重新生成邀请码");
      }
      await new Promise((r) => setTimeout(r, 1500));`;
if (!w.includes(oldPoll)) { console.error("MISS webrtc poll"); process.exit(1); }
w = w.replace(oldPoll, newPoll);
w = w.replace("    this.isHost = true;\n    const offerSdp = await this.makeOffer();",
              "    this.isHost = true;\n    const startedAt = Date.now();\n    const offerSdp = await this.makeOffer();");
fs.writeFileSync("lib/webrtc.ts", w, "utf8");

// ── signaling route: host-create 带 30s TTL 并落盘 ──
const sigPath = "app/api/p2p/signaling/route.ts";
let s = fs.readFileSync(sigPath, "utf8");
s = s.replace(`const rooms: Map<string, Room> = new Map();`,
`// ── 持久化（跨热重载保留房间）──
import fs from "fs";
import path from "path";

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
  } catch { /* corrupt */ }
  return new Map();
}

function saveStore(m: Map<string, Room>) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ now: Date.now(), rooms: Object.fromEntries(m) }), "utf8");
  } catch { /* best-effort */ }
}

const rooms = loadStore();`);
if (!s.includes("const ROOM_TTL_MS")) {
  s = s.replace("const rooms", "const ROOM_TTL_MS = 30_000;\nconst rooms", 1);
}
// host-create TTL 改为 30s
s = s.replace(`rooms.set(code, {
    offer: sdp,
    answer: null,
    expires: Date.now() + 5 * 60 * 1000,
  });`, `rooms.set(code, {
    offer: sdp,
    answer: null,
    expires: Date.now() + ROOM_TTL_MS,
  });
  saveStore(rooms);`);
// guest-answer
s = s.replace(`  if (action === "guest-answer") {
    const room = rooms.get(code);
    if (!room || room.answer) return json({ error: "房间不存在或已失效" }, 404);
    room.answer = sdp;
    return json({ ok: true });
  }`, `  if (action === "guest-answer") {
    const room = rooms.get(code);
    if (!room || room.answer) return json({ error: "房间不存在或已失效" }, 404);
    room.answer = sdp;
    saveStore(rooms);
    return json({ ok: true });
  }`);
// host-poll
s = s.replace(`  if (action === "host-poll") {
    const room = rooms.get(code);
    if (!room) return json({ joined: false });
    if (room.answer) {
      const ans = room.answer;
      rooms.delete(code);
      return json({ joined: true, answer: ans });
    }
    return json({ joined: false });
  }`, `  if (action === "host-poll") {
    const room = rooms.get(code);
    if (!room) {
      return new Response(JSON.stringify({ joined: false, error: "房间已过期" }), { status: 404 });
    }
    if (room.answer) {
      const ans = room.answer;
      rooms.delete(code);
      saveStore(rooms);
      return json({ joined: true, answer: ans });
    }
    return json({ joined: false });
  }`);
fs.writeFileSync(sigPath, s, "utf8");
console.log("OK: persistence + 30s TTL patched");

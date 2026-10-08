const fs = require("fs");
function fix(p, pairs) {
  let s = fs.readFileSync(p, "utf8");
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { console.error("MISS in " + p + ": " + a.slice(0, 60)); process.exit(1); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s, "utf8");
}
fix("lib/webrtc.ts", [
  [
    "    this.isHost = true;\n    const startedAt = Date.now();\n    const offerSdp = await this.makeOffer();",
    "    this.isHost = true;\n    const offerSdp = await this.makeOffer();"
  ],
  [
    "  async pollUntilConnected(): Promise<void> {\n    while (true) {",
    "  async pollUntilConnected(): Promise<void> {\n    const startedAt = Date.now();\n    while (true) {"
  ]
]);
fix("app/api/p2p/signaling/route.ts", [
  [
    "rooms.set(newCode, { code: newCode, offer: sdp, createdAt: Date.now(), lastAccess: Date.now() });",
    "rooms.set(newCode, { code: newCode, offer: sdp, createdAt: Date.now() });"
  ]
]);
console.log("OK");

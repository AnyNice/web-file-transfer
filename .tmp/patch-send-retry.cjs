const fs = require("fs");
const p = "components/TransferApp.tsx";
let s = fs.readFileSync(p, "utf8");
// CRLF-aware helper
function rep(a, b) {
  const cand = [a.replace(/\n/g, "\r\n"), a];
  for (const c of cand) {
    if (s.includes(c)) { s = s.replace(c, b.replace(/\n/g, "\r\n")); return; }
  }
  console.error("MISS: " + a.slice(0, 60)); process.exit(1);
}
rep(
`    for (let i = 0; i < localFiles.length; i++) {
      const file = localFiles[i];
      try {
        await conn.sendFile(file, i);
      } catch (err) {
        console.error("[P2P] 文件发送失败:", file.name, err);
        p2pErrorRef.current = \`文件发送失败: \${file.name}（\${String(err)}）\`;
        setP2pError(p2pErrorRef.current);
        setP2pSending(false);
        p2pStatusRef.current = "connected"; setP2pStatus("connected");
        setP2pStatusText("发送中断，可重新发送");
        return;
      }
    }`,
`    for (let i = 0; i < localFiles.length; i++) {
      const file = localFiles[i];
      try {
        await conn.sendFile(file, i);
      } catch (err) {
        // 网络瞬断自愈重试：再等通道最多 8s，重发整个文件一次
        let recovered = false;
        if (!p2pErrorRef.current || p2pErrorRef.current === "连接波动，正在自动恢复…") {
          try {
            await conn.waitForDataChannel();
            await conn.sendFile(file, i);
            recovered = true;
          } catch { /* 仍失败则走下方报错 */ }
        }
        if (!recovered) {
          console.error("[P2P] 文件发送失败:", file.name, err);
          p2pErrorRef.current = \`文件发送失败: \${file.name}（\${String(err)}）\`;
          setP2pError(p2pErrorRef.current);
          setP2pSending(false);
          p2pStatusRef.current = "connected"; setP2pStatus("connected");
          setP2pStatusText("发送中断，可重新发送");
          return;
        }
      }
    }`
);
fs.writeFileSync(p, s, "utf8");
console.log("OK: send retry patched");

const fs = require("fs");
const p = "components/TransferApp.tsx";
let s = fs.readFileSync(p, "utf8");
// Normalize newlines to \n in memory; write back with CRLF
s = s.replace(/\r\n/g, "\n");
const a = `    for (let i = 0; i < localFiles.length; i++) {
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
    }`;
const b = `    for (let i = 0; i < localFiles.length; i++) {
      const file = localFiles[i];
      try {
        await conn.sendFile(file, i);
      } catch (err) {
        // 网络瞬断自愈重试：再等通道最多 8s，重发整个文件一次
        let recovered = false;
        try {
          await conn.waitForDataChannel();
          await conn.sendFile(file, i);
          recovered = true;
        } catch { /* 仍失败则走下方报错 */ }
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
    }`;
if (!s.includes(a)) { console.error("MISS send loop"); process.exit(1); }
s = s.replace(a, b);
// 保持原文件的 CRLF 行尾风格
s = s.replace(/\n/g, "\r\n");
fs.writeFileSync(p, s, "utf8");
console.log("OK: send retry patched");

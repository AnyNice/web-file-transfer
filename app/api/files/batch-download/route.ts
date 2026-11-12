import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { basename } from "path";
import { Readable } from "stream";
import { requireAuth } from "@/lib/auth";
import { resolveSafePath } from "@/lib/serverfs";
import { collectEntries, zipStream, type ZipEntry } from "@/lib/zipstream";
import { logInfo, logWarn } from "@/lib/log";

export const dynamic = "force-dynamic";

// 批量打包下载：GET ?p=路径1&p=路径2…（文件与文件夹可混选）
// 文件以原名置于 ZIP 根，文件夹保留目录结构；重名自动加 _1 后缀。
// 流式输出（STORE + ZIP64），不落盘不占内存。
export async function GET(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const paths = req.nextUrl.searchParams.getAll("p").filter((p) => p.trim().length > 0);
  if (paths.length === 0) {
    return NextResponse.json({ error: "未选择文件" }, { status: 400 });
  }

  const usedBase = new Map<string, number>();
  const entries: ZipEntry[] = [];
  for (const rel of paths) {
    const abs = resolveSafePath(rel);
    if (!abs) {
      logWarn("files", `批量下载拒绝越界路径 ${rel}`);
      return NextResponse.json({ error: `路径不合法：${rel}` }, { status: 400 });
    }
    let s;
    try {
      s = await stat(abs);
    } catch {
      return NextResponse.json({ error: `不存在：${rel}` }, { status: 404 });
    }
    let base = basename(abs);
    const seen = usedBase.get(base) || 0;
    usedBase.set(base, seen + 1);
    if (seen > 0) {
      if (!s.isDirectory()) {
        const dot = base.lastIndexOf(".");
        base = dot > 0 ? `${base.slice(0, dot)}_${seen}${base.slice(dot)}` : `${base}_${seen}`;
      } else {
        base = `${base}_${seen}`;
      }
    }
    if (s.isDirectory()) {
      const sub = await collectEntries(abs);
      for (const e of sub) entries.push({ ...e, rel: `${base}/${e.rel}` });
    } else if (s.isFile()) {
      entries.push({ rel: base, abs, size: s.size, mtime: s.mtime });
    }
  }
  if (entries.length === 0) {
    return NextResponse.json({ error: "所选内容为空" }, { status: 400 });
  }

  logInfo("files", `批量打包下载 ${paths.join(", ")} 共 ${entries.length} 个文件`);
  const stream = Readable.from(zipStream(entries));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("批量下载.zip")}`,
    },
  });
}

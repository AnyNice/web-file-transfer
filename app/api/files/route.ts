import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "fs/promises";
import { join, relative } from "path";
import { existsSync } from "fs";
import { requireAuth } from "@/lib/auth";
import { ensureStorageDir } from "@/lib/settings";

export const dynamic = "force-dynamic";

export interface FileEntryOut {
  name: string;
  type: "file" | "folder";
  path: string; // 相对 uploads 的路径，使用 / 分隔
  size: number;
  modified: string;
  children?: FileEntryOut[];
}

async function walk(dir: string, root: string): Promise<FileEntryOut[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: FileEntryOut[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".upload-")) continue; // 上传中的临时文件不展示
    const full = join(dir, entry.name);
    const rel = relative(root, full).split("\\").join("/");
    try {
      const s = await stat(full);
      if (entry.isDirectory()) {
        out.push({
          name: entry.name,
          type: "folder",
          path: rel,
          size: 0,
          modified: s.mtime.toISOString(),
          children: await walk(full, root),
        });
      } else if (entry.isFile()) {
        out.push({
          name: entry.name,
          type: "file",
          path: rel,
          size: s.size,
          modified: s.mtime.toISOString(),
        });
      }
    } catch { /* 忽略读取失败的条目 */ }
  }
  // 文件夹在前，再按名称排序
  out.sort((a, b) =>
    a.type !== b.type ? (a.type === "folder" ? -1 : 1) : a.name.localeCompare(b.name)
  );
  return out;
}

export async function GET(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;
  try {
    const root = ensureStorageDir();
    if (!existsSync(root)) return NextResponse.json({ files: [] });
    const files = await walk(root, root);
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

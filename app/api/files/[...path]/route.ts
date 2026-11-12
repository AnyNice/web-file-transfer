import { NextRequest, NextResponse } from "next/server";
import { stat, rm } from "fs/promises";
import { basename } from "path";
import { existsSync, createReadStream } from "fs";
import { Readable } from "stream";
import { requireAuth } from "@/lib/auth";
import { logError, logInfo, logWarn } from "@/lib/log";
import { resolveSafePath } from "@/lib/serverfs";
import { collectEntries, zipStream } from "@/lib/zipstream";

export const dynamic = "force-dynamic";

// 文件下载（支持 Range 断点/分段）与删除。路径为 catch-all，支持多级目录。
// 2026-11-12 重写：旧版是单段 [path] 且无 Range，嵌套文件取不到、大文件
// 不能续传/拖动，浏览器端只能整包拉进内存。

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  rar: "application/x-rar-compressed",
  "7z": "application/x-7z-compressed",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  iso: "application/x-iso9660-image",
  gz: "application/gzip",
  tar: "application/x-tar",
  exe: "application/octet-stream",
  dmg: "application/octet-stream",
};

function resolveFromParams(parts: string[]): string | null {
  const decoded = parts.map((p) => decodeURIComponent(p)).join("/");
  return resolveSafePath(decoded);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const { path: parts } = await params;
  const filePath = resolveFromParams(parts);
  if (!filePath) {
    logWarn("files", `拒绝越界路径 /${parts.join("/")}`);
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!existsSync(filePath)) return NextResponse.json({ error: "File not found" }, { status: 404 });

  const s = await stat(filePath);
  if (s.isDirectory()) {
    // 文件夹打包下载：流式 ZIP(ZIP64)，边打边传，不落盘不占内存
    const entries = await collectEntries(filePath);
    logInfo("files", `打包下载 ${parts.join("/")} 共 ${entries.length} 项`);
    const zipName = `${basename(filePath) || "files"}.zip`;
    const stream = Readable.from(zipStream(entries));
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      },
    });
  }
  if (!s.isFile()) return NextResponse.json({ error: "Not a file" }, { status: 400 });

  const total = s.size;
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const name = basename(filePath);
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Accept-Ranges": "bytes",
    "Last-Modified": s.mtime.toUTCString(),
    ETag: `"${total}-${Math.floor(s.mtimeMs)}"`,
  };

  const range = req.headers.get("range");
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m) {
      return new Response("Invalid Range", {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    let start = m[1] === "" ? 0 : parseInt(m[1], 10);
    let end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
    if (m[1] === "" && m[2] !== "") {
      // 后缀范围：最后 N 字节
      const n = parseInt(m[2], 10);
      start = Math.max(0, total - n);
      end = total - 1;
    }
    if (start > end || start >= total) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    end = Math.min(end, total - 1);
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    headers: { ...headers, "Content-Length": String(total) },
  });
}

export async function HEAD(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const { path: parts } = await params;
  const filePath = resolveFromParams(parts);
  if (!filePath || !existsSync(filePath)) return new Response(null, { status: 404 });
  const s = await stat(filePath);
  if (s.isDirectory()) {
    return new Response(null, {
      headers: { "Content-Type": "application/zip", "Last-Modified": s.mtime.toUTCString() },
    });
  }
  if (!s.isFile()) return new Response(null, { status: 400 });
  return new Response(null, {
    headers: {
      "Content-Length": String(s.size),
      "Accept-Ranges": "bytes",
      "Last-Modified": s.mtime.toUTCString(),
    },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const { path: parts } = await params;
  const filePath = resolveFromParams(parts);
  if (!filePath) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (!existsSync(filePath)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await rm(filePath, { recursive: true, force: true });
    logInfo("files", `删除 ${parts.join("/")}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    logError("files", `删除失败 ${parts.join("/")} ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

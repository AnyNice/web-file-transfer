import { NextRequest, NextResponse } from "next/server";
import { createWriteStream, existsSync } from "fs";
import { mkdir, rename, rm } from "fs/promises";
import { dirname, join } from "path";
import { Readable } from "stream";
import { randomBytes } from "crypto";
import { requireAuth } from "@/lib/auth";
import { logError, logInfo, logWarn } from "@/lib/log";
import { sanitizeSegment, uniqueFilename } from "@/lib/serverfs";
import { ensureStorageDir } from "@/lib/settings";

// 流式 multipart 解析上传（2026-11-12 重写）
// 旧实现是手写字符串拼接解析，不剥离结尾 boundary、把 header 当 UTF-8 文本拼，
// 导致每个上传文件尾部多出 boundary 垃圾、二进制跨分片还会损坏。此实现：
// - 全程 Buffer 状态机，精确按 \r\n--boundary 切分，boundary 跨 TCP 分片也安全；
// - 文件边收边写临时文件，内存占用与文件大小无关，大文件不爆内存；
// - 返回的 size 是实际落盘字节数；成功后才 rename 为正式文件，失败清理临时文件；
// - 支持 X-File-Path 头携带相对路径（文件夹上传保留目录结构）。

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 0); // 0 = 不限制
const MAX_BYTES = MAX_MB > 0 ? MAX_MB * 1024 * 1024 : Infinity;

type PartInfo = { name: string; filename?: string };

function parseDisposition(value: string): PartInfo {
  const nameMatch = value.match(/name="([^"]*)"/i);
  const filenameMatch = value.match(/filename="([^"]*)"/i);
  return {
    name: nameMatch ? nameMatch[1] : "",
    filename: filenameMatch ? filenameMatch[1] : undefined,
  };
}

export async function POST(req: NextRequest) {
  const denied = requireAuth(req);
  if (denied) return denied;

  const contentType = req.headers.get("content-type") || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    return NextResponse.json({ error: "Invalid content type" }, { status: 400 });
  }
  const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();
  const dashBoundary = Buffer.from(`--${boundary}`, "utf8");
  const bodyNeedle = Buffer.concat([Buffer.from("\r\n", "utf8"), dashBoundary]);

  // 目标相对路径（文件夹上传）：取目录部分，文件名以 multipart 内的为准
  const storageRoot = ensureStorageDir();
  let targetDir = storageRoot;
  let relDirLabel = "";
  const relPathHeader = req.headers.get("x-file-path");
  if (relPathHeader) {
    try {
      const decoded = decodeURIComponent(relPathHeader);
      const dirParts = decoded
        .split(/[\\/]+/)
        .slice(0, -1)
        .filter((s) => s && s !== "." && s !== "..")
        .map(sanitizeSegment);
      if (dirParts.length > 0) {
        targetDir = join(storageRoot, ...dirParts);
        relDirLabel = dirParts.join("/");
      }
    } catch { /* 忽略非法头，按根目录处理 */ }
  }

  let fileStream: ReturnType<typeof createWriteStream> | null = null;
  let tmpPath = "";
  let finalName = "";
  let written = 0;
  let sawFile = false;

  const cleanup = async () => {
    try { fileStream?.destroy(); } catch { /* ignore */ }
    if (tmpPath) await rm(tmpPath, { force: true }).catch(() => {});
  };

  try {
    if (!existsSync(targetDir)) await mkdir(targetDir, { recursive: true });
    if (!req.body) return NextResponse.json({ error: "No body" }, { status: 400 });

    type State = "preamble" | "headers" | "body" | "done";
    let state: State = "preamble";
    let buf: Buffer = Buffer.alloc(0);
    let currentPart: PartInfo = { name: "" };
    let isFilePart = false;

    const emitBody = async (data: Buffer) => {
      if (!isFilePart || data.length === 0) return;
      written += data.length;
      if (written > MAX_BYTES) throw new Error("FILE_TOO_LARGE");
      if (!fileStream!.write(data)) {
        await new Promise<void>((resolve, reject) => {
          fileStream!.once("drain", resolve);
          fileStream!.once("error", reject);
        });
      }
    };

    const beginPart = async (headersText: string) => {
      const dispLine = headersText
        .split("\r\n")
        .find((l) => l.toLowerCase().startsWith("content-disposition:"));
      currentPart = dispLine
        ? parseDisposition(dispLine.slice(dispLine.indexOf(":") + 1))
        : { name: "" };
      isFilePart = currentPart.name === "file" && typeof currentPart.filename === "string" && currentPart.filename.length > 0;
      if (isFilePart && !sawFile) {
        sawFile = true;
        const rawName = (currentPart.filename || "upload").split(/[\\/]/).pop() || "upload";
        finalName = uniqueFilename(targetDir, sanitizeSegment(rawName));
        tmpPath = join(targetDir, `.upload-${Date.now()}-${randomBytes(4).toString("hex")}.tmp`);
        fileStream = createWriteStream(tmpPath);
      } else {
        isFilePart = false; // 只接受第一个 file 部分，其余丢弃
      }
    };

    const nodeStream = Readable.fromWeb(req.body as any);
    for await (const chunk of nodeStream) {
      const piece: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      buf = buf.length === 0 ? piece : Buffer.concat([buf, piece]);

      // 尽可能消费 buffer，直到需要更多数据
      for (;;) {
        if (state === "preamble") {
          const idx = buf.indexOf(dashBoundary);
          if (idx === -1) {
            // 保留可能是分片边界的尾巴
            const keep = dashBoundary.length - 1;
            if (buf.length > keep) buf = buf.subarray(buf.length - keep);
            break;
          }
          if (buf.length < idx + dashBoundary.length + 2) break; // 等后续字节判断 -- 或 \r\n
          const after = buf.subarray(idx + dashBoundary.length, idx + dashBoundary.length + 2).toString("latin1");
          buf = buf.subarray(idx + dashBoundary.length + 2);
          state = after === "--" ? "done" : "headers";
          if (state === "done") break;
        } else if (state === "headers") {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) {
            if (buf.length > 64 * 1024) throw new Error("Part headers too large");
            break;
          }
          const headersText = buf.subarray(0, idx).toString("utf8");
          buf = buf.subarray(idx + 4);
          await beginPart(headersText);
          state = "body";
        } else if (state === "body") {
          const idx = buf.indexOf(bodyNeedle);
          if (idx === -1) {
            const keep = bodyNeedle.length - 1;
            if (buf.length > keep) {
              const data = buf.subarray(0, buf.length - keep);
              buf = buf.subarray(buf.length - keep);
              await emitBody(Buffer.from(data));
            }
            break;
          }
          if (idx > 0) await emitBody(Buffer.from(buf.subarray(0, idx)));
          if (buf.length < idx + bodyNeedle.length + 2) {
            buf = buf.subarray(idx); // 等后续字节判断 -- 或 \r\n
            break;
          }
          const after = buf.subarray(idx + bodyNeedle.length, idx + bodyNeedle.length + 2).toString("latin1");
          buf = buf.subarray(idx + bodyNeedle.length + 2);
          state = after === "--" ? "done" : "headers";
          if (state === "done") break;
        } else {
          break;
        }
      }
      if (state === "done") break;
    }

    if (!sawFile || !fileStream) {
      await cleanup();
      return NextResponse.json({ error: "No file data found" }, { status: 400 });
    }

    await new Promise<void>((resolve, reject) => {
      fileStream!.on("finish", resolve);
      fileStream!.on("error", reject);
      fileStream!.end();
    });

    const finalPath = join(targetDir, finalName);
    await rename(tmpPath, finalPath);
    tmpPath = "";

    const relPath = relDirLabel ? `${relDirLabel}/${finalName}` : finalName;
    logInfo("upload", `上传完成 ${relPath} ${written}B`);
    return NextResponse.json({
      name: finalName,
      path: relPath,
      size: written,
    });
  } catch (err) {
    await cleanup();
    if (err instanceof Error && err.message === "FILE_TOO_LARGE") {
      logWarn("upload", `文件超过上限 ${MAX_MB}MB 被拒`);
      return NextResponse.json(
        { error: `文件超过上限 ${MAX_MB} MB` },
        { status: 413 }
      );
    }
    logError("upload", `上传失败 ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

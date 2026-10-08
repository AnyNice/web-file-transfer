import { NextRequest, NextResponse } from "next/server";
import { stat, rm } from "fs/promises";
import { join } from "path";
import { existsSync, createReadStream } from "fs";
import { Readable } from "stream";

const UPLOAD_DIR = join(process.cwd(), "uploads");

// Serve a file from uploads
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string }> }
) {
  const { path } = await params;
  const decodedPath = decodeURIComponent(path);
  const filePath = join(UPLOAD_DIR, decodedPath);

  if (!filePath.startsWith(UPLOAD_DIR)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const s = await stat(filePath);
  if (!s.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }

  const ext = decodedPath.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    zip: "application/zip",
    rar: "application/x-rar-compressed",
    txt: "text/plain",
    csv: "text/csv",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    iso: "application/x-iso9660-image",
    gz: "application/gzip",
    tar: "application/x-tar",
  };
  const contentType = mimeTypes[ext || ""] || "application/octet-stream";

  const rawName = decodedPath.split("/").pop() || "file";
  const fileStream = createReadStream(filePath);
  const webStream = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(rawName)}`,
      "Content-Length": s.size.toString(),
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string }> }
) {
  const { path } = await params;
  const decodedPath = decodeURIComponent(path);
  const filePath = join(UPLOAD_DIR, decodedPath);

  if (!filePath.startsWith(UPLOAD_DIR)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    await rm(filePath, { recursive: true, force: true });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

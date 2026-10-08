import { NextResponse } from "next/server";
import { readdir, stat, unlink, rm } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const UPLOAD_DIR = join(process.cwd(), "uploads");

export async function GET() {
  try {
    if (!existsSync(UPLOAD_DIR)) {
      return NextResponse.json({ files: [] });
    }
    const entries = await readdir(UPLOAD_DIR, { withFileTypes: true });
    const files = (await Promise.all(
      entries.map(async (entry) => {
        try {
          const fullpath = join(UPLOAD_DIR, entry.name);
          if (entry.isDirectory()) {
            return { name: entry.name, type: "folder" as const, path: entry.name, size: 0, modified: "" };
          }
          const s = await stat(fullpath);
          return { name: entry.name, type: "file" as const, path: entry.name, size: s.size, modified: s.mtime.toISOString() };
        } catch {
          return null;
        }
      })
    )).filter((f) => f !== null);
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

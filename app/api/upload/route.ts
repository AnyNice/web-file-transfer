import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile, rm, readdir } from "fs/promises";
import { join } from "path";
import { existsSync, createWriteStream } from "fs";
import { Readable } from "stream";

const UPLOAD_DIR = join(process.cwd(), "uploads");

export const maxDuration = 600;

// Get next available filename by adding numeric suffix
function getUniqueFilename(baseName: string, existingFiles: string[]): string {
  if (!existingFiles.includes(baseName)) {
    return baseName;
  }
  const dotIndex = baseName.lastIndexOf('.');
  const namePart = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const extPart = dotIndex > 0 ? baseName.slice(dotIndex) : '';

  let counter = 1;
  while (true) {
    const candidate = `${namePart}_${counter}${extPart}`;
    if (!existingFiles.includes(candidate)) {
      return candidate;
    }
    counter++;
  }
}

export async function POST(req: NextRequest) {
  let fileStream: ReturnType<typeof createWriteStream> | null = null;
  let partialFileName = "";

  try {
    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }

    const contentType = req.headers.get("content-type") || "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
      return NextResponse.json({ error: "Invalid content type" }, { status: 400 });
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];

    // Get existing files to check for duplicates
    let existingFiles: string[] = [];
    try {
      existingFiles = await readdir(UPLOAD_DIR);
    } catch {
      existingFiles = [];
    }

    let parsedFileName = "upload";
    let foundHeaderEnd = false;
    let totalWritten = 0;
    let headerBuffer = "";

    const nodeStream = Readable.fromWeb(req.body as any);

    for await (const chunk of nodeStream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      if (!foundHeaderEnd) {
        headerBuffer += buf.toString("utf-8");

        const filenameMatch = headerBuffer.match(/filename="([^"]+)"/i);
        if (filenameMatch) {
          parsedFileName = filenameMatch[1];
        }

        const headerEndIndex = headerBuffer.indexOf("\r\n\r\n");
        if (headerEndIndex !== -1) {
          foundHeaderEnd = true;
          partialFileName = parsedFileName.replace(/[\/\\:*?"<>|]/g, "_");

          // Check for duplicate and rename if needed
          partialFileName = getUniqueFilename(partialFileName, existingFiles);

          fileStream = createWriteStream(join(UPLOAD_DIR, partialFileName));

          const dataAfterHeaders = buf.slice(headerEndIndex + 4);
          if (dataAfterHeaders.length > 0) {
            fileStream.write(dataAfterHeaders);
            totalWritten += dataAfterHeaders.length;
          }
          continue;
        }
      } else if (fileStream) {
        fileStream.write(buf);
        totalWritten += buf.length;
      }
    }

    if (!foundHeaderEnd || !fileStream) {
      return NextResponse.json({ error: "No file data found" }, { status: 400 });
    }

    await new Promise<void>((resolve, reject) => {
      fileStream!.on("finish", resolve);
      fileStream!.on("error", reject);
      fileStream!.end();
    });

    return NextResponse.json({ name: partialFileName, size: totalWritten });
  } catch (err) {
    console.error("Upload error:", err);
    if (fileStream) {
      fileStream.destroy();
    }
    // Clean up partial file only if it doesn't exist in the final listing
    if (partialFileName) {
      try {
        // Check if file was actually saved (not just a partial)
        const afterFiles = await readdir(UPLOAD_DIR).catch(() => []);
        // If the file exists and matches the partial name, it might be complete
        // Only delete if it's clearly a partial (we can't know for sure, so we delete)
        await rm(join(UPLOAD_DIR, partialFileName), { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filename = searchParams.get("filename");
    if (!filename) {
      return NextResponse.json({ error: "Filename required" }, { status: 400 });
    }
    const sanitizedName = filename.replace(/[\/\\:*?"<>|]/g, "_");
    const filePath = join(UPLOAD_DIR, sanitizedName);

    if (!filePath.startsWith(UPLOAD_DIR)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (existsSync(filePath)) {
      await rm(filePath, { force: true });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

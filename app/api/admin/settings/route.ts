import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import {
  DEFAULT_STORAGE_DIR,
  ensureStorageDir,
  getConfiguredStorageDir,
  getStorageDir,
  setStorageDir,
  validateStorageDir,
} from "@/lib/settings";
import { logInfo, logWarn } from "@/lib/log";

export const dynamic = "force-dynamic";

function state() {
  return {
    storageDir: getStorageDir(),
    configuredDir: getConfiguredStorageDir(),
    defaultDir: DEFAULT_STORAGE_DIR,
    isDefault: getConfiguredStorageDir() === null,
  };
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return NextResponse.json(state());
}

// 设置中转目录：{ storageDir: "E:\\dir" } 切换；{ storageDir: "" } 恢复默认。
// 切换只改后续文件落点，旧目录里的文件不会搬动，列表将显示新目录的内容。
export async function PUT(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const raw = typeof body?.storageDir === "string" ? body.storageDir.trim() : null;
  if (raw === null) {
    return NextResponse.json({ error: "缺少 storageDir" }, { status: 400 });
  }
  if (raw === "") {
    setStorageDir(null);
    ensureStorageDir();
    logInfo("admin", `中转目录恢复默认 ${DEFAULT_STORAGE_DIR}`);
    return NextResponse.json(state());
  }
  const err = validateStorageDir(raw);
  if (err) {
    logWarn("admin", `中转目录设置被拒 ${raw}（${err}）`);
    return NextResponse.json({ error: err }, { status: 400 });
  }
  setStorageDir(raw);
  ensureStorageDir();
  logInfo("admin", `中转目录切换为 ${getStorageDir()}`);
  return NextResponse.json(state());
}

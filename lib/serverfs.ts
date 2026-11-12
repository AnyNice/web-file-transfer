// 服务器模式的文件系统辅助：路径安全、唯一文件名
// 中转根目录由 lib/settings 决定（管理员可改，默认 <项目>/uploads），每次调用现取。
import { existsSync } from "fs";
import { join, resolve, sep } from "path";
import { getStorageDir } from "@/lib/settings";

export function uploadDir(): string {
  return getStorageDir();
}

/** 清洗单个路径段：去掉非法字符与路径分隔，拒绝 . 与 .. */
export function sanitizeSegment(seg: string): string {
  const cleaned = seg
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+$/, "_")
    .trim();
  return cleaned || "_";
}

/**
 * 把用户给的相对路径（可含多级目录）解析为 uploads 内的绝对路径。
 * 任一段为 .. 或解析后逃出中转根目录时返回 null。
 */
export function resolveSafePath(relPath: string): string | null {
  const parts = relPath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === ".." || p === ".")) return null;
  const safeParts = parts.map(sanitizeSegment);
  const root = resolve(getStorageDir());
  const abs = resolve(join(root, ...safeParts));
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** 同名时追加 _1、_2… 返回不冲突的文件名（仅文件名部分） */
export function uniqueFilename(dir: string, baseName: string): string {
  if (!existsSync(join(dir, baseName))) return baseName;
  const dotIndex = baseName.lastIndexOf(".");
  const namePart = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const extPart = dotIndex > 0 ? baseName.slice(dotIndex) : "";
  let counter = 1;
  while (existsSync(join(dir, `${namePart}_${counter}${extPart}`))) counter++;
  return `${namePart}_${counter}${extPart}`;
}

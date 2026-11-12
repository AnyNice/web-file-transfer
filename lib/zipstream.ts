// 流式 ZIP 打包（STORE 不压缩 + ZIP64）：边读边写、边算 CRC32，
// 内存占用与文件总大小无关，几个 GB 的文件夹也能打包下载。
// 结构：本地头(数据描述符) → 数据 → 描述符 → 中央目录 → ZIP64 EOCD → 定位器 → EOCD。
import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import path from "path";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export class Crc32 {
  private crc = 0xffffffff;
  update(buf: Buffer) {
    let c = this.crc;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    this.crc = c;
  }
  digest() {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

export interface ZipEntry {
  rel: string; // zip 内相对路径（正斜杠）
  abs: string; // 磁盘绝对路径
  size: number;
  mtime: Date;
}

export async function collectEntries(rootAbs: string): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const walk = async (dir: string, prefix: string) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      const abs = path.join(dir, it.name);
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(abs, rel);
      else if (it.isFile()) {
        const st = await stat(abs);
        out.push({ rel, abs, size: st.size, mtime: st.mtime });
      }
    }
  };
  await walk(rootAbs, "");
  return out;
}

function dosDateTime(d: Date) {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((Math.max(0, d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0xf) << 5) |
      (d.getDate() & 0x1f));
  return { time, date };
}

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const u64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(Math.floor(v)));
  return b;
};

export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  let offset = 0;
  const central: Buffer[] = [];
  const emit = (buf: Buffer) => {
    offset += buf.length;
    return buf;
  };

  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel, "utf8");
    const { time, date } = dosDateTime(e.mtime);
    const localOffset = offset;

    // 本地文件头：sizes 先饱和占位 + ZIP64 extra（真实值在数据描述符与中央目录）
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(45, 4); // version needed (ZIP64)
    head.writeUInt16LE(0x0808, 6); // flags: UTF-8 + data descriptor
    head.writeUInt16LE(0, 8); // method: store
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(0, 14); // crc (in descriptor)
    head.writeUInt32LE(0xffffffff, 18);
    head.writeUInt32LE(0xffffffff, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(20, 28); // extra len
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2); // uncomp + comp placeholders (0)
    yield emit(Buffer.concat([head, nameBuf, extra]));

    // 数据：流式读 + CRC
    const crc = new Crc32();
    let written = 0;
    for await (const chunk of createReadStream(e.abs, { highWaterMark: 1 << 20 })) {
      const buf = chunk as Buffer;
      crc.update(buf);
      written += buf.length;
      yield emit(buf);
    }
    const crcVal = crc.digest();

    // 数据描述符
    const desc = Buffer.alloc(24);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crcVal, 4);
    desc.writeBigUInt64LE(BigInt(written), 8);
    desc.writeBigUInt64LE(BigInt(written), 16);
    yield emit(desc);

    // 中央目录条目
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(45, 4); // version made by
    cen.writeUInt16LE(45, 6); // version needed
    cen.writeUInt16LE(0x0808, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crcVal, 16);
    cen.writeUInt32LE(0xffffffff, 20);
    cen.writeUInt32LE(0xffffffff, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(28, 30); // extra len: zip64 (uncomp+comp+offset = 24 + 4)
    // local header offset 放在 zip64 extra 里，46 字节定长区内的 offset 字段饱和
    cen.writeUInt32LE(0xffffffff, 42);
    const cextra = Buffer.alloc(28);
    cextra.writeUInt16LE(0x0001, 0);
    cextra.writeUInt16LE(24, 2);
    cextra.writeBigUInt64LE(BigInt(e.size), 4);
    cextra.writeBigUInt64LE(BigInt(written), 12);
    cextra.writeBigUInt64LE(BigInt(localOffset), 20);
    central.push(Buffer.concat([cen, nameBuf, cextra]));
  }

  const cdStart = offset;
  for (const c of central) yield emit(c);
  const cdSize = offset - cdStart;

  // ZIP64 EOCD
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(BigInt(44), 4);
  z64.writeUInt16LE(45, 12);
  z64.writeUInt16LE(45, 14);
  z64.writeUInt32LE(0, 16);
  z64.writeUInt32LE(0, 20);
  z64.writeBigUInt64LE(BigInt(entries.length), 24);
  z64.writeBigUInt64LE(BigInt(entries.length), 32);
  z64.writeBigUInt64LE(BigInt(cdSize), 40);
  z64.writeBigUInt64LE(BigInt(cdStart), 48);
  const z64Offset = offset;
  yield emit(z64);

  // ZIP64 定位器
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeUInt32LE(0, 4);
  loc.writeBigUInt64LE(BigInt(z64Offset), 8);
  loc.writeUInt32LE(1, 16);
  yield emit(loc);

  // 经典 EOCD（字段饱和）
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  yield end;
}

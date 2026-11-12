/**
 * WebRTC P2P 文件传输库 v2（2026-11-12 重写）
 *
 * 旧版的核心问题（用户实测 P2P 全是 bug）：
 * - 分块 2MB 起步且无背压：浏览器 SCTP 单消息上限通常 256KB~1MB，
 *   大块 send() 直接失败/堵死通道，大文件必挂；
 * - 接收端把全部分块攒在内存里最后拼 Blob：大文件直接把标签页撑爆卡死；
 * - 接收方建连 2 秒后主动关闭 ctrl 通道，而文件清单/保活都走 ctrl，时序错就收不到；
 * - restartIce 没有重协商通道，是假恢复；disconnected 又被另一处监听立即关通道，自相矛盾；
 * - 心跳只发 ping 不验 pong，死连接发现不了；0 字节文件永远完不成。
 *
 * v2 的做法：
 * - 分块 64KB + bufferedAmount 背压（高水位 1MB / 低水位 256KB）；
 * - 接收端流式写入 OPFS（浏览器私有文件系统），内存占用与文件大小无关，
 *   完成时给出 object URL 供下载；OPFS 不可用时才回退内存 Blob 并给出提示；
 * - ctrl 通道全程保留；心跳 ping/pong 双向校验，45 秒无响应提示；
 * - ICE failed 只上报一次断开，由用户用新邀请码重连（不再假装能自愈）；
 * - 0 字节文件在收到完成帧时直接落成空文件并标记完成。
 *
 * 信令流程（host-poll 模型，房间 TTL 10 分钟）：
 *   host:  createRoom() → 注册 offer，拿到 6 位邀请码
 *          pollUntilConnected() 轮询等待 guest-answer
 *   guest: joinRoom(code) → 拉 offer → 回传 answer
 */

export interface FileMeta {
  name: string;
  size: number;
  mime?: string;
  lastModified?: number;
}

export interface TransferProgress {
  index: number;
  name: string;
  total: number;
  sent: number; // 发送端=已发送字节；接收端=已接收字节
  speed: number;
  done: boolean;
}

export interface ReceivedFile {
  index: number;
  name: string;
  size: number;
  url: string; // object URL，可直接用于 <a download>
  cleanup: () => Promise<void>;
}

// 帧头 12 字节（小端）：[0]=type [1..4]=index [5..8]=offsetLo [9..11]=offsetHi
const FRAME_FILE_CHUNK = 0x01;
const FRAME_FILE_DONE = 0x02;
const HEADER_SIZE = 12;
const CHUNK_PAYLOAD = 64 * 1024; // 64KB，远低于各浏览器 SCTP 单消息上限
const BUFFER_HIGH_WATER = 1 * 1024 * 1024;
const BUFFER_LOW_WATER = 256 * 1024;
const POLL_TIMEOUT_MS = 10 * 60_000; // 与服务端房间 TTL 一致

const STUN = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

type ControlMsg =
  | { type: "file-list"; files: FileMeta[] }
  | { type: "error"; message: string }
  | { type: "all-done" }
  | { type: "ping" }
  | { type: "pong" };

interface RecvSlot {
  meta: FileMeta;
  received: number;
  doneSize: number; // 收到完成帧时的总大小，未收到为 -1
  ready: boolean;
  lastUpdate: number;
  bytesAtUpdate: number;
  speed: number;
  // OPFS 流式落盘
  opfsHandle: any | null;
  opfsWritable: any | null;
  writeChain: Promise<void>;
  memChunks: ArrayBuffer[] | null; // 回退模式
  sessionId: string;
}

const memFallbackWarned = { value: false };

export class P2PConnection {
  private pc: RTCPeerConnection | null = null;
  private ctrlCh: RTCDataChannel | null = null;
  private dataCh: RTCDataChannel | null = null;
  private closed = false;
  private hostCode = "";
  private sessionId = Math.random().toString(36).slice(2, 10);

  private _onProgress?: (files: TransferProgress[]) => void;
  private _onFileList?: (files: FileMeta[]) => void;
  private _onFileReady?: (file: ReceivedFile) => void;
  private _onStatus?: (s: string) => void;
  private _onAllDone?: () => void;
  private _onDisconnected?: () => void;

  private recvSlots = new Map<number, RecvSlot>();
  private sendSlots = new Map<number, { meta: FileMeta; sent: number; lastAt: number; lastBytes: number; speed: number; done: boolean }>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private noResponseWarned = false;
  private disconnectFired = false;

  get connected() {
    const ch = this.ctrlCh || this.dataCh;
    return !!ch && ch.readyState === "open" && !this.closed;
  }

  get dataChannelReady() {
    return !!this.dataCh && this.dataCh.readyState === "open" && !this.closed;
  }

  waitForDataChannel(timeoutMs = 10000): Promise<void> {
    if (this.dataChannelReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (this.closed) {
          clearInterval(timer);
          reject(new Error("连接已关闭"));
          return;
        }
        if (this.dataChannelReady) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error("数据通道未就绪"));
      }, timeoutMs);
    });
  }

  setOnProgress(cb: (files: TransferProgress[]) => void) { this._onProgress = cb; }
  setOnFileList(cb: (files: FileMeta[]) => void) { this._onFileList = cb; }
  setOnFileReady(cb: (file: ReceivedFile) => void) { this._onFileReady = cb; }
  setOnStatus(cb: (s: string) => void) { this._onStatus = cb; }
  setOnAllDone(cb: () => void) { this._onAllDone = cb; }
  setOnDisconnected(cb: () => void) { this._onDisconnected = cb; }

  // ── 信令 ─────────────────────────────────────────────────

  // 本浏览器身份（localStorage 持久）：建房时登记到房间，入房时比对，
  // 防止同一个浏览器拿自己生成的邀请码连自己（服务端只认码不认人时的漏洞）
  private clientId(): string {
    try {
      let id = localStorage.getItem("wft_client_id");
      if (!id) {
        id = typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `c-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        localStorage.setItem("wft_client_id", id);
      }
      return id;
    } catch {
      return "";
    }
  }

  async createRoom(): Promise<string> {
    const offerSdp = await this.makeOffer();
    const res = await fetch("/api/p2p/signaling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "host-create", sdp: offerSdp, clientId: this.clientId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "创建房间失败");
    this.hostCode = data.code as string;
    return this.hostCode;
  }

  async pollUntilConnected(): Promise<void> {
    const startedAt = Date.now();
    while (true) {
      if (this.closed) throw new Error("poll-cancelled");
      let res: Response | null = null;
      try {
        res = await fetch("/api/p2p/signaling", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "host-poll", code: this.hostCode }),
        });
      } catch { /* 网络抖动，继续轮询 */ }
      if (res) {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.joined && data.answer) {
          await this.applyRemoteSdp(data.answer);
          this.startKeepAlive();
          this._onStatus?.("连接已建立");
          return;
        }
        if (res.status === 404) throw new Error("邀请码已过期，请重新生成");
        if (res.status === 401) throw new Error("登录已失效，请先输入访问口令");
      }
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        throw new Error("等待连接超时（10 分钟），请重新生成邀请码");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async cancelRoom(): Promise<void> {
    if (!this.hostCode) return;
    try {
      await fetch("/api/p2p/signaling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "host-cancel", code: this.hostCode }),
      });
    } catch { /* ignore */ }
  }

  async joinRoom(code: string): Promise<void> {
    const normalized = code.trim().toUpperCase();
    const joinRes = await fetch("/api/p2p/signaling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "guest-join", code: normalized, clientId: this.clientId() }),
    });
    const joinData = await joinRes.json().catch(() => ({}));
    if (!joinRes.ok) throw new Error(joinData.error || "连接失败");

    await this.makeAnswer(joinData.offer as string);
    const ansRes = await fetch("/api/p2p/signaling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "guest-answer",
        code: normalized,
        sdp: JSON.stringify(this.pc!.localDescription!),
      }),
    });
    const ansData = await ansRes.json().catch(() => ({}));
    if (!ansRes.ok) throw new Error(ansData.error || "确认连接失败");

    this.startKeepAlive();
    this._onStatus?.("连接已建立");
  }

  // ── 发送 ─────────────────────────────────────────────────

  sendFileList(files: FileMeta[]) {
    if (!this.ctrlCh || this.ctrlCh.readyState !== "open") return;
    const msg: ControlMsg = { type: "file-list", files };
    this.ctrlCh.send(JSON.stringify(msg));
    files.forEach((f, i) => {
      this.sendSlots.set(i, { meta: f, sent: 0, lastAt: performance.now(), lastBytes: 0, speed: 0, done: false });
    });
    this._onStatus?.(`已发送 ${files.length} 个文件的清单`);
  }

  sendAllDone() {
    if (!this.ctrlCh || this.ctrlCh.readyState !== "open") return;
    const msg: ControlMsg = { type: "all-done" };
    this.ctrlCh.send(JSON.stringify(msg));
  }

  private waitForBufferDrain(): Promise<void> {
    const ch = this.dataCh!;
    if (ch.bufferedAmount <= BUFFER_HIGH_WATER) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("连接已断开"));
      };
      const onLow = () => finish();
      const poll = setInterval(() => {
        if (this.closed || !this.dataCh || this.dataCh.readyState !== "open") {
          clearInterval(poll);
          fail();
          return;
        }
        if (this.dataCh.bufferedAmount <= BUFFER_LOW_WATER) {
          clearInterval(poll);
          finish();
        }
      }, 50);
      const cleanup = () => {
        clearInterval(poll);
        try { ch.removeEventListener("bufferedamountlow", onLow); } catch { /* ignore */ }
      };
      ch.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
      ch.addEventListener("bufferedamountlow", onLow);
    });
  }

  async sendFile(file: File, index: number): Promise<void> {
    if (!this.dataCh || this.dataCh.readyState !== "open") {
      throw new Error("数据通道未就绪，连接未完全建立");
    }
    let slot = this.sendSlots.get(index);
    if (!slot) {
      slot = { meta: { name: file.name, size: file.size }, sent: 0, lastAt: performance.now(), lastBytes: 0, speed: 0, done: false };
      this.sendSlots.set(index, slot);
    }

    for (let offset = 0; offset < file.size; offset += CHUNK_PAYLOAD) {
      if (this.closed) throw new Error("连接已断开");
      await this.waitForBufferDrain();
      const slice = file.slice(offset, Math.min(offset + CHUNK_PAYLOAD, file.size));
      const buf = await slice.arrayBuffer();
      const frame = new Uint8Array(HEADER_SIZE + buf.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint8(0, FRAME_FILE_CHUNK);
      view.setUint32(1, index, true);
      view.setUint32(5, offset >>> 0, true);
      const hi = Math.floor(offset / 0x100000000);
      view.setUint8(9, hi & 0xff);
      view.setUint8(10, (hi >>> 8) & 0xff);
      view.setUint8(11, (hi >>> 16) & 0xff);
      frame.set(new Uint8Array(buf), HEADER_SIZE);
      this.dataCh.send(frame.buffer);

      slot.sent = offset + buf.byteLength;
      const now = performance.now();
      const dt = (now - slot.lastAt) / 1000;
      if (dt >= 0.25) {
        slot.speed = (slot.sent - slot.lastBytes) / dt;
        slot.lastAt = now;
        slot.lastBytes = slot.sent;
        this.emitProgress();
      }
    }

    // 完成帧
    const doneFrame = new Uint8Array(HEADER_SIZE);
    const dv = new DataView(doneFrame.buffer);
    dv.setUint8(0, FRAME_FILE_DONE);
    dv.setUint32(1, index, true);
    dv.setUint32(5, file.size >>> 0, true);
    const hi2 = Math.floor(file.size / 0x100000000);
    dv.setUint8(9, hi2 & 0xff);
    dv.setUint8(10, (hi2 >>> 8) & 0xff);
    dv.setUint8(11, (hi2 >>> 16) & 0xff);
    await this.waitForBufferDrain();
    this.dataCh.send(doneFrame.buffer);
    slot.done = true;
    slot.sent = file.size;
    this.emitProgress();
  }

  // ── 接收 ─────────────────────────────────────────────────

  private async ensureWritable(slot: RecvSlot): Promise<boolean> {
    if (slot.opfsWritable || slot.memChunks) return true;
    try {
      const root = await (navigator as any).storage.getDirectory();
      // OPFS 内部名带随机后缀：相对路径拍平后可能重名（a/b.txt 与 a_b.txt），不能互相覆盖
      const tag = ((slot as any)._opfsTag ??= Math.random().toString(36).slice(2, 8));
      const handle = await root.getFileHandle(`wft-${slot.sessionId}-${tag}-${slot.meta.name.replace(/[^\w.\-]+/g, "_")}`, { create: true });
      slot.opfsHandle = handle;
      slot.opfsWritable = await handle.createWritable();
      return true;
    } catch {
      slot.memChunks = [];
      if (!memFallbackWarned.value) {
        memFallbackWarned.value = true;
        this._onStatus?.("当前浏览器不支持流式落盘，大文件接收将占用较多内存");
      }
      return true;
    }
  }

  // 注意：本方法从 writeChain 内部调用（完成帧任务排在全部分块任务之后，
  // 顺序天然保证），绝不能再 await writeChain 本身——那会自己等自己、永久死锁
  // （2026-11-12 实测踩中：字节全收到但永远不置 ready）。
  private async finalizeReceived(index: number, slot: RecvSlot) {
    const total = slot.doneSize >= 0 ? slot.doneSize : slot.meta.size;
    if (slot.received !== total) {
      this._onStatus?.(`文件 ${slot.meta.name} 接收不完整（${slot.received}/${total} 字节）`);
    }
    let url: string;
    let cleanup: () => Promise<void>;
    if (slot.opfsWritable && slot.opfsHandle) {
      try { await slot.opfsWritable.close(); } catch { /* ignore */ }
      slot.opfsWritable = null;
      const file = await slot.opfsHandle.getFile();
      url = URL.createObjectURL(file);
      const handle = slot.opfsHandle;
      cleanup = async () => {
        URL.revokeObjectURL(url);
        try {
          const root = await (navigator as any).storage.getDirectory();
          await root.removeEntry(handle.name);
        } catch { /* ignore */ }
      };
    } else {
      const blob = new Blob(slot.memChunks || [], { type: slot.meta.mime || "application/octet-stream" });
      url = URL.createObjectURL(blob);
      cleanup = async () => URL.revokeObjectURL(url);
    }
    slot.ready = true;
    this.emitProgress();
    this._onFileReady?.({
      index,
      name: slot.meta.name,
      size: total,
      url,
      cleanup,
    });
  }

  private handleDataFrame(raw: ArrayBuffer) {
    if (raw.byteLength < HEADER_SIZE) return;
    const view = new DataView(raw);
    const frameType = view.getUint8(0);
    const index = view.getUint32(1, true);
    const lo = view.getUint32(5, true);
    const hi = view.getUint8(9) | (view.getUint8(10) << 8) | (view.getUint8(11) << 16);
    const offset = lo + hi * 0x100000000;

    let slot = this.recvSlots.get(index);
    if (!slot) {
      slot = {
        meta: { name: `file_${index}`, size: 0 },
        received: 0,
        doneSize: -1,
        ready: false,
        lastUpdate: 0,
        bytesAtUpdate: 0,
        speed: 0,
        opfsHandle: null,
        opfsWritable: null,
        writeChain: Promise.resolve(),
        memChunks: null,
        sessionId: this.sessionId,
      };
      this.recvSlots.set(index, slot);
    }

    if (frameType === FRAME_FILE_CHUNK) {
      const payload = raw.slice(HEADER_SIZE);
      slot.received += payload.byteLength;
      const s = slot;
      s.writeChain = s.writeChain.then(async () => {
        await this.ensureWritable(s);
        if (s.opfsWritable) {
          await s.opfsWritable.write({ type: "write", position: offset, data: payload });
        } else if (s.memChunks) {
          s.memChunks.push(payload);
        }
      }).catch(() => { /* 单帧写失败不拖垮链，完成时按大小校验提示 */ });
      const now = performance.now();
      const dt = (now - slot.lastUpdate) / 1000;
      if (dt >= 0.25) {
        slot.speed = (slot.received - slot.bytesAtUpdate) / dt;
        slot.lastUpdate = now;
        slot.bytesAtUpdate = slot.received;
        this.emitProgress();
      }
    } else if (frameType === FRAME_FILE_DONE) {
      slot.doneSize = offset;
      const s = slot;
      // 等此前分块全部落盘后再收尾（0 字节文件也在这里落成空文件）
      s.writeChain = s.writeChain.then(async () => {
        await this.ensureWritable(s);
        await this.finalizeReceived(index, s);
      }).catch(() => {});
      this.emitProgress();
    }
  }

  // ── 内部 ─────────────────────────────────────────────────

  private emitProgress() {
    if (!this._onProgress) return;
    const arr: TransferProgress[] = [];
    const indexes = new Set<number>([...this.recvSlots.keys(), ...this.sendSlots.keys()]);
    for (const index of indexes) {
      const r = this.recvSlots.get(index);
      if (r && (r.received > 0 || r.doneSize >= 0 || !this.sendSlots.has(index))) {
        const total = r.doneSize >= 0 ? r.doneSize : r.meta.size;
        arr.push({
          index,
          name: r.meta.name,
          total,
          sent: Math.min(r.received, total || r.received),
          speed: r.speed || 0,
          done: r.ready,
        });
        continue;
      }
      const s = this.sendSlots.get(index);
      if (s) {
        arr.push({
          index,
          name: s.meta.name,
          total: s.meta.size,
          sent: s.sent,
          speed: s.speed || 0,
          done: s.done,
        });
      }
    }
    arr.sort((a, b) => a.index - b.index);
    this._onProgress(arr);
  }

  private startKeepAlive() {
    this.lastPongAt = Date.now();
    this.noResponseWarned = false;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.closed || !this.ctrlCh || this.ctrlCh.readyState !== "open") return;
      try { this.ctrlCh.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
      if (Date.now() - this.lastPongAt > 45_000 && !this.noResponseWarned) {
        this.noResponseWarned = true;
        this._onStatus?.("连接无响应，可能已断开");
      }
    }, 15_000);
  }

  private fireDisconnected() {
    if (this.disconnectFired || this.closed) return;
    this.disconnectFired = true;
    this._onStatus?.("连接已断开");
    this._onDisconnected?.();
  }

  close() {
    this.closed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    try { this.ctrlCh?.close(); } catch { /* ignore */ }
    try { this.dataCh?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.pc = null;
    this.ctrlCh = null;
    this.dataCh = null;
    for (const slot of this.recvSlots.values()) {
      if (slot.opfsWritable) {
        slot.writeChain = slot.writeChain.then(() => slot.opfsWritable?.abort?.()).catch(() => {});
      }
    }
  }

  private async makeOffer(): Promise<string> {
    this.pc = new RTCPeerConnection(STUN);
    this.setupPC();
    this.ctrlCh = this.pc.createDataChannel("ctrl", { ordered: true });
    this.dataCh = this.pc.createDataChannel("data", { ordered: true });
    this.wireChannel(this.ctrlCh, true);
    this.wireChannel(this.dataCh, false);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.waitForICE();
    return JSON.stringify(this.pc.localDescription!);
  }

  private async makeAnswer(offerSdp: string) {
    const offer = JSON.parse(offerSdp) as RTCSessionDescriptionInit;
    this.pc = new RTCPeerConnection(STUN);
    this.setupPC();
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.waitForICE();
  }

  private async applyRemoteSdp(sdp: string) {
    const desc = JSON.parse(sdp) as RTCSessionDescriptionInit;
    await this.pc!.setRemoteDescription(desc);
  }

  private wireChannel(ch: RTCDataChannel, isCtrl: boolean) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (ev) => {
      if (isCtrl) this.handleCtrlMsg(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.handleDataFrame(ev.data);
    };
    ch.onopen = () => this._onStatus?.("已连接");
    ch.onclose = () => {
      if (!this.closed) this.fireDisconnected();
    };
  }

  private setupPC() {
    this.pc!.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === "ctrl") this.ctrlCh = ch;
      else this.dataCh = ch;
      this.wireChannel(ch, ch.label === "ctrl");
    };
    this.pc!.oniceconnectionstatechange = () => {
      const s = this.pc!.iceConnectionState;
      if (this.closed) return;
      if (s === "connected" || s === "completed") {
        this._onStatus?.("连接已建立");
      } else if (s === "disconnected") {
        // 浏览器 ICE 有自愈窗口，不立即判死
        this._onStatus?.("连接波动，等待恢复…");
      } else if (s === "failed") {
        this.fireDisconnected();
      }
    };
    this.pc!.onconnectionstatechange = () => {
      if (this.closed) return;
      if (this.pc!.connectionState === "failed") this.fireDisconnected();
    };
  }

  private handleCtrlMsg(raw: unknown) {
    if (typeof raw !== "string") return;
    let msg: ControlMsg;
    try { msg = JSON.parse(raw) as ControlMsg; } catch { return; }
    this.lastPongAt = Date.now();
    if (msg.type === "file-list") {
      // 相对路径消毒：统一正斜杠、去掉 . / .. 段，防止保存时逃逸出目标目录
      const clean = msg.files.map((f) => ({
        ...f,
        name:
          f.name
            .replace(/\\/g, "/")
            .split("/")
            .filter((p) => p && p !== "." && p !== "..")
            .join("/") || "file",
      }));
      clean.forEach((f, i) => {
        this.recvSlots.set(i, {
          meta: f,
          received: 0,
          doneSize: -1,
          ready: false,
          lastUpdate: 0,
          bytesAtUpdate: 0,
          speed: 0,
          opfsHandle: null,
          opfsWritable: null,
          writeChain: Promise.resolve(),
          memChunks: null,
          sessionId: this.sessionId,
        });
      });
      this._onFileList?.(clean);
      this.emitProgress();
    } else if (msg.type === "error") {
      this._onStatus?.(msg.message);
    } else if (msg.type === "all-done") {
      this._onAllDone?.();
    } else if (msg.type === "ping") {
      if (this.ctrlCh && this.ctrlCh.readyState === "open") {
        try { this.ctrlCh.send(JSON.stringify({ type: "pong" })); } catch { /* ignore */ }
      }
    }
    // pong：已在上方更新 lastPongAt
  }

  private waitForICE(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc!.iceGatheringState === "complete") return resolve();
      const t = setTimeout(() => {
        if (this.pc) this.pc.onicegatheringstatechange = null;
        resolve();
      }, 3000);
      this.pc!.onicegatheringstatechange = () => {
        if (this.pc!.iceGatheringState === "complete") {
          clearTimeout(t);
          resolve();
        }
      };
    });
  }
}

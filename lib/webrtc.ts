/**
 * WebRTC P2P 文件传输库
 * - 双 RTCDataChannel：ctrl（JSON 控制消息）+ data（二进制文件分块）
 * - 控制消息走 JSON 文本，支持 ping/pong 保活与文件传输完成信号
 * - 数据帧为二进制协议（帧头 12 字节 + 负载），无 JSON / base64 开销
 * - 邀请码经 /api/p2p/signaling 中继（服务端内存存储，5 分钟 TTL）
 *
 * 信令流程（host-poll 模型）：
 *   host:  createRoom()  → 注册 offer，拿到 6 位邀请码
 *          pollUntilConnected() 轮询等待 guest-answer，拿到后自动完成 WebRTC 握手
 *   guest: joinRoom(code) → guest-join 拉 offer → 回传 guest-answer
 *   host:  轮询到 answer 后 setRemoteDescription，连接建立
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
  sent: number;
  speed: number;
  done: boolean;
}

// 帧头布局（小端，共 12 字节）：
//   [0]     frameType (1B)
//   [1..4]  index (4B)
//   [5..8]  offsetLo (4B)
//   [9..11] offsetHi (3B)  — 支持最大 256TB 文件
// FRAME_FILE_CHUNK: 帧头 + 文件数据
// FRAME_FILE_DONE:  帧头（offset 字段放 totalSize）

const FRAME_FILE_CHUNK = 0x01;
const FRAME_FILE_DONE  = 0x02;
const HEADER_SIZE    = 12;
const DEFAULT_CHUNK  = 2 * 1024 * 1024;
const MAX_CHUNK      = 4 * 1024 * 1024;

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
  chunks: { offset: number; data: ArrayBuffer }[];
  received: number;
  doneSize: number;
  lastUpdate: number;
  sentBeforeUpdate: number;
  speed: number;
}

export class P2PConnection {
  private pc: RTCPeerConnection | null = null;
  private ctrlCh: RTCDataChannel | null = null;
  private dataCh: RTCDataChannel | null = null;
  private isHost = false;
  private closed = false;
  private hostCode = "";

  private _onProgress?: (files: TransferProgress[]) => void;
  private _onFileList?: (files: FileMeta[]) => void;
  private _onStatus?: (s: string) => void;
  private _onAllDone?: () => void;
  private _onDisconnected?: () => void;
  private iceRestarting = false;
  private iceFailedAt = 0;

  private recvSlots = new Map<number, RecvSlot>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private alive = false;

  get channel() { return this.ctrlCh || this.dataCh; }

  get connected() {
    const ch = this.ctrlCh || this.dataCh;
    return !!ch && ch.readyState === "open" && !this.closed;
  }

  /** 数据通道是否已就绪（用于发送前等待） */
  get dataChannelReady() {
    return !!this.dataCh && this.dataCh.readyState === "open" && !this.closed;
  }

  /** 等待数据通道就绪（最多 8s，避免刚连接好就发送时通道未 open） */
  waitForDataChannel(timeoutMs = 8000): Promise<void> {
    if (this.dataChannelReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed) { reject(new Error("连接已关闭")); return; }
        if (this.dataChannelReady) { clearInterval(timer); resolve(); return; }
      };
      const timer = setInterval(check, 100);
      setTimeout(() => { clearInterval(timer); reject(new Error("数据通道未就绪")); }, timeoutMs);
    });
  }

  setOnProgress(cb: (files: TransferProgress[]) => void) { this._onProgress = cb; }
  setOnFileList(cb: (files: FileMeta[]) => void) { this._onFileList = cb; }
  setOnStatus(cb: (s: string) => void) { this._onStatus = cb; }
  setOnAllDone(cb: () => void) { this._onAllDone = cb; }
  setOnDisconnected(cb: () => void) { this._onDisconnected = cb; }

  /** 启动 30s 心跳保活（连接建立后调用） */
  startKeepAlive() {
    this.alive = true;
    this.keepAliveTimer = setInterval(() => {
      if (!this.alive || !this.ctrlCh || this.ctrlCh.readyState !== "open") {
        this._onStatus?.("连接已断开");
        return;
      }
      this.ctrlCh.send(JSON.stringify({ type: "ping" }));
    }, 30000);
  }

  /** 发送方：创建房间，返回 6 位邀请码 */
  async createRoom(): Promise<string> {
    this.isHost = true;
    const offerSdp = await this.makeOffer();
    const res = await fetch("/api/p2p/signaling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "host-create", sdp: offerSdp }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "创建房间失败");
    this.hostCode = data.code as string;
    return data.code as string;
  }

  /** 发送方：轮询等待接收方加入，拿到 answer 后自动完成 WebRTC 握手 */
  async pollUntilConnected(): Promise<void> {
    const startedAt = Date.now();
    while (true) {
      if (this.closed) throw new Error("poll-cancelled");
      let res: Response;
      try {
        res = await fetch("/api/p2p/signaling", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "host-poll", code: this.hostCode }),
        });
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const data = await res.json();
      if (res.ok && data.joined && data.answer) {
        await this.applyRemoteSdp(data.answer);
        this.startKeepAlive();
        this._onStatus?.("连接已建立");
        return;
      }
      if (res.status === 404) {
        throw new Error("房间已过期，请重新生成邀请码");
      }
      if (!res.ok) throw new Error(data.error || "轮询失败");
      // 30 秒内无人连接 → 主动放弃（避免无限空转）
      if (Date.now() - startedAt > 30000) {
        throw new Error("等待连接超时（30秒），请重新生成邀请码");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** 接收方：凭邀请码完成信令交换并建立连接 */
  async joinRoom(code: string): Promise<void> {
    this.isHost = false;
    const normalized = code.trim().toUpperCase();

    // 1. 拉取 host 的 offer
    const joinRes = await fetch("/api/p2p/signaling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "guest-join", code: normalized }),
    });
    const joinData = await joinRes.json();
    if (!joinRes.ok) throw new Error(joinData.error || "连接失败");

    // 2. 生成并回传 answer
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
    const ansData = await ansRes.json();
    if (!ansRes.ok) throw new Error(ansData.error || "确认连接失败");

    this.startKeepAlive();
    this._onStatus?.("连接已建立");
  }

  /** 发送文件清单（控制通道，JSON） */
  sendFileList(files: FileMeta[]) {
    if (!this.ctrlCh || this.ctrlCh.readyState !== "open") return;
    const msg: ControlMsg = { type: "file-list", files };
    this.ctrlCh.send(JSON.stringify(msg));
    this._onStatus?.(`已发送 ${files.length} 个文件的清单`);
  }

  /** 发送文件传输全部完成信号（控制通道） */
  sendAllDone() {
    if (!this.ctrlCh || this.ctrlCh.readyState !== "open") return;
    const msg: ControlMsg = { type: "all-done" };
    this.ctrlCh.send(JSON.stringify(msg));
  }

  /**
   * 发送单个文件。index 必须与 sendFileList 中的位置一致。
   * 分块发送，帧头 + 二进制负载直传。
   */
  async sendFile(file: File, index: number, chunkSize = DEFAULT_CHUNK): Promise<void> {
    if (!this.dataCh || this.dataCh.readyState !== "open") throw new Error("数据通道未就绪，连接未完全建立");
    const step = Math.max(128 * 1024, Math.min(chunkSize, MAX_CHUNK));
    const startAt = performance.now();
    let lastProgressAt = 0;

    for (let offset = 0; offset < file.size; offset += step) {
      if (this.closed) throw new Error("连接已断开");
      const slice = file.slice(offset, Math.min(offset + step, file.size));
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
      await this.safeSendData(frame.buffer);

      const now = performance.now();
      if (now - lastProgressAt > 200 || offset + step >= file.size) {
        lastProgressAt = now;
        this.updateProgressForSender(index, offset + Math.min(step, file.size - offset), file.size, now - startAt);
      }
    }

    // 文件完成帧（offset 字段存 totalSize）
    const doneFrame = new Uint8Array(HEADER_SIZE);
    const dv = new DataView(doneFrame.buffer);
    dv.setUint8(0, FRAME_FILE_DONE);
    dv.setUint32(1, index, true);
    dv.setUint32(5, file.size >>> 0, true);
    const hi2 = Math.floor(file.size / 0x100000000);
    dv.setUint8(9, hi2 & 0xff);
    dv.setUint8(10, (hi2 >>> 8) & 0xff);
    dv.setUint8(11, (hi2 >>> 16) & 0xff);
    await this.safeSendData(doneFrame.buffer);
    this.updateProgressForSender(index, file.size, file.size, performance.now() - startAt);
  }

  /** 接收方：某文件是否已完整收到 */
  isFileDone(index: number): boolean {
    const p = this.buildProgress().find((x) => x.index === index);
    return !!p && p.done;
  }

  /** 接收方：组装已完成的文件为 Blob */
  getReceivedBlob(index: number): Blob | null {
    const slot = this.recvSlots.get(index);
    if (!slot || slot.chunks.length === 0) return null;
    const sorted = slot.chunks.slice().sort((a, b) => a.offset - b.offset);
    return new Blob(sorted.map((c) => c.data));
  }

  /** 释放接收端缓存（完成下载后调用，避免大文件占用内存） */
  releaseReceived(index: number) {
    const slot = this.recvSlots.get(index);
    if (!slot) return;
    slot.chunks = [];
    slot.received = 0;
    slot.doneSize = 0;
  }

  /**
   * 安全发送：若 data 通道因 ICE 重连等原因短暂断开，自动等待其重新 open（最多 5s）
   */
  private async safeSendData(buffer: ArrayBuffer): Promise<void> {
    // 连接刚失败（ICE failed / connectionState 异常）→ 快速失败，避免 50×100ms 无谓等待
    if (this.iceFailedAt && Date.now() - this.iceFailedAt < 3000) {
      throw new Error("连接已断开，请重新连接后再发送");
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (this.closed) throw new Error('连接已断开');
      const ch = this.dataCh;
      if (!ch) throw new Error('数据通道不存在');
      if (ch.readyState === 'open') {
        ch.send(buffer);
        return;
      }
      if (ch.readyState === 'closed' || ch.readyState === 'closing') {
        throw new Error('数据通道已关闭 (readyState=' + ch.readyState + ')');
      }
      // connecting — wait 100ms
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('数据通道超时未就绪');
  }

  close() {
    this.closed = true;
    this.alive = false;
    this.iceFailedAt = Date.now();
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    this.ctrlCh?.close();
    this.dataCh?.close();
    this.pc?.close();
    this.pc = null;
    this.ctrlCh = null;
    this.dataCh = null;
  }

  // ── 内部 ─────────────────────────────────────────────────

  private async makeOffer(): Promise<string> {
    this.pc = new RTCPeerConnection(STUN);
    this.setupPC();
    this.ctrlCh = this.pc.createDataChannel("ctrl", { ordered: true });
    this.dataCh = this.pc.createDataChannel("data", { ordered: true });
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
    // ctrl 通道由 host 侧 create()，guest 需显式关闭，避免 host 侧 channel 悬挂
    setTimeout(() => { if (!this.closed && this.ctrlCh && this.ctrlCh.readyState !== "closed") this.ctrlCh.close(); }, 2000);
  }

  private async applyRemoteSdp(sdp: string) {
    const desc = JSON.parse(sdp) as RTCSessionDescriptionInit;
    await this.pc!.setRemoteDescription(desc);
  }

  private setupPC() {
    this.pc!.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === "ctrl") this.ctrlCh = ch;
      else this.dataCh = ch;
      ch.onmessage = (ev) => this.handleMsg(ev.data, ch.label === "ctrl");
      ch.onopen = () => this._onStatus?.("已连接");
      ch.onclose = () => { this._onStatus?.("连接已关闭"); this._onDisconnected?.(); };
    };
    this.pc!.oniceconnectionstatechange = () => {
      const s = this.pc!.iceConnectionState;
      if (this.closed) return;
      if (s === "connected" || s === "completed") {
        this.iceRestarting = false;
        this._onStatus?.("连接已建立");
      } else if (s === "disconnected") {
        // disconnected ≠ 彻底断开：浏览器 ICE 可自愈，给恢复窗口，期间自动 restartIce 一次
        if (!this.iceRestarting) {
          this.iceRestarting = true;
          this.iceFailedAt = Date.now();
          this._onStatus?.("连接波动，正在自动恢复…");
          setTimeout(() => {
            if (!this.iceRestarting || this.closed || !this.pc) return;
            if (this.pc.iceConnectionState === "disconnected" || this.pc.iceConnectionState === "failed") {
              try { this.pc.restartIce(); } catch { /* ignore */ }
            }
          }, 8000);
        }
      } else if (s === "failed") {
        this.iceFailedAt = Date.now();
        this._onStatus?.("连接中断，请重新连接");
        this._onDisconnected?.();
      }
    };
    this.pc!.onconnectionstatechange = () => {
      const cs = this.pc!.connectionState;
      if (this.closed) return;
      if (cs === "failed" || cs === "disconnected") {
        // 连接彻底不可用：立即关闭双通道，让进行中的发送以明确错误失败
        this.iceFailedAt = Date.now();
        this.ctrlCh?.close();
        this.dataCh?.close();
        this._onStatus?.("连接已断开");
        this._onDisconnected?.();
      }
    };
  }

  private handleMsg(raw: string | ArrayBuffer, isCtrl: boolean) {
    if (isCtrl) {
      if (typeof raw !== "string") return;
      let msg: ControlMsg;
      try { msg = JSON.parse(raw) as ControlMsg; } catch { return; }
      if (msg.type === "file-list") {
        msg.files.forEach((f, i) => {
          this.recvSlots.set(i, { meta: f, chunks: [], received: 0, doneSize: 0, lastUpdate: 0, sentBeforeUpdate: 0, speed: 0 });
        });
        this._onFileList?.(msg.files);
        this._onProgress?.(this.buildProgress());
      } else if (msg.type === "error") {
        this._onStatus?.(msg.message);
      } else if (msg.type === "all-done") {
        this._onAllDone?.();
        this._onProgress?.(this.buildProgress());
      } else if (msg.type === "ping") {
        if (this.ctrlCh && this.ctrlCh.readyState === "open") {
          this.ctrlCh.send(JSON.stringify({ type: "pong" }));
        }
      }
      return;
    }

    // 数据通道：二进制帧
    if (!(raw instanceof ArrayBuffer) || raw.byteLength < HEADER_SIZE) return;
    const view = new DataView(raw);
    const frameType = view.getUint8(0);
    const index = view.getUint32(1, true);
    const lo = view.getUint32(5, true);
    const hi = view.getUint8(9) | (view.getUint8(10) << 8) | (view.getUint8(11) << 16);
    const offset = lo + hi * 0x100000000;

    if (frameType === FRAME_FILE_CHUNK) {
      const payload = raw.slice(HEADER_SIZE);
      let slot = this.recvSlots.get(index);
      if (!slot) {
        slot = { meta: { name: `file_${index}`, size: 0 }, chunks: [], received: 0, doneSize: 0, lastUpdate: 0, sentBeforeUpdate: 0, speed: 0 };
        this.recvSlots.set(index, slot);
      }
      slot.chunks.push({ offset, data: payload });
      slot.received += payload.byteLength;
      const now = performance.now();
      const dt = (now - slot.lastUpdate) / 1000;
      if (dt > 0.2) {
        const delta = slot.received - slot.sentBeforeUpdate;
        slot.speed = delta > 0 ? delta / dt : 0;
        slot.sentBeforeUpdate = slot.received;
        slot.lastUpdate = now;
      }
      this._onProgress?.(this.buildProgress());
    } else if (frameType === FRAME_FILE_DONE) {
      const slot = this.recvSlots.get(index);
      if (slot) {
        slot.doneSize = offset;
        this._onProgress?.(this.buildProgress());
      }
    }
  }

  private buildProgress(): TransferProgress[] {
    const arr: TransferProgress[] = [];
    for (const [index, slot] of this.recvSlots) {
      const total = slot.doneSize || slot.meta.size || 0;
      arr.push({
        index,
        name: slot.meta.name,
        total,
        sent: Math.min(slot.received, total || slot.received),
        speed: slot.speed || 0,
        done: total > 0 && slot.received >= total,
      });
    }
    return arr;
  }

  private updateProgressForSender(index: number, received: number, total: number, elapsedMs: number) {
    let slot = this.recvSlots.get(index);
    if (!slot) {
      slot = { meta: { name: `file_${index}`, size: total }, chunks: [], received: 0, doneSize: 0, lastUpdate: 0, sentBeforeUpdate: 0, speed: 0 };
      this.recvSlots.set(index, slot);
    }
    slot.received = received;
    slot.doneSize = total;
    if (received >= total && elapsedMs > 0) {
      slot.speed = (total - slot.sentBeforeUpdate) / (elapsedMs / 1000);
      slot.sentBeforeUpdate = total;
    }
    this._onProgress?.(this.buildProgress());
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

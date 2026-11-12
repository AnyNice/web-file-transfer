"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import QRCode from "qrcode";
import { P2PConnection, FileMeta, TransferProgress, ReceivedFile } from "@/lib/webrtc";

type FileEntry = {
  name: string;
  type: "file" | "folder";
  path: string;
  size: number;
  modified: string;
  children?: FileEntry[];
};

type P2PSide = "host" | "guest";
type P2PStatus = "idle" | "creating" | "waiting" | "connected" | "transferring" | "done";
type UploadStatus = "idle" | "uploading" | "success" | "error";
type ServerStatus = "online" | "offline" | "checking";

export default function TransferApp() {
  // View toggle: false = upload/download merged view, true = P2P view
  const [showP2P, setShowP2P] = useState(false);
  // 主机文件区当前所在目录（"" = 根目录），文件夹点进逐层导航用
  const [currentDir, setCurrentDir] = useState("");

  // Upload state
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [uploadFileMeta, setUploadFileMeta] = useState<{ name: string; size: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const p2pFileInputRef = useRef<HTMLInputElement>(null);
  const p2pFolderInputRef = useRef<HTMLInputElement>(null);
  const p2pErrorRef = useRef("");
  const p2pStatusRef = useRef<string>("idle");
  const transferProgressRef = useRef<TransferProgress[]>([]);

  // Pending upload queue
  const [pendingUploadQueue, setPendingUploadQueue] = useState<{ file: File; name: string; size: number }[]>([]);
  const [currentUploadIndex, setCurrentUploadIndex] = useState(0);

  // XHR refs for cancel
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const uploadStartRef = useRef<number>(0);
  const uploadLoadedRef = useRef<number>(0);
  const speedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // P2P state
  const [p2pSide, setP2pSide] = useState<P2PSide>("host");
  const [p2pStatus, setP2pStatus] = useState<P2PStatus>("idle");
  const [p2pStatusText, setP2pStatusText] = useState("");
  const [p2pCode, setP2pCode] = useState("");
  const [offerSdp, setOfferSdp] = useState("");
  const [pasteOffer, setPasteOffer] = useState("");
  const [transferProgress, setTransferProgress] = useState<TransferProgress[]>([]);
  const [failedFiles, setFailedFiles] = useState<number[]>([]);
  const [p2pError, setP2pError] = useState("");
  const [p2pSpeed, setP2pSpeed] = useState(0);
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [p2pAllDone, setP2pAllDone] = useState(false);
  const [peerName, setPeerName] = useState("");
  const [p2pSending, setP2pSending] = useState(false);
  const p2pRef = useRef<P2PConnection | null>(null);

  // Auth state（访问口令）
  const [authState, setAuthState] = useState<"checking" | "needed" | "ok">("checking");
  const [authCode, setAuthCode] = useState("");
  const [authError, setAuthError] = useState("");

  // P2P 已接收文件（OPFS 流式落盘后的可下载句柄）
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const allDoneSignalRef = useRef(false);

  // Server status state
  const [serverStatus, setServerStatus] = useState<ServerStatus>("checking");
  const serverCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 主机信息（口令 + 局域网地址，登录后从 /api/hostinfo 拉取）与顶栏弹层
  const [hostInfo, setHostInfo] = useState<{ accessCode: string; lanUrls: string[] } | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [qrImg, setQrImg] = useState("");
  const [qrIdx, setQrIdx] = useState(0);

  useEffect(() => {
    if (authState !== "ok") return;
    (async () => {
      try {
        const res = await fetch("/api/hostinfo");
        if (res.ok) setHostInfo(await res.json());
      } catch { /* 拿不到不影响主功能 */ }
    })();
  }, [authState]);

  const qrTarget = hostInfo?.lanUrls[qrIdx] || hostInfo?.lanUrls[0] || "";
  useEffect(() => {
    if (!showQr || !qrTarget) return;
    QRCode.toDataURL(qrTarget, { width: 220, margin: 1 })
      .then(setQrImg)
      .catch(() => setQrImg(""));
  }, [showQr, qrTarget]);

  // Downloading file state
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const downloadStartRef = useRef<number>(0);
  const downloadLoadedRef = useRef<number>(0);
  const downloadAbortRef = useRef<AbortController | null>(null);

  // ── Helpers ─────────────────────────────────────────────
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec === 0) return "0 B/s";
    const k = 1024;
    const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatTime = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ── Server health check ──────────────────────────────────
  const checkServerHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/files");
      if (res.status === 401) {
        setAuthState("needed");
        setServerStatus("offline");
        return;
      }
      if (res.ok) {
        setServerStatus("online");
      } else {
        setServerStatus("offline");
      }
    } catch {
      setServerStatus("offline");
    }
  }, []);

  useEffect(() => {
    checkServerHealth();
    serverCheckRef.current = setInterval(checkServerHealth, 10000);
    return () => {
      if (serverCheckRef.current) clearInterval(serverCheckRef.current);
    };
  }, [checkServerHealth]);

  // ── Auth ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/auth");
        const data = await res.json();
        setAuthState(data.authed ? "ok" : "needed");
      } catch {
        setAuthState("needed");
      }
    })();
  }, []);

  const submitAuth = async () => {
    setAuthError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: authCode.trim() }),
      });
      if (res.ok) {
        setAuthState("ok");
        setAuthCode("");
        fetchFiles();
        checkServerHealth();
      } else {
        const data = await res.json().catch(() => ({}));
        setAuthError(data.error || "口令不正确");
      }
    } catch {
      setAuthError("网络错误，请重试");
    }
  };

  // ── Fetch files ──────────────────────────────────────────
  const fetchFiles = async () => {
    try {
      const res = await fetch("/api/files");
      if (res.status === 401) {
        setAuthState("needed");
        return;
      }
      const data = await res.json();
      setFiles(data.files || []);
    } catch {
      // ignore
    }
  };

  const handleDelete = async (f: FileEntry) => {
    if (!window.confirm(`确定删除 ${f.path}？${f.type === "folder" ? "（文件夹将连同内容一起删除）" : ""}`)) return;
    try {
      const url = `/api/files/${f.path.split("/").map(encodeURIComponent).join("/")}`;
      const res = await fetch(url, { method: "DELETE" });
      if (res.status === 401) { setAuthState("needed"); return; }
      fetchFiles();
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchFiles();
    return () => {
      p2pRef.current?.close();
      if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
      if (downloadAbortRef.current) {
        downloadAbortRef.current.abort();
      }
    };
  }, []);

  // ── Upload ──────────────────────────────────────────────
  const handleSelectFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const newFiles: { file: File; name: string; size: number }[] = [];
    for (let i = 0; i < fileList.length; i++) {
      newFiles.push({ file: fileList[i], name: (fileList[i] as any).webkitRelativePath || fileList[i].name, size: fileList[i].size });
    }

    setPendingUploadQueue(prev => [...prev, ...newFiles]);
    setUploadStatus("idle");
    setUploadProgress(0);
    setUploadSpeed(0);
    e.target.value = "";
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // 旧实现里 entry.file() 的异步回调与 readEntries 回调赛跑，文件会丢、
    // 且同一批文件又被 dataTransfer.files 循环重复加入。新实现全程 await 收集。
    const collected: { file: File; name: string; size: number }[] = [];
    const readFile = (entry: FileSystemFileEntry, path: string) =>
      new Promise<void>((resolve) => {
        entry.file(
          (f) => { collected.push({ file: f, name: path + f.name, size: f.size }); resolve(); },
          () => resolve()
        );
      });
    const readDir = async (dirEntry: FileSystemDirectoryEntry, path: string): Promise<void> => {
      const reader = dirEntry.createReader();
      for (;;) {
        const entries = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries((r) => resolve(r), () => resolve([]))
        );
        if (entries.length === 0) break;
        for (const en of entries) {
          if (en.isFile) await readFile(en as FileSystemFileEntry, path);
          else if (en.isDirectory) await readDir(en as FileSystemDirectoryEntry, path + en.name + "/");
        }
      }
    };
    let usedEntries = false;
    const items = e.dataTransfer.items;
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) {
        usedEntries = true;
        if (entry.isFile) await readFile(entry as FileSystemFileEntry, "");
        else if (entry.isDirectory) await readDir(entry as FileSystemDirectoryEntry, entry.name + "/");
      }
    }
    if (!usedEntries) {
      const transferFiles = e.dataTransfer.files;
      for (let i = 0; i < transferFiles.length; i++) {
        collected.push({ file: transferFiles[i], name: transferFiles[i].name, size: transferFiles[i].size });
      }
    }
    if (collected.length > 0) {
      setPendingUploadQueue((prev) => [...prev, ...collected]);
      setUploadStatus("idle");
      setUploadProgress(0);
      setUploadSpeed(0);
    }
  }, []);

  const startUpload = useCallback(async () => {
    if (pendingUploadQueue.length === 0) return;

    if (xhrRef.current) xhrRef.current.abort();
    if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);

    const totalFiles = pendingUploadQueue.length;
    let completedFiles = 0;

    for (let i = 0; i < totalFiles; i++) {
      setCurrentUploadIndex(i);
      const item = pendingUploadQueue[i];

      setUploadStatus("uploading");
      setUploadFileMeta({ name: item.name, size: item.size });
      setUploadProgress(0);
      setUploadSpeed(0);
      uploadStartRef.current = Date.now();
      uploadLoadedRef.current = 0;

      if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = setInterval(() => {
        const now = Date.now();
        const elapsed = (now - uploadStartRef.current) / 1000;
        if (elapsed > 0) {
          const speed = uploadLoadedRef.current / elapsed;
          setUploadSpeed(speed);
        }
      }, 500);

      const formData = new FormData();
      formData.append("file", item.file, item.name.split("/").pop() || item.name);

      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;

      await new Promise<void>((resolve, reject) => {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable && item.size > 0) {
            const loaded = e.loaded;
            uploadLoadedRef.current = loaded;
            setUploadProgress(Math.round((loaded / item.size) * 100));
          }
        });

        xhr.addEventListener("load", () => {
          if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
          xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            completedFiles++;
            const overallProgress = Math.round((completedFiles / totalFiles) * 100);
            setUploadProgress(overallProgress);
            setUploadFileMeta({ name: item.name, size: item.size });
            resolve();
          } else {
            setUploadStatus("error");
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        });

        xhr.addEventListener("error", () => {
          if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
          xhrRef.current = null;
          setUploadStatus("error");
          reject(new Error("Network error"));
        });

        xhr.open("POST", "/api/upload");
        if (item.name.includes("/")) {
          xhr.setRequestHeader("X-File-Path", encodeURIComponent(item.name));
        }
        xhr.send(formData);
      });
    }

    setUploadStatus("success");
    setUploadProgress(100);
    setUploadSpeed(0);
    setPendingUploadQueue([]);
    setCurrentUploadIndex(0);
    fetchFiles();
  }, [pendingUploadQueue]);

  const cancelUpload = useCallback(() => {
    if (xhrRef.current) xhrRef.current.abort();
    if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
    setUploadStatus("idle");
    setUploadProgress(0);
    setUploadSpeed(0);
    setPendingUploadQueue([]);
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    setPendingUploadQueue(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearQueue = useCallback(() => {
    setPendingUploadQueue([]);
    setUploadStatus("idle");
    setUploadProgress(0);
    setUploadSpeed(0);
  }, []);

  // ── P2P ─────────────────────────────────────────────────
  // 收到 all-done 信号后，还要等每个文件都真正落盘完成（ready）才算接收完成
  const maybeFinishReceiving = () => {
    if (!allDoneSignalRef.current) return;
    const prog = transferProgressRef.current;
    if (prog.length > 0 && prog.every((p) => p.done)) {
      setP2pAllDone(true);
      p2pStatusRef.current = "done"; setP2pStatus("done");
      setP2pStatusText("全部文件已接收");
    }
  };

  const handleP2PHost = async () => {
    try {
      p2pStatusRef.current = "creating"; setP2pStatus("creating");
      setP2pStatusText("正在创建房间...");
      p2pErrorRef.current = ""; setP2pError("");
      const conn = new P2PConnection();
      p2pRef.current = conn;

      conn.setOnDisconnected(() => { p2pErrorRef.current = "连接已断开"; setP2pError("连接已断开"); p2pStatusRef.current = "idle"; setP2pStatus("idle"); setPeerName(""); });
      conn.setOnStatus((s) => { if (!p2pErrorRef.current) setP2pStatusText(s); });
      conn.setOnProgress((prog) => {
        transferProgressRef.current = prog; setTransferProgress(prog);
        const active = prog.find((x) => !x.done);
        setP2pSpeed(active ? active.speed : 0);
        maybeFinishReceiving();
      });
      conn.setOnFileReady((f) => {
        setReceivedFiles((prev) => [...prev.filter((x) => x.index !== f.index), f]);
      });
      conn.setOnAllDone(() => { allDoneSignalRef.current = true; maybeFinishReceiving(); });

      transferProgressRef.current = []; setTransferProgress([]);
      setP2pSpeed(0);
      setP2pAllDone(false);
      setPeerName("");
      setLocalFiles([]);
      const code = await conn.createRoom();
      setP2pCode(code);
      p2pStatusRef.current = "waiting"; setP2pStatus("waiting");
      setP2pStatusText("邀请码已生成，等待对方连接…");

      // 轮询等待接收方加入
      conn.pollUntilConnected().then(() => {
        if (p2pRef.current !== conn) return; // 用户已断开/重置，忽略
        p2pStatusRef.current = "connected"; setP2pStatus("connected");
        setP2pStatusText("已连接，请选择文件发送");
      }).catch((err) => {
        if (p2pRef.current !== conn) return; // 用户主动断开，静默处理
        if (err && (err.message === "poll-cancelled" || err.message === "closed")) return;
        p2pErrorRef.current = String(err);
        setP2pError(p2pErrorRef.current);
        p2pStatusRef.current = "idle"; setP2pStatus("idle");
      });
    } catch (err) {
      setP2pError(String(err));
      p2pStatusRef.current = "idle"; setP2pStatus("idle");
    }
  };

  const handleP2PGuest = async () => {
    if (!pasteOffer.trim() || pasteOffer.trim().length !== 6) {
      p2pErrorRef.current = "请输入 6 位邀请码"; setP2pError("请输入 6 位邀请码");
      return;
    }
    try {
      p2pStatusRef.current = "creating"; setP2pStatus("creating");
      setP2pStatusText("正在建立连接...");
      p2pErrorRef.current = ""; setP2pError("");
      const code = pasteOffer.trim().toUpperCase();

      const conn = new P2PConnection();
      p2pRef.current = conn;
      conn.setOnDisconnected(() => { p2pErrorRef.current = "连接已断开"; setP2pError("连接已断开"); p2pStatusRef.current = "idle"; setP2pStatus("idle"); setPeerName(""); });
      conn.setOnStatus((s) => { if (!p2pErrorRef.current) setP2pStatusText(s); });
      conn.setOnProgress((prog) => {
        transferProgressRef.current = prog; setTransferProgress(prog);
        const active = prog.find((x) => !x.done);
        setP2pSpeed(active ? active.speed : 0);
        maybeFinishReceiving();
      });
      conn.setOnFileReady((f) => {
        setReceivedFiles((prev) => [...prev.filter((x) => x.index !== f.index), f]);
      });
      conn.setOnFileList((list) => {
        setPeerName(list.length > 0 ? `${list.length} 个文件` : "");
      });
      conn.setOnAllDone(() => { allDoneSignalRef.current = true; maybeFinishReceiving(); });
      transferProgressRef.current = []; setTransferProgress([]);
      setP2pSpeed(0);
      setP2pAllDone(false);
      setPeerName("");
      await conn.joinRoom(code);
      p2pStatusRef.current = "connected"; setP2pStatus("connected");
      setP2pStatusText("已连接，等待接收文件…");
    } catch (err) {
      setP2pError(String(err));
      p2pStatusRef.current = "idle"; setP2pStatus("idle");
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  const sendFilesToPeer = async () => {
    const conn = p2pRef.current;
    if (!conn || !conn.connected) {
      p2pErrorRef.current = "连接未建立"; setP2pError("连接未建立");
      return;
    }
    if (localFiles.length === 0) {
      p2pErrorRef.current = "请先选择要发送的本机文件"; setP2pError("请先选择要发送的本机文件");
      return;
    }
    p2pStatusRef.current = "transferring"; setP2pStatus("transferring");
    setP2pStatusText("正在发送文件...");
    p2pErrorRef.current = ""; setP2pError("");
    setP2pSending(true);

    // 直接把本机文件通过 P2P 通道发给对方（不经过服务器）
    const metaList: FileMeta[] = localFiles.map((f) => ({
      // 文件夹发送时带相对路径，接收端按原目录结构保存
      name: (f as any).webkitRelativePath || f.name,
      size: f.size,
      mime: f.type || undefined,
      lastModified: f.lastModified || undefined,
    }));
    // 等待数据通道完全就绪（连接刚建立时 data 通道可能还在 connecting 状态）
    try {
      await conn.waitForDataChannel();
    } catch (err) {
      console.error("[P2P] 数据通道未就绪:", err);
      p2pErrorRef.current = `数据通道未就绪: ${String(err)}`;
      setP2pError(p2pErrorRef.current);
      setP2pSending(false);
      p2pStatusRef.current = "connected"; setP2pStatus("connected");
      setP2pStatusText("数据通道未就绪，请重新发送");
      return;
    }

    conn.sendFileList(metaList);

    for (let i = 0; i < localFiles.length; i++) {
      const file = localFiles[i];
      try {
        await conn.sendFile(file, i);
      } catch (err) {
        // 网络瞬断自愈重试：再等通道最多 8s，重发整个文件一次
        let recovered = false;
        try {
          await conn.waitForDataChannel();
          await conn.sendFile(file, i);
          recovered = true;
        } catch { /* 仍失败则走下方报错 */ }
        if (!recovered) {
          console.error("[P2P] 文件发送失败:", file.name, err);
          p2pErrorRef.current = `文件发送失败: ${file.name}（${String(err)}）`;
          setP2pError(p2pErrorRef.current);
          setP2pSending(false);
          p2pStatusRef.current = "connected"; setP2pStatus("connected");
          setP2pStatusText("发送中断，可重新发送");
          return;
        }
      }
    }
    conn.sendAllDone();
    p2pStatusRef.current = "done"; setP2pStatus("done");
    setP2pStatusText("传输完成 ✓");
    setP2pSending(false);
  };

  const resetP2P = () => {
    for (const f of receivedFiles) { f.cleanup().catch(() => {}); }
    setReceivedFiles([]);
    allDoneSignalRef.current = false;
    p2pRef.current?.close();
    p2pRef.current = null;
    p2pStatusRef.current = "idle"; setP2pStatus("idle");
    setP2pStatusText("");
    setP2pCode("");
    setPasteOffer("");
    transferProgressRef.current = []; setTransferProgress([]);
    setP2pSpeed(0);
    p2pErrorRef.current = ""; setP2pError("");
    setP2pAllDone(false);
    setLocalFiles([]);
    setPeerName("");
    setP2pSending(false);
  };

  // 发送方：从本机选择文件（多文件 / 文件夹），与服务器文件无关
  const addLocalFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const next: File[] = [];
    for (const f of Array.from(list)) next.push(f);
    setLocalFiles((prev) => {
      const known = new Set(prev.map((x) => x.name + "|" + x.size));
      const fresh = next.filter((f) => !known.has(f.name + "|" + f.size));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  };

  const removeLocalFile = (index: number) => {
    setLocalFiles((prev) => prev.filter((_, i) => i !== index));
  };
  const downloadReceivedFiles = async () => {
    // v2：文件已流式落在 OPFS 里，这里只是把数据搬到用户磁盘，不再把 Blob 拼回内存
    // 带相对路径（文件夹发送）且浏览器支持时：让用户选一个目标文件夹，按原目录结构流式写盘
    const win = window as any;
    const hasPaths = receivedFiles.some((f) => f.name.includes("/"));
    if (hasPaths && win.showDirectoryPicker && window.isSecureContext) {
      let root: any = null;
      try {
        root = await win.showDirectoryPicker();
      } catch {
        return; // 用户取消选择，文件仍保留在待下载列表
      }
      for (const f of receivedFiles) {
        try {
          const parts = f.name.split("/").filter(Boolean);
          let dir = root;
          for (const seg of parts.slice(0, -1)) {
            dir = await dir.getDirectoryHandle(seg, { create: true });
          }
          const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
          const writable = await fh.createWritable();
          const resp = await fetch(f.url);
          if (resp.body) {
            await resp.body.pipeTo(writable);
          } else {
            await writable.write(await resp.blob());
            await writable.close();
          }
          const cleanup = f.cleanup;
          setTimeout(() => { cleanup().catch(() => {}); }, 5000);
        } catch (err) {
          console.error("保存接收文件失败:", f.name, err);
        }
      }
      setReceivedFiles([]);
      return;
    }
    // 兜底：逐个触发浏览器下载；相对路径拍平为文件名，同名自动加 _1、_2 后缀防覆盖
    const used = new Map<string, number>();
    for (const f of receivedFiles) {
      const base = f.name.split("/").filter(Boolean).pop() || "file";
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      let saveName = base;
      if (n > 0) {
        const dot = base.lastIndexOf(".");
        saveName = dot > 0 ? `${base.slice(0, dot)}_${n}${base.slice(dot)}` : `${base}_${n}`;
      }
      const a = document.createElement("a");
      a.href = f.url;
      a.download = saveName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      const cleanup = f.cleanup;
      setTimeout(() => { cleanup().catch(() => {}); }, 60000);
    }
    if (receivedFiles.length > 0) setReceivedFiles([]);
  };

  // ── Download ────────────────────────────────────────────
  // 大文件下载重写：旧版用 XHR 把整个文件以 Blob 拉进内存再转存，几个 GB 必卡死。
  // 新版优先 File System Access 流式写盘（带真实进度），否则用浏览器原生下载
  // （浏览器自己流式落盘，同样不进页面内存），服务端已支持 Range。
  const handleDownload = async (file: FileEntry) => {
    const url = `/api/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    // 文件夹走服务端流式打包，保存名为 <文件夹>.zip；打包总量未知，进度按已下载字节显示
    const isFolder = file.type === "folder";
    const saveName = isFolder ? `${file.name}.zip` : file.name;
    const total = isFolder ? 0 : file.size;
    const win = window as any;
    if (win.showSaveFilePicker && window.isSecureContext) {
      let handle: any = null;
      try {
        handle = await win.showSaveFilePicker({ suggestedName: saveName });
      } catch (err: any) {
        if (err?.name === "AbortError") return; // 用户取消选择
        handle = null; // 选择器异常则落到下方原生下载兜底，不能点了没反应
      }
      if (handle) {
      const abort = new AbortController();
      downloadAbortRef.current = abort;
      setDownloadingPath(file.path);
      setDownloadProgress(0);
      setDownloadSpeed(0);
      setDownloadBytes(0);
      downloadStartRef.current = Date.now();
      try {
        const res = await fetch(url, { signal: abort.signal });
        if (res.status === 401) { setAuthState("needed"); throw new Error("登录已失效"); }
        if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
        const writable = await handle.createWritable();
        const reader = res.body.getReader();
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          loaded += value.byteLength;
          setDownloadBytes(loaded);
          const elapsed = (Date.now() - downloadStartRef.current) / 1000;
          if (elapsed > 0) setDownloadSpeed(loaded / elapsed);
          if (total > 0) setDownloadProgress(Math.round((loaded / total) * 100));
        }
        await writable.close();
        if (total > 0) setDownloadProgress(100);
      } catch (err: any) {
        if (err?.name !== "AbortError") console.error("Download error:", err);
      } finally {
        downloadAbortRef.current = null;
        setTimeout(() => { setDownloadingPath(null); setDownloadProgress(0); setDownloadSpeed(0); setDownloadBytes(0); }, 600);
      }
      return;
      }
    }
    // 原生下载兜底：浏览器流式落盘，不占用页面内存
    const a = document.createElement("a");
    a.href = url;
    a.download = saveName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ── Badge content ───────────────────────────────────────
  const isTransferring =
    uploadStatus === "uploading" ||
    downloadingPath ||
    transferProgress.some(p => !p.done) ||
    p2pStatus === "transferring" || p2pStatus === "creating" || p2pStatus === "waiting";

  const canSwitchTab = !isTransferring;

  const getBadgeContent = () => {
    const serverDot = serverStatus === "online"
      ? "bg-green-500"
      : serverStatus === "offline"
      ? "bg-errorRed"
      : "bg-gray-400 animate-pulse";
    const serverLabel = serverStatus === "online"
      ? "服务器在线"
      : serverStatus === "offline"
      ? "服务器离线"
      : "连接中...";

    let modeLabel = "";
    if (uploadStatus === "uploading" && uploadFileMeta) {
      modeLabel = `上传中 ${uploadProgress.toFixed(0)}%`;
    } else if (uploadStatus === "success") {
      modeLabel = "✓ 上传完成";
    } else if (uploadStatus === "error") {
      modeLabel = "✗ 上传失败";
    } else if (pendingUploadQueue.length > 0) {
      modeLabel = `等待上传 (${pendingUploadQueue.length}个文件)`;
    } else if (downloadingPath) {
      modeLabel = `下载中 ${downloadProgress > 0 ? `${downloadProgress.toFixed(0)}%` : formatSize(downloadBytes)}`;
    } else if (transferProgress.some(p => !p.done)) {
      modeLabel = "接收中...";
    } else if (p2pStatus === "transferring") {
      modeLabel = "传输中";
    } else if (p2pStatus === "connected") {
      modeLabel = p2pSide === "host" ? "已连接(发)" : "已连接(收)";
    } else if (p2pStatus === "creating") {
      modeLabel = p2pSide === "host" ? "生成邀请码..." : "生成回复码...";
    } else if (p2pStatus === "waiting") {
      modeLabel = "等待连接...";
    } else {
      modeLabel = showP2P ? "P2P传输" : "就绪";
    }

    return { serverDot, serverLabel, modeLabel };
  };

  const { serverDot, serverLabel, modeLabel } = getBadgeContent();

  // 文件夹导航：按路径在文件树里逐层定位当前目录（路径失效时回根目录，
  // 例如当前文件夹刚被删除）
  const resolveDir = (path: string): { entries: FileEntry[]; valid: boolean } => {
    if (!path) return { entries: files, valid: true };
    let list = files;
    for (const part of path.split("/")) {
      const f = list.find((e) => e.type === "folder" && e.name === part);
      if (!f || !f.children) return { entries: files, valid: false };
      list = f.children;
    }
    return { entries: list, valid: true };
  };
  const dirState = resolveDir(currentDir);
  const dirEntries = dirState.entries;
  const activeDir = dirState.valid ? currentDir : "";
  const crumbParts = activeDir ? activeDir.split("/") : [];
  const subtreeSize = (list: FileEntry[]): number =>
    list.reduce((s, e) => s + (e.type === "file" ? e.size || 0 : e.children ? subtreeSize(e.children) : 0), 0);
  const dirFolderCount = dirEntries.filter((e) => e.type === "folder").length;
  const dirFileCount = dirEntries.filter((e) => e.type === "file").length;

  // ── 访问口令门（N4 风格）────────────────────────────
  if (authState !== "ok") {
    return (
      <div className="n4-page n4-login">
        <div className="n4-login-card">
          <div className="n4-login-ico">
            <i className="fa fa-lock"></i>
          </div>
          <div className="n4-login-title">需要访问口令</div>
          <p className="n4-login-hint">
            这台主机已启用口令保护<br />口令在主机项目目录 data/access-code.txt 中查看
          </p>
          <div className="n4-login-row">
            <input
              type="text" maxLength={32} inputMode="numeric" autoFocus
              className="n4-login-input"
              placeholder="6 位口令" value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAuth(); }}
            />
            <button className="n4-btn-red" onClick={submitAuth}>
              进入
            </button>
          </div>
          {authState === "checking" && <p className="n4-login-note">正在检查登录状态…</p>}
          {authError && <p className="n4-login-note" style={{ color: "#d92525" }}>{authError}</p>}
        </div>
      </div>
    );
  }

  // 文件夹内文件数（递归，卡片副文案用）
  const countInFolder = (e: FileEntry): number =>
    e.children ? e.children.reduce((s, c) => s + (c.type === "file" ? 1 : countInFolder(c)), 0) : 0;

  const toastVisible = !showP2P && (uploadStatus === "uploading" || !!downloadingPath);

  return (
    <div className="n4-page">
      {/* ── 顶栏 ── */}
      <header className="n4-top">
        <div className="n4-brand">
          <span className="n4-logo"><i className="fa fa-bolt"></i></span>
          局域网快传
        </div>
        <div className="n4-pill" role="group">
          <button
            className={!showP2P ? "on" : ""}
            onClick={() => canSwitchTab && setShowP2P(false)}
            disabled={!canSwitchTab}
          >
            服务器中转
          </button>
          <button
            className={showP2P ? "on" : ""}
            onClick={() => canSwitchTab && setShowP2P(true)}
            disabled={!canSwitchTab}
          >
            P2P传输
          </button>
        </div>
        <div className="n4-top-actions">
          <button
            className="n4-topbtn"
            onClick={() => { setShowQr((v) => !v); setShowCode(false); }}
            title="手机扫码打开本页"
          >
            <i className="fa fa-qrcode"></i><span>二维码</span>
          </button>
          <button
            className="n4-topbtn"
            onClick={() => { setShowCode((v) => !v); setShowQr(false); }}
            title="查看本机访问口令"
          >
            <i className="fa fa-key"></i><span>口令</span>
          </button>
          <span className="n4-hosttag" title={modeLabel}>
            <span className={`w-2 h-2 rounded-full ${serverDot}`}></span>
            {serverLabel}
          </span>
          {showQr && (
            <div className="n4-pop">
              <div className="n4-pop-title">扫码在手机上打开</div>
              {qrImg ? (
                <img className="n4-pop-qr" src={qrImg} alt={qrTarget} />
              ) : (
                <div className="n4-pop-loading">生成中…</div>
              )}
              <div className="n4-pop-url">{qrTarget || "未检测到局域网地址"}</div>
              {hostInfo && hostInfo.lanUrls.length > 1 && (
                <div className="n4-pop-urls">
                  {hostInfo.lanUrls.map((u, i) => (
                    <button key={u} className={i === qrIdx ? "on" : ""} onClick={() => setQrIdx(i)}>{u}</button>
                  ))}
                </div>
              )}
              <div className="n4-pop-hint">手机与本机连同一 Wi-Fi / 局域网即可</div>
            </div>
          )}
          {showCode && (
            <div className="n4-pop">
              <div className="n4-pop-title">本机访问口令</div>
              <div className="n4-pop-code">{hostInfo?.accessCode || "······"}</div>
              <button
                className="n4-btn-mini"
                onClick={() => hostInfo && copyToClipboard(hostInfo.accessCode)}
              >
                <i className="fa fa-copy"></i> 复制口令
              </button>
              <div className="n4-pop-hint">把口令告诉要传文件的人，TA 打开页面输入即可</div>
            </div>
          )}
        </div>
      </header>

      {/* ── 服务器视图 ── */}
      {!showP2P && (
        <main>
          <div className="n4-hero">
            <h1>传个文件，<em>别折腾。</em></h1>
            <p>拖进来就走 · 文件夹保留目录 · 大文件不卡</p>
          </div>

          {/* 舞台拖拽区 */}
          <div
            className={`n4-stage ${dragOver ? "drag" : ""} ${!canSwitchTab ? "busy" : ""}`}
            onDragOver={(e) => { if (!canSwitchTab) return; e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { if (!canSwitchTab) return; handleDrop(e); }}
            onClick={() => { if (!canSwitchTab) return; fileInputRef.current?.click(); }}
          >
            <div className="n4-stage-ico">
              <i className="fa fa-cloud-upload"></i>
            </div>
            <div className="n4-stage-title">{canSwitchTab ? "把文件或文件夹放在这里" : "传输进行中，请稍候…"}</div>
            <div className="n4-stage-hint">或者点下面按钮选择 · 存到主机后所有人可取</div>
            <div className="n4-stage-btns">
              <button
                className="n4-btn-red"
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                disabled={!canSwitchTab}
              >
                <i className="fa fa-upload"></i>选择文件
              </button>
              <button
                className="n4-btn-soft"
                onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click(); }}
                disabled={!canSwitchTab}
              >
                <i className="fa fa-folder-open"></i>选择文件夹
              </button>
            </div>
          </div>

          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleSelectFiles} />
          <input ref={folderInputRef} type="file" {...({ webkitdirectory: "", directory: "" } as any)} style={{ display: "none" }} onChange={handleSelectFiles} />

          {/* 待上传队列 */}
          {pendingUploadQueue.length > 0 && uploadStatus === "idle" && (
            <div className="n4-queue">
              <div className="n4-queue-head">
                <span className="n4-queue-title">
                  <i className="fa fa-list"></i>待上传队列 ({pendingUploadQueue.length}个文件)
                  <span className="n4-queue-total">总计: {formatSize(pendingUploadQueue.reduce((sum, f) => sum + f.size, 0))}</span>
                </span>
                <span className="n4-queue-actions">
                  <button className="n4-mini-btn" onClick={clearQueue}>
                    <i className="fa fa-times"></i>清空队列
                  </button>
                  <button className="n4-mini-btn red" onClick={startUpload}>
                    <i className="fa fa-upload"></i>开始上传
                  </button>
                </span>
              </div>
              <div className="n4-queue-list">
                {pendingUploadQueue.map((item, idx) => (
                  <div key={idx} className="n4-queue-row">
                    <span className="n4-queue-name">
                      <i className="fa fa-file-o"></i>
                      <span className="truncate" title={item.name}>{item.name}</span>
                      <span className="n4-queue-size">{formatSize(item.size)}</span>
                    </span>
                    <button className="n4-iconbtn" onClick={() => removeFromQueue(idx)} title="移除">
                      <i className="fa fa-times"></i>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 上传结果提示 */}
          {uploadStatus === "success" && (
            <div className="n4-banner ok">
              <i className="fa fa-check-circle"></i>
              <div>
                <div className="n4-banner-title">上传成功</div>
                <div className="n4-banner-sub">文件已保存到服务器</div>
              </div>
            </div>
          )}
          {uploadStatus === "error" && (
            <div className="n4-banner err">
              <i className="fa fa-times-circle"></i>
              <div>
                <div className="n4-banner-title">上传失败</div>
                <div className="n4-banner-sub">请重试或检查网络连接</div>
              </div>
            </div>
          )}

          {/* 主机文件区（可进入导航） */}
          <div className="n4-fpanel">
            <div className="n4-fpanel-head">
              <div className="n4-crumb">
                <button className={activeDir === "" ? "cur" : ""} onClick={() => setCurrentDir("")}>全部文件</button>
                {crumbParts.map((part, i) => (
                  <span key={i} className="n4-crumb-seg">
                    <span className="n4-crumb-sep">/</span>
                    <button
                      className={i === crumbParts.length - 1 ? "cur" : ""}
                      onClick={() => setCurrentDir(crumbParts.slice(0, i + 1).join("/"))}
                    >
                      {part}
                    </button>
                  </span>
                ))}
              </div>
              <span className="n4-fpanel-meta">
                {dirFolderCount} 个文件夹 · {dirFileCount} 个文件 · {formatSize(subtreeSize(dirEntries))}
                <button className="n4-iconbtn" onClick={fetchFiles} title="刷新">
                  <i className="fa fa-refresh"></i>
                </button>
              </span>
            </div>
            {files.length === 0 ? (
              <div className="n4-fpanel-empty">
                <p>暂无文件</p>
                <p className="n4-empty-sub">上传文件后将在此显示</p>
              </div>
            ) : dirEntries.length === 0 ? (
              <div className="n4-fpanel-empty">
                <p>这个文件夹是空的</p>
                <button className="n4-mini-btn" onClick={() => setCurrentDir(crumbParts.slice(0, -1).join("/"))}>
                  <i className="fa fa-level-up"></i>返回上一级
                </button>
              </div>
            ) : (
              <div className="n4-fgrid">
                {activeDir !== "" && (
                  <div className="n4-upcard" onClick={() => setCurrentDir(crumbParts.slice(0, -1).join("/"))}>
                    <i className="fa fa-level-up"></i>
                    <span>返回上一级</span>
                  </div>
                )}
                {dirEntries.map((f) => {
                  const isDownloading = downloadingPath === f.path;
                  const isFolder = f.type === "folder";
                  return (
                    <div
                      key={f.path}
                      className={`n4-fcard ${isFolder ? "folder" : ""}`}
                      onClick={isFolder ? () => setCurrentDir(f.path) : undefined}
                    >
                      <div className={`n4-fico ${isFolder ? "folder" : ""} ${isDownloading ? "busy" : ""}`}>
                        <i className={`fa ${isFolder ? "fa-folder-o" : "fa-file-text-o"}`}></i>
                      </div>
                      <div className="n4-fname" title={f.path}>{f.name}</div>
                      <div className="n4-fmeta">
                        {isFolder
                          ? `文件夹 · ${countInFolder(f)} 个文件`
                          : `${formatSize(f.size)} · ${formatTime(f.modified)}`}
                      </div>
                      {isDownloading && (
                        <div className="n4-fprog">
                          <div className="n4-bar">
                            <div style={{ width: downloadProgress > 0 ? `${downloadProgress}%` : "35%" }} className={downloadProgress > 0 ? "" : "indet"}></div>
                          </div>
                          <span>{downloadProgress > 0 ? `${downloadProgress.toFixed(0)}%` : formatSize(downloadBytes)} · {formatSpeed(downloadSpeed)}/s</span>
                        </div>
                      )}
                      <div className="n4-factions">
                        {isFolder && <span className="n4-enter-hint">进入 <i className="fa fa-angle-right"></i></span>}
                        {isFolder && <span className="n4-ziptag">ZIP</span>}
                        <button className="n4-iconbtn" onClick={(e) => { e.stopPropagation(); if (!isDownloading) handleDownload(f); }} title={isFolder ? "打包下载 (ZIP)" : "下载"}>
                          <i className={`fa fa-download ${isDownloading ? "fa-spin" : ""}`}></i>
                        </button>
                        <button className="n4-iconbtn danger" onClick={(e) => { e.stopPropagation(); handleDelete(f); }} title="删除">
                          <i className="fa fa-trash-o"></i>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 传输浮窗（左下） */}
          {toastVisible && (
            <div className="n4-toast">
              <div className="n4-toast-head">
                <span>正在传输</span>
                <span className="n4-toast-hint">
                  {[uploadStatus === "uploading" ? 1 : 0, downloadingPath ? 1 : 0].reduce((a, b) => a + b, 0)} 进行中
                </span>
              </div>
              {uploadStatus === "uploading" && uploadFileMeta && (
                <div className="n4-toast-item">
                  <div className="n4-toast-row">
                    <span className="n4-toast-name" title={uploadFileMeta.name}>
                      {uploadFileMeta.name}
                      {pendingUploadQueue.length > 0 && (
                        <span className="n4-toast-idx">({currentUploadIndex + 1}/{pendingUploadQueue.length + currentUploadIndex + 1})</span>
                      )}
                    </span>
                    <span className="n4-toast-stat">{uploadProgress.toFixed(0)}% · {formatSpeed(uploadSpeed)}/s</span>
                  </div>
                  <div className="n4-bar">
                    <div style={{ width: `${Math.min(uploadProgress, 100)}%` }}></div>
                  </div>
                  <button className="n4-toast-cancel" onClick={cancelUpload}>
                    <i className="fa fa-times-circle"></i>取消上传
                  </button>
                </div>
              )}
              {downloadingPath && (
                <div className="n4-toast-item">
                  <div className="n4-toast-row">
                    <span className="n4-toast-name" title={downloadingPath}>{downloadingPath.split("/").pop()}</span>
                    <span className="n4-toast-stat">
                      {downloadProgress > 0 ? `${downloadProgress.toFixed(0)}%` : formatSize(downloadBytes)} · {formatSpeed(downloadSpeed)}/s
                    </span>
                  </div>
                  <div className="n4-bar">
                    <div style={{ width: downloadProgress > 0 ? `${downloadProgress}%` : "35%" }} className={downloadProgress > 0 ? "" : "indet"}></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      )}

      {/* ── P2P 视图（P3 双栏对传） ── */}
      {showP2P && (
        <main>
          <div className="n4-hero">
            <h1>两台设备，<em>直连直传。</em></h1>
            <p>不经过主机 · 邀请码配对 · 保留目录结构</p>
          </div>

          {/* 状态行 */}
          <div className="n4-p3-statusrow">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
              p2pStatus === "idle" ? "bg-gray-100 text-gray-500"
              : p2pStatus === "creating" ? "bg-amber-50 text-amber-600"
              : p2pStatus === "waiting" ? "bg-blue-50 text-blue-600"
              : "bg-brandGreenLight text-brandGreen"
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                p2pStatus === "idle" ? "bg-gray-400"
                : p2pStatus === "creating" ? "bg-amber-400 animate-pulse"
                : p2pStatus === "waiting" ? "bg-blue-400 animate-pulse"
                : "bg-brandGreen animate-pulse"
              }`}></span>
              {p2pStatus === "idle" ? "未连接"
                : p2pStatus === "creating" ? "正在建立连接…"
                : p2pStatus === "waiting" ? (p2pSide === "host" ? "等待对方连接…" : "正在连接…")
                : p2pStatus === "done" ? "传输完成"
                : p2pStatus === "transferring" ? "传输中…"
                : "已连接"}
            </div>
            {(p2pStatus === "waiting" || p2pStatus === "connected" || p2pStatus === "transferring") && (
              <button className="text-xs text-gray-400 hover:text-gray-600 transition-colors px-2 py-1 rounded hover:bg-gray-100" onClick={resetP2P}>
                <i className="fa fa-times mr-1"></i>断开
              </button>
            )}
          </div>

          {/* 错误提示 */}
          {p2pError && (
            <div className="bg-errorRedLight rounded-codeCard p-3 text-sm text-errorRed flex items-center gap-3 mb-4" style={{ maxWidth: 980, margin: "0 auto 16px" }}>
              <i className="fa fa-exclamation-circle flex-shrink-0"></i>
              <div className="flex-1 text-xs">{p2pError}</div>
              <button className="text-xs hover:underline flex-shrink-0" onClick={() => { p2pErrorRef.current = ""; setP2pError(""); }}><i className="fa fa-times"></i></button>
            </div>
          )}

          {/* 建立中 */}
          {p2pStatus === "creating" && (
            <div className="n4-p2p-center" style={{ maxWidth: 880, margin: "0 auto" }}>
              <div className="n4-p2p-spin">
                <i className="fa fa-spinner fa-spin"></i>
              </div>
              <div className="n4-p2p-center-title">{p2pSide === "host" ? "正在创建房间…" : "正在连接…"}</div>
              <div className="n4-p2p-center-sub">{p2pStatusText}</div>
            </div>
          )}

          {p2pStatus !== "creating" && (
            <div className="n4-dual">
              {/* ── 左栏：本机 ── */}
              <div className="n4-pane">
                <div className="n4-pane-head">
                  <span className="n4-pane-title">本机 · {p2pSide === "host" ? "发送方" : "接收方"}</span>
                  {p2pStatus === "waiting" && p2pSide === "host" && p2pCode && <span className="n4-pane-tag">邀请码 {p2pCode}</span>}
                  {(p2pStatus === "connected" || p2pStatus === "transferring") && <span className="n4-pane-tag green">已连接</span>}
                  {p2pStatus === "done" && <span className="n4-pane-tag green">已完成</span>}
                </div>

                {/* 空闲：角色切换 + 入口 */}
                {p2pStatus === "idle" && (
                  <div>
                    <div className="n4-seg">
                      <button className={p2pSide === "host" ? "on" : ""} onClick={() => setP2pSide("host")}>我是发送方</button>
                      <button className={p2pSide === "guest" ? "on" : ""} onClick={() => setP2pSide("guest")}>我是接收方</button>
                    </div>
                    {p2pSide === "host" ? (
                      <div>
                        <p className="n4-pane-hint">
                          <i className="fa fa-laptop"></i>
                          生成邀请码告诉对方；连接后从本机选择文件（支持多文件 / 文件夹）直接发送，无需经过服务器
                        </p>
                        <button className="n4-btn-red" onClick={handleP2PHost} disabled={!canSwitchTab}>
                          <i className="fa fa-magic"></i>生成邀请码
                        </button>
                      </div>
                    ) : (
                      <div>
                        <p className="n4-pane-hint">输入对方生成的 6 位邀请码</p>
                        <div className="n4-login-row" style={{ justifyContent: "flex-start" }}>
                          <input
                            type="text" maxLength={6} inputMode="numeric"
                            className="n4-login-input"
                            placeholder="000000" value={pasteOffer}
                            onChange={(e) => setPasteOffer(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          />
                          <button className="n4-btn-red" onClick={handleP2PGuest} disabled={pasteOffer.length !== 6 || !canSwitchTab}>
                            <i className="fa fa-paper-plane"></i>连接
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 等待连接（host）：邀请码 */}
                {p2pStatus === "waiting" && p2pSide === "host" && p2pCode && (
                  <div>
                    <div className="text-5xl font-mono font-bold text-errorRed tracking-[0.4em] mb-3 select-all">{p2pCode}</div>
                    <p className="n4-pane-hint">把邀请码告诉对方，输入后即可建立连接（10 分钟内有效）</p>
                    <button className="n4-mini-btn" onClick={() => copyToClipboard(p2pCode)}>
                      <i className="fa fa-copy"></i>复制邀请码
                    </button>
                  </div>
                )}

                {/* 等待连接（guest） */}
                {p2pStatus === "waiting" && p2pSide === "guest" && (
                  <div className="n4-pane-center">
                    <div className="n4-p2p-spin"><i className="fa fa-spinner fa-spin"></i></div>
                    <div className="n4-p2p-center-title">正在连接…</div>
                    <div className="n4-p2p-center-sub">{p2pStatusText}</div>
                  </div>
                )}

                {/* 已连接（host）：本机文件选择面板 */}
                {p2pStatus === "connected" && p2pSide === "host" && (
                  <div>
                    <input ref={p2pFileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { addLocalFiles(e.target.files); e.target.value = ""; }} />
                    <input ref={p2pFolderInputRef} type="file" {...({ webkitdirectory: "" } as any)} style={{ display: "none" }} onChange={(e) => { addLocalFiles(e.target.files); e.target.value = ""; }} />
                    <div className="n4-pane-connected">
                      <i className="fa fa-check-circle"></i>已连接 · 选择本机文件
                      <button className="n4-mini-btn" style={{ marginLeft: "auto" }} disabled={localFiles.length === 0} onClick={() => setLocalFiles([])}>
                        <i className="fa fa-eraser"></i>清空
                      </button>
                    </div>
                    <div className="n4-send-btns">
                      <button className="n4-chip-btn" onClick={() => p2pFileInputRef.current?.click()}>
                        <i className="fa fa-file"></i>选择文件
                      </button>
                      <button className="n4-chip-btn" onClick={() => p2pFolderInputRef.current?.click()}>
                        <i className="fa fa-folder"></i>选择文件夹
                      </button>
                    </div>
                    {localFiles.length > 0 ? (
                      <div className="n4-send-list">
                        {localFiles.map((f, i) => (
                          <div key={i} className="n4-send-row">
                            <i className="fa fa-file-o"></i>
                            <span className="n4-send-name" title={(f as any).webkitRelativePath || f.name}>{(f as any).webkitRelativePath || f.name}</span>
                            <span className="n4-send-size">{formatSize(f.size)}</span>
                            <button className="n4-iconbtn" onClick={() => removeLocalFile(i)} title="移除">
                              <i className="fa fa-times"></i>
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="n4-send-empty">尚未选择文件，点击上方按钮从本机添加</div>
                    )}
                    <div className="n4-pane-sendfoot">
                      <span className="n4-send-count">
                        已选 <b>{localFiles.length}</b> 个 · 共 <b>{formatSize(localFiles.reduce((sum, f) => sum + f.size, 0))}</b>
                      </span>
                      <button className="n4-btn-red" onClick={sendFilesToPeer} disabled={localFiles.length === 0 || p2pSending}>
                        {p2pSending ? <i className="fa fa-spinner fa-spin"></i> : <i className="fa fa-upload"></i>}
                        {p2pSending ? "发送中…" : `发送 ${localFiles.length} 个文件`}
                      </button>
                    </div>
                  </div>
                )}

                {/* 已连接（guest）：等待接收 */}
                {p2pStatus === "connected" && p2pSide === "guest" && transferProgress.length === 0 && (
                  <div className="n4-pane-center">
                    <div className="n4-p2p-ok">
                      <i className="fa fa-check-circle"></i>
                    </div>
                    <div className="n4-p2p-center-title">已连接，等待对方发送文件…</div>
                    <div className="n4-p2p-center-sub">{p2pStatusText}</div>
                  </div>
                )}

                {/* 本机侧进度 */}
                {transferProgress.length > 0 && (
                  <div>
                    <div className="n4-progress-head">
                      <span>
                        <i className={`fa ${p2pAllDone ? "fa-check-circle" : "fa-exchange"}`}></i>
                        {p2pAllDone ? "全部完成" : "传输进度"}
                        {!p2pAllDone && p2pSpeed > 0 && <span className="n4-progress-speed">· {formatSpeed(p2pSpeed)}</span>}
                      </span>
                      {p2pAllDone && <span className="n4-progress-count">{transferProgress.length} 个文件</span>}
                    </div>
                    {transferProgress.map((p) => (
                      <div key={p.index} className="n4-progress-item">
                        <div className="n4-progress-row">
                          <span className="n4-progress-name" title={p.name}>{p.name}</span>
                          <span className="n4-progress-stat">
                            {p.done ? (
                              <span className="done"><i className="fa fa-check"></i>{formatSize(p.total)} · 完成</span>
                            ) : (
                              <>
                                <span>{`${formatSize(p.sent)} / ${formatSize(p.total)}`}</span>
                                {p.speed > 0 && <span className="spd">· {formatSpeed(p.speed)}</span>}
                              </>
                            )}
                          </span>
                        </div>
                        <div className="n4-bar">
                          <div className={p.done ? "done" : ""} style={{ width: p.total > 0 ? `${Math.min(100, (p.sent / p.total) * 100)}%` : "0%" }}></div>
                        </div>
                      </div>
                    ))}
                    {p2pAllDone && p2pSide === "guest" && (
                      <div className="n4-pane-dl">
                        <span className="n4-progress-note"><i className="fa fa-download"></i>所有文件已接收，可保存到本地</span>
                        <button className="n4-btn-red" onClick={downloadReceivedFiles}>
                          <i className="fa fa-download"></i>下载全部文件
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* 完成（host 侧 / 无进度条时） */}
                {p2pStatus === "done" && (
                  <div className="n4-done" style={{ marginTop: transferProgress.length > 0 ? 14 : 0 }}>
                    <div className="n4-done-left">
                      <i className="fa fa-check-circle"></i>
                      <div>
                        <div className="n4-done-title">传输完成</div>
                        <div className="n4-done-sub">{p2pSide === "host" ? "所有文件已成功发送" : "所有文件已接收"}</div>
                      </div>
                    </div>
                    <button className="n4-mini-btn" onClick={resetP2P}>
                      <i className="fa fa-refresh"></i>重新开始
                    </button>
                  </div>
                )}
              </div>

              {/* ── 中节点 ── */}
              <div className="n4-mid">
                <div className="n4-node"><i className="fa fa-exchange"></i></div>
                <div className="n4-flow">
                  WebRTC 直连<br />
                  <b className={p2pStatus === "connected" || p2pStatus === "transferring" || p2pStatus === "done" ? "ok" : ""}>
                    {p2pStatus === "idle" ? "未连接"
                      : p2pStatus === "waiting" ? "等待连接"
                      : p2pStatus === "done" ? "已完成"
                      : p2pStatus === "transferring" ? "传输中"
                      : "已连接"}
                  </b>
                  {p2pStatus === "transferring" && p2pSpeed > 0 && <><br />{formatSpeed(p2pSpeed)}</>}
                </div>
              </div>

              {/* ── 右栏：对方 ── */}
              <div className="n4-pane">
                <div className="n4-pane-head">
                  <span className="n4-pane-title">对方 · {p2pSide === "host" ? "接收方" : "发送方"}</span>
                  {p2pStatus === "idle" && <span className="n4-pane-tag">未加入</span>}
                  {p2pStatus === "waiting" && <span className="n4-pane-tag blue">等待中</span>}
                  {(p2pStatus === "connected" || p2pStatus === "transferring") && <span className="n4-pane-tag green">{p2pStatus === "transferring" ? (p2pSide === "host" ? "接收中" : "发送中") : "已连接"}</span>}
                  {p2pStatus === "done" && <span className="n4-pane-tag green">已完成</span>}
                </div>

                {p2pStatus === "idle" && (
                  <div className="n4-peer-steps">
                    {p2pSide === "host" ? (
                      <>
                        <div className="n4-peer-step"><span className="n">1</span>你在左侧生成邀请码</div>
                        <div className="n4-peer-step"><span className="n">2</span>对方打开本页面、切换到 P2P传输</div>
                        <div className="n4-peer-step"><span className="n">3</span>对方选「我是接收方」并输入邀请码</div>
                        <div className="n4-peer-step"><span className="n">4</span>连接建立后，文件点对点直传到对方</div>
                      </>
                    ) : (
                      <>
                        <div className="n4-peer-step"><span className="n">1</span>对方在他的页面生成邀请码</div>
                        <div className="n4-peer-step"><span className="n">2</span>你在左侧输入这 6 位邀请码</div>
                        <div className="n4-peer-step"><span className="n">3</span>连接建立后，对方选择文件发送</div>
                        <div className="n4-peer-step"><span className="n">4</span>文件直达你这边，可按目录保存到本地</div>
                      </>
                    )}
                  </div>
                )}

                {p2pStatus === "waiting" && (
                  <div className="n4-pane-center">
                    <div className="n4-p2p-spin"><i className="fa fa-clock-o"></i></div>
                    <div className="n4-p2p-center-title">{p2pSide === "host" ? "等待对方输入邀请码…" : "正在与对方建立连接…"}</div>
                    <div className="n4-p2p-center-sub">{p2pStatusText}</div>
                  </div>
                )}

                {p2pStatus === "connected" && transferProgress.length === 0 && (
                  <div className="n4-pane-center">
                    <div className="n4-p2p-ok"><i className="fa fa-check-circle"></i></div>
                    <div className="n4-p2p-center-title">{p2pSide === "host" ? "对方已连接" : "已与对方连接"}</div>
                    <div className="n4-p2p-center-sub">{p2pSide === "host" ? "在左侧选择文件即可发送给对方" : "等待对方选择文件发送"}</div>
                  </div>
                )}

                {transferProgress.length > 0 && (
                  <div>
                    <div className="n4-progress-head">
                      <span>
                        <i className={`fa ${p2pAllDone ? "fa-check-circle" : "fa-exchange"}`}></i>
                        {p2pSide === "host" ? "对方接收进度" : "对方发送进度"}
                      </span>
                      {p2pAllDone && <span className="n4-progress-count">{transferProgress.length} 个文件</span>}
                    </div>
                    {transferProgress.map((p) => (
                      <div key={p.index} className="n4-progress-item">
                        <div className="n4-progress-row">
                          <span className="n4-progress-name" title={p.name}>{p.name}</span>
                          <span className="n4-progress-stat">
                            {p.done ? <span className="done"><i className="fa fa-check"></i>完成</span> : <span>{p.total > 0 ? `${Math.min(100, Math.round((p.sent / p.total) * 100))}%` : "…"}</span>}
                          </span>
                        </div>
                        <div className="n4-bar">
                          <div className={p.done ? "done" : ""} style={{ width: p.total > 0 ? `${Math.min(100, (p.sent / p.total) * 100)}%` : "0%" }}></div>
                        </div>
                      </div>
                    ))}
                    <p className="n4-pane-hint" style={{ marginTop: 12 }}>
                      {p2pSide === "guest"
                        ? "文件直接写入你这边的浏览器暂存区，全部接收后可在左侧一键按目录保存到本地。"
                        : "进度与对方接收端实时同步，全部完成即表示对方已完整收到。"}
                    </p>
                  </div>
                )}

                {p2pStatus === "done" && transferProgress.length === 0 && (
                  <div className="n4-pane-center">
                    <div className="n4-p2p-ok"><i className="fa fa-check-circle"></i></div>
                    <div className="n4-p2p-center-title">对方已{p2pSide === "host" ? "完整接收" : "完成发送"}</div>
                    <div className="n4-p2p-center-sub">本次直传结束</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}

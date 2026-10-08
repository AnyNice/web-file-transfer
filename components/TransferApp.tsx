"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { P2PConnection, FileMeta, TransferProgress } from "@/lib/webrtc";

type FileEntry = {
  name: string;
  type: "file" | "folder";
  path: string;
  size: number;
  modified: string;
};

type P2PSide = "host" | "guest";
type P2PStatus = "idle" | "creating" | "waiting" | "connected" | "transferring" | "done";
type UploadStatus = "idle" | "uploading" | "success" | "error";
type ServerStatus = "online" | "offline" | "checking";

export default function TransferApp() {
  // View toggle: false = upload/download merged view, true = P2P view
  const [showP2P, setShowP2P] = useState(false);

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

  // Server status state
  const [serverStatus, setServerStatus] = useState<ServerStatus>("checking");
  const serverCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Downloading file state
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const downloadStartRef = useRef<number>(0);
  const downloadLoadedRef = useRef<number>(0);
  const downloadXhrRef = useRef<XMLHttpRequest | null>(null);

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
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };

  // ── Server health check ──────────────────────────────────
  const checkServerHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/files");
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

  // ── Fetch files ──────────────────────────────────────────
  const fetchFiles = async () => {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      setFiles(data.files || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchFiles();
    return () => {
      p2pRef.current?.close();
      if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
      if (downloadXhrRef.current) {
        downloadXhrRef.current.abort();
      }
    };
  }, []);

  // ── Upload ──────────────────────────────────────────────
  const handleSelectFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const newFiles: { file: File; name: string; size: number }[] = [];
    for (let i = 0; i < fileList.length; i++) {
      newFiles.push({ file: fileList[i], name: fileList[i].name, size: fileList[i].size });
    }

    setPendingUploadQueue(prev => [...prev, ...newFiles]);
    setUploadStatus("idle");
    setUploadProgress(0);
    setUploadSpeed(0);
    e.target.value = "";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    const newFiles: { file: File; name: string; size: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) {
        if (entry.isFile) {
          (entry as FileSystemFileEntry).file(file => {
            newFiles.push({ file, name: file.name, size: file.size });
          });
        } else if (entry.isDirectory) {
          const readDir = (dirEntry: FileSystemDirectoryEntry, path: string) => {
            const reader = dirEntry.createReader();
            reader.readEntries(async (entries: FileSystemEntry[]) => {
              for (const entry of entries) {
                if (entry.isFile) {
                  (entry as FileSystemFileEntry).file(file => {
                    newFiles.push({ file, name: path + file.name, size: file.size });
                  });
                } else if (entry.isDirectory) {
                  readDir(entry as FileSystemDirectoryEntry, path + entry.name + "/");
                }
              }
              if (newFiles.length > 0) {
                setPendingUploadQueue(prev => [...prev, ...newFiles]);
                setUploadStatus("idle");
                setUploadProgress(0);
                setUploadSpeed(0);
              }
            });
          };
          readDir(entry as FileSystemDirectoryEntry, "");
        }
      }
    }

    const transferFiles = e.dataTransfer.files;
    for (let i = 0; i < transferFiles.length; i++) {
      newFiles.push({ file: transferFiles[i], name: transferFiles[i].name, size: transferFiles[i].size });
    }

    if (newFiles.length > 0) {
      setPendingUploadQueue(prev => [...prev, ...newFiles]);
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
      formData.append("file", item.file, item.name);

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
      });
      conn.setOnAllDone(() => { setP2pAllDone(true); p2pStatusRef.current = "done"; setP2pStatus("done"); });

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
      });
      conn.setOnFileList((list) => {
        setPeerName(list.length > 0 ? `${list.length} 个文件` : "");
      });
      conn.setOnAllDone(() => {
          const failed: number[] = [];
          for (const prog of transferProgressRef.current) {
            if (prog.done && conn.getReceivedBlob(prog.index) === null) failed.push(prog.index);
            else if (prog.done) {
              const blob = conn.getReceivedBlob(prog.index);
              if (blob && prog.total > 0 && blob.size !== prog.total) failed.push(prog.index);
            }
          }
          if (failed.length > 0) {
            p2pErrorRef.current = failed.length + " 个文件数据不完整，请重新连接";
            setP2pError(p2pErrorRef.current);
            setP2pAllDone(false);
          } else {
            p2pErrorRef.current = "";
            setP2pError("");
                        setP2pAllDone(true);
            p2pStatusRef.current = "done"; setP2pStatus("done");
            setP2pStatusText("全部文件已接收");
          }
        });

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
      name: f.name,
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
  const downloadReceivedFiles = () => {
    const conn = p2pRef.current;
    if (!conn) return;
    for (const prog of transferProgress) {
      if (!prog.done) continue;
      const blob = conn.getReceivedBlob(prog.index);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = prog.name || `file_${prog.index}`;
      a.click();
      // 延迟释放 URL 并清空接收端内存缓存，避免大文件占用内存
      setTimeout(() => {
        URL.revokeObjectURL(url);
        conn.releaseReceived(prog.index);
      }, 10000);
    }
  };

  // ── Download ────────────────────────────────────────────
  const handleDownload = async (file: FileEntry) => {
    setDownloadingPath(file.path);
    setDownloadProgress(0);
    setDownloadSpeed(0);
    downloadStartRef.current = Date.now();
    downloadLoadedRef.current = 0;

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      downloadXhrRef.current = xhr;
      xhr.open("GET", `/api/files/${encodeURIComponent(file.path)}`);
      xhr.responseType = "blob";

      xhr.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const elapsed = (Date.now() - downloadStartRef.current) / 1000;
          if (elapsed > 0) setDownloadSpeed(e.loaded / elapsed);
          setDownloadProgress(Math.round((e.loaded / file.size) * 100));
        }
      });

      xhr.addEventListener("load", async () => {
        downloadXhrRef.current = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          const blob = xhr.response;
          const win = window as any;
          if (win.showSaveFilePicker) {
            try {
              const handle = await win.showSaveFilePicker({
                suggestedName: file.name,
                types: [{ description: "File", accept: { "application/octet-stream": [`.${file.name.split(".").pop()}`] } }],
              });
              const writable = await handle.createWritable();
              await writable.write(blob);
              await writable.close();
              setDownloadProgress(100);
              setDownloadSpeed(0);
              setTimeout(() => { setDownloadingPath(null); setDownloadProgress(0); }, 800);
              resolve();
              return;
            } catch (err: any) {
              if (err.name === "AbortError") {
                setDownloadingPath(null);
                setDownloadProgress(0);
                resolve();
                return;
              }
            }
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = file.name;
          a.click();
          URL.revokeObjectURL(url);
          setDownloadProgress(100);
          setDownloadSpeed(0);
          setTimeout(() => { setDownloadingPath(null); setDownloadProgress(0); }, 800);
          resolve();
        } else {
          setDownloadingPath(null);
          setDownloadProgress(0);
          reject(new Error(`Download failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => {
        downloadXhrRef.current = null;
        setDownloadingPath(null);
        setDownloadProgress(0);
        reject(new Error("Network error"));
      });

      xhr.addEventListener("abort", () => {
        downloadXhrRef.current = null;
        setDownloadingPath(null);
        setDownloadProgress(0);
        reject(new Error("Download aborted"));
      });

      xhr.send();
    });
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
      modeLabel = `下载中 ${downloadProgress.toFixed(0)}%`;
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

  return (
    <div className="browser-shell">
      {/* 浏览器顶部标签栏区域 */}
      <div className="relative h-14 px-4 pt-3 flex items-center">
        <div className="flex items-center gap-1.5">
          <button className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
            <i className="fa fa-chevron-left text-xs"></i>
          </button>
          <span className="text-sm text-gray-500">1/1</span>
          <button className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-gray-400">
            <i className="fa fa-chevron-right text-xs"></i>
          </button>
        </div>
        <div className="absolute left-[120px] top-0 w-52 h-[34px] bg-white tab-shape border border-gray-100 flex items-center px-3 text-xs text-gray-600">
          <span>局域网快传 · 文件传输</span>
          <span className="ml-auto text-gray-400 cursor-pointer hover:text-gray-600">×</span>
        </div>
        <div className="ml-auto flex items-center gap-2 bg-gray-50 px-3 py-1 rounded-full border border-gray-100">
          <span className={`w-2 h-2 rounded-full ${serverDot}`}></span>
          <span className="text-xs text-gray-600">{serverLabel}</span>
        </div>
      </div>

      {/* 主体容器 */}
      <div className="px-8 pb-8">
        {/* 操作区 Tab */}
        <div className="flex gap-2 mb-6">
          <button
            className={`px-4 py-2 rounded-md border text-sm transition-all ${
              !showP2P
                ? "text-errorRed font-medium border-errorRed/30 bg-errorRedLight/40"
                : "text-gray-500 bg-gray-50 hover:bg-gray-100 border-gray-200"
            } ${!canSwitchTab ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            onClick={() => canSwitchTab && setShowP2P(false)}
          >
            <i className="fa fa-upload mr-1"></i>上传 / 下载
          </button>
          <button
            className={`px-4 py-2 rounded-md border text-sm transition-all ${
              showP2P
                ? "text-errorRed font-medium border-errorRed/30 bg-errorRedLight/40"
                : "text-gray-500 bg-gray-50 hover:bg-gray-100 border-gray-200"
            } ${!canSwitchTab ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            onClick={() => canSwitchTab && setShowP2P(true)}
          >
            <i className="fa fa-exchange mr-1"></i>P2P传输
          </button>
        </div>

        {/* ── 上传 + 下载面板（上下分块） ── */}
        {!showP2P && (
          <div className="space-y-6">
            {/* ── 上传区块 ── */}
            <section>
              <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                <i className="fa fa-upload text-errorRed"></i>上传文件
              </h2>
              <div
                className={`border-2 border-dashed rounded-codeCard py-10 px-4 text-center mb-4 transition-all ${
                  canSwitchTab
                    ? "border-gray-300 cursor-pointer"
                    : "border-gray-200 bg-gray-50 cursor-not-allowed opacity-60"
                } ${dragOver ? "border-errorRed bg-errorRedLight/40" : ""}`}
                onDragOver={(e) => { if (!canSwitchTab) return; e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { if (!canSwitchTab) return; handleDrop(e); }}
                onClick={() => { if (!canSwitchTab) return; fileInputRef.current?.click(); }}
              >
                <div className={`text-3xl mb-2 ${dragOver ? "text-errorRed" : "text-gray-400"}`}>
                  <i className="fa fa-upload"></i>
                </div>
                <p className="text-gray-700">{canSwitchTab ? "拖拽文件到此处，或点击批量选择" : "传输进行中，请稍候..."}</p>
                <p className="text-gray-400 text-sm mt-1">支持所有文件类型，无大小限制</p>
              </div>

              <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleSelectFiles} />
              <input ref={folderInputRef} type="file" {...({ webkitdirectory: "", directory: "" } as any)} style={{ display: "none" }} onChange={handleSelectFiles} />

              <div className="flex gap-2 mb-4">
                <button
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!canSwitchTab}
                >
                  <i className="fa fa-files-o mr-1"></i>批量选择文件
                </button>
                <button
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  onClick={() => folderInputRef.current?.click()}
                  disabled={!canSwitchTab}
                >
                  <i className="fa fa-folder-open mr-1"></i>选择文件夹
                </button>
              </div>

              {/* 待上传队列 */}
              {pendingUploadQueue.length > 0 && uploadStatus === "idle" && (
                <div className="bg-gray-50 rounded-codeCard border border-gray-200 overflow-hidden mb-4">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-gray-200">
                    <div className="flex items-center gap-2 text-sm text-gray-700">
                      <i className="fa fa-list text-gray-500"></i>
                      <span>待上传队列 ({pendingUploadQueue.length}个文件)</span>
                      <span className="text-xs text-gray-400 font-mono">
                        总计: {formatSize(pendingUploadQueue.reduce((sum, f) => sum + f.size, 0))}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-md transition-colors" onClick={clearQueue}>
                        <i className="fa fa-times mr-1"></i>清空队列
                      </button>
                      <button className="px-3 py-1.5 text-xs bg-errorRed text-white rounded-md hover:bg-red-700 transition-colors" onClick={startUpload}>
                        <i className="fa fa-upload mr-1"></i>开始上传
                      </button>
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {pendingUploadQueue.map((item, idx) => (
                      <div key={idx} className="px-4 py-2 flex items-center justify-between border-b border-gray-100 last:border-b-0 hover:bg-gray-100">
                        <div className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
                          <i className="fa fa-file-o text-gray-400 flex-shrink-0"></i>
                          <span className="truncate" title={item.name}>{item.name}</span>
                          <span className="text-xs text-gray-400 font-mono flex-shrink-0">{formatSize(item.size)}</span>
                        </div>
                        <button className="w-7 h-7 rounded hover:bg-gray-200 text-gray-400 hover:text-errorRed flex items-center justify-center flex-shrink-0" onClick={() => removeFromQueue(idx)}>
                          <i className="fa fa-times text-xs"></i>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 上传进度 */}
              {uploadStatus === "uploading" && uploadFileMeta && (
                <div className="mb-4">
                  <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                    <span className="truncate max-w-[200px]" title={uploadFileMeta.name}>
                      <i className="fa fa-file-o mr-1"></i>{uploadFileMeta.name}
                      {pendingUploadQueue.length > 0 && (
                        <span className="text-gray-400 ml-1">
                          ({currentUploadIndex + 1}/{pendingUploadQueue.length + currentUploadIndex + 1})
                        </span>
                      )}
                    </span>
                    <span className="font-mono">{uploadProgress.toFixed(0)}% · {formatSize(uploadFileMeta.size)} · {formatSpeed(uploadSpeed)}/s</span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-2">
                    <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-200" style={{ width: `${Math.min(uploadProgress, 100)}%` }} />
                  </div>
                  <button className="text-xs text-gray-500 hover:text-errorRed transition-colors" onClick={cancelUpload}>
                    <i className="fa fa-times-circle mr-1"></i>取消上传
                  </button>
                </div>
              )}

              {uploadStatus === "success" && (
                <div className="bg-brandGreenLight rounded-codeCard p-3 text-sm text-brandGreen flex items-center gap-2">
                  <i className="fa fa-check-circle"></i>
                  <div><div className="font-medium">上传成功</div><div className="text-xs mt-0.5">文件已保存到服务器</div></div>
                </div>
              )}

              {uploadStatus === "error" && (
                <div className="bg-errorRedLight rounded-codeCard p-3 text-sm text-errorRed flex items-center gap-2">
                  <i className="fa fa-times-circle"></i>
                  <div><div className="font-medium">上传失败</div><div className="text-xs mt-0.5">请重试或检查网络连接</div></div>
                </div>
              )}
            </section>

            {/* ── 下载区块 ── */}
            <section>
              <h2 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                <i className="fa fa-download text-blue-500"></i>下载文件
              </h2>
              {files.length === 0 ? (
                <div className="bg-gray-50 rounded-codeCard border border-gray-100 overflow-hidden p-8 text-center">
                  <p className="text-sm text-gray-400">暂无文件</p>
                  <p className="text-xs text-gray-400 mt-1">上传文件后将在此显示</p>
                </div>
              ) : (
                <div className="bg-gray-50 rounded-codeCard border border-gray-100 overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-gray-200">
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <i className="fa fa-folder-open-o"></i>
                      <span>./uploads/</span>
                    </div>
                    <button className="w-7 h-7 rounded hover:bg-gray-200 text-gray-500 flex items-center justify-center" onClick={fetchFiles} title="刷新">
                      <i className="fa fa-refresh text-xs"></i>
                    </button>
                  </div>
                  <div>
                    {files.map((f, idx) => {
                      const isDownloading = downloadingPath === f.path;
                      return (
                        <div key={f.path} className={`px-4 py-2.5 flex items-center justify-between ${idx % 2 === 0 ? "bg-white" : "bg-gray-100/50"}`}>
                          <div className="flex items-center gap-2 text-sm flex-1 min-w-0">
                            <i className={`fa fa-file-text-o ${isDownloading ? "text-blue-500" : "text-gray-500"}`}></i>
                            <span className={isDownloading ? "text-blue-600 font-medium" : "text-gray-700"}>{f.name}</span>
                            {isDownloading && (
                              <span className="text-xs text-blue-500 font-mono ml-1">{downloadProgress.toFixed(0)}% · {formatSpeed(downloadSpeed)}/s</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-gray-500 flex-shrink-0 ml-2">
                            <span>{formatSize(f.size)}</span>
                            <span>{formatTime(f.modified)}</span>
                            <button className="w-7 h-7 rounded hover:bg-gray-200 flex items-center justify-center" onClick={() => !isDownloading && handleDownload(f)} title="下载">
                              <i className={`fa fa-download text-xs ${isDownloading ? "animate-pulse" : ""}`}></i>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
{/* ── P2P面板 ── */}
        {showP2P && (
          <div>
            {/* 状态胶囊 + 断开 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
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
              <button
                className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-all ${
                  p2pSide === "host" ? "bg-errorRedLight text-errorRed" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                } ${p2pStatus === "idle" ? "cursor-pointer" : "cursor-default"}`}
                onClick={() => { if (p2pStatus === "idle") setP2pSide(p2pSide === "host" ? "guest" : "host"); }}
              >
                {p2pSide === "host" ? <><i className="fa fa-circle-o"></i>发送方</> : <><i className="fa fa-user"></i>接收方</>}
                {p2pStatus === "idle" && <i className="fa fa-angle-down text-[10px]"></i>}
              </button>
            </div>

            {/* 错误提示 */}
            {p2pError && (
              <div className="bg-errorRedLight rounded-codeCard p-3 text-sm text-errorRed flex items-center gap-3 mb-4">
                <i className="fa fa-exclamation-circle flex-shrink-0"></i>
                <div className="flex-1 text-xs">{p2pError}</div>
                <button className="text-xs hover:underline flex-shrink-0" onClick={() => { p2pErrorRef.current = ""; setP2pError(""); }}><i className="fa fa-times"></i></button>
              </div>
            )}

            {/* 空闲：角色卡片 + 入口操作 */}
            {p2pStatus === "idle" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <button className={`flex flex-col items-center gap-2 p-5 rounded-codeCard border-2 transition-all ${
                    p2pSide === "host" ? "border-errorRed bg-errorRedLight/40 text-errorRed" : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300"
                  }`} onClick={() => setP2pSide("host")}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${p2pSide === "host" ? "bg-errorRed/15" : "bg-gray-200"}`}>
                      <i className="fa fa-circle-o text-lg"></i>
                    </div>
                    <div className="text-sm font-medium">我是发送方</div>
                    <div className="text-xs text-gray-400 text-center leading-relaxed">生成邀请码，从本机选择文件发给对方</div>
                  </button>
                  <button className={`flex flex-col items-center gap-2 p-5 rounded-codeCard border-2 transition-all ${
                    p2pSide === "guest" ? "border-errorRed bg-errorRedLight/40 text-errorRed" : "border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300"
                  }`} onClick={() => setP2pSide("guest")}>
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${p2pSide === "guest" ? "bg-errorRed/15" : "bg-gray-200"}`}>
                      <i className="fa fa-user text-lg"></i>
                    </div>
                    <div className="text-sm font-medium">我是接收方</div>
                    <div className="text-xs text-gray-400 text-center leading-relaxed">输入邀请码，接收对方发来的文件</div>
                  </button>
                </div>

                {p2pSide === "host" ? (
                  <div className="border border-gray-200 rounded-codeCard p-5">
                    <p className="text-xs text-gray-500 mb-4 flex items-center gap-1.5">
                      <i className="fa fa-laptop text-gray-400"></i>
                      连接后可从你本机选择文件（支持多文件 / 文件夹），直接 P2P 发送给对方，无需经过服务器
                    </p>
                    <button className="bg-errorRed text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" onClick={handleP2PHost} disabled={!canSwitchTab}>
                      <i className="fa fa-magic"></i>生成邀请码
                    </button>
                  </div>
                ) : (
                  <div className="border border-gray-200 rounded-codeCard p-5">
                    <p className="text-xs text-gray-500 mb-3">输入对方生成的 6 位邀请码</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <input
                        type="text" maxLength={6} inputMode="numeric"
                        className="w-52 border border-gray-200 rounded-md p-3 font-mono bg-gray-50 outline-none transition-all text-center text-2xl tracking-[0.3em] text-gray-700 focus:border-errorRed focus:ring-1 focus:ring-errorRed/20"
                        placeholder="000000" value={pasteOffer}
                        onChange={(e) => setPasteOffer(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      />
                      <button className="bg-errorRed text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" onClick={handleP2PGuest} disabled={pasteOffer.length !== 6 || !canSwitchTab}>
                        <i className="fa fa-paper-plane"></i>连接
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 建立中 */}
            {p2pStatus === "creating" && (
              <div className="border border-gray-200 rounded-codeCard p-8 text-center">
                <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto mb-3">
                  <i className="fa fa-spinner fa-spin text-amber-500 text-xl"></i>
                </div>
                <div className="text-sm font-medium text-gray-700">{p2pSide === "host" ? "正在创建房间…" : "正在连接…"}</div>
                <div className="text-xs text-gray-400 mt-1">{p2pStatusText}</div>
              </div>
            )}

            {/* 等待连接（host）：邀请码卡片 */}
            {p2pStatus === "waiting" && p2pSide === "host" && p2pCode && (
              <div className="border-2 border-errorRed/20 rounded-codeCard overflow-hidden">
                <div className="px-4 py-3 bg-errorRedLight/50 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-gray-700">
                    <i className="fa fa-key text-errorRed"></i>
                    <span className="font-medium">邀请码已生成</span>
                    <span className="flex items-center gap-1.5 text-xs text-brandGreen"><span className="w-2 h-2 rounded-full bg-brandGreen animate-pulse"></span>{p2pStatusText}</span>
                  </div>
                  <button className="text-xs text-gray-500 hover:text-errorRed transition-colors px-2 py-1 rounded hover:bg-gray-200/50" onClick={() => copyToClipboard(p2pCode)}>
                    <i className="fa fa-copy mr-1"></i>复制
                  </button>
                </div>
                <div className="p-8 text-center bg-white">
                  <div className="text-5xl font-mono font-bold text-errorRed tracking-[0.4em] mb-3 select-all">{p2pCode}</div>
                  <p className="text-xs text-gray-400">把邀请码告诉对方，输入后即可建立连接（5 分钟内有效）</p>
                </div>
              </div>
            )}

            {/* 已连接（guest）：等待接收 */}
            {p2pStatus === "connected" && p2pSide === "guest" && transferProgress.length === 0 && (
              <div className="border border-gray-200 rounded-codeCard p-6 text-center">
                <div className="w-12 h-12 rounded-full bg-brandGreenLight flex items-center justify-center mx-auto mb-3">
                  <i className="fa fa-check-circle text-brandGreen text-xl"></i>
                </div>
                <div className="text-sm font-medium text-gray-700 mb-1">已连接，等待对方发送文件…</div>
                <div className="text-xs text-gray-400">{p2pStatusText}</div>
              </div>
            )}

            {/* 已连接（host）：本机文件选择面板 */}
{p2pStatus === "connected" && p2pSide === "host" && (
  <div className="border border-gray-200 rounded-codeCard overflow-hidden">
    <input ref={p2pFileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { addLocalFiles(e.target.files); e.target.value = ""; }} />
    <input ref={p2pFolderInputRef} type="file" {...({ webkitdirectory: "" } as any)} style={{ display: "none" }} onChange={(e) => { addLocalFiles(e.target.files); e.target.value = ""; }} />
    <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-gray-700">
        <i className="fa fa-check-circle text-brandGreen"></i>
        <span className="font-medium">已连接 · 选择本机文件</span>
      </div>
      <div className="flex items-center gap-2">
        <button className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40" disabled={localFiles.length === 0} onClick={() => setLocalFiles([])}>
          <i className="fa fa-eraser mr-1"></i>清空
        </button>
      </div>
    </div>
    <div className="p-4 space-y-3">
      {/* 选择按钮 */}
      <div className="flex items-center gap-2">
        <button className="border border-gray-200 rounded-md px-3 py-1.5 text-xs text-gray-600 hover:border-errorRed hover:text-errorRed transition-colors flex items-center gap-1.5" onClick={() => p2pFileInputRef.current?.click()}>
          <i className="fa fa-file"></i>选择文件
        </button>
        <button className="border border-gray-200 rounded-md px-3 py-1.5 text-xs text-gray-600 hover:border-errorRed hover:text-errorRed transition-colors flex items-center gap-1.5" onClick={() => p2pFolderInputRef.current?.click()}>
          <i className="fa fa-folder"></i>选择文件夹
        </button>
      </div>
      {/* 文件列表 */}
      {localFiles.length > 0 ? (
        <div className="max-h-56 overflow-y-auto border border-gray-100 rounded-md">
          {localFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 last:border-b-0">
              <i className="fa fa-file-o text-gray-400 text-xs flex-shrink-0"></i>
              <span className="text-sm text-gray-700 truncate flex-1" title={f.name}>{f.name}</span>
              <span className="text-xs text-gray-400 font-mono flex-shrink-0">{formatSize(f.size)}</span>
              <button className="text-xs text-gray-300 hover:text-errorRed transition-colors" onClick={() => removeLocalFile(i)} title="移除">
                <i className="fa fa-times"></i>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-gray-400 py-3 text-center border border-dashed border-gray-200 rounded-md">
          尚未选择文件，点击上方按钮从本机添加
        </div>
      )}
    </div>
    <div className="p-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
      <div className="text-xs text-gray-500">
        已选 <span className="font-mono text-errorRed font-medium">{localFiles.length}</span> 个 ·
        共 <span className="font-mono">{formatSize(localFiles.reduce((sum, f) => sum + f.size, 0))}</span>
      </div>
      <button className="bg-errorRed text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" onClick={sendFilesToPeer} disabled={localFiles.length === 0 || p2pSending}>
        {p2pSending ? <i className="fa fa-spinner fa-spin"></i> : <i className="fa fa-upload"></i>}
        {p2pSending ? "发送中…" : `发送 ${localFiles.length} 个文件`}
      </button>
    </div>
  </div>
            )}

            {/* 传输进度 */}
            {transferProgress.length > 0 && (
              <div className="border border-gray-200 rounded-codeCard overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-gray-700">
                    <i className={`fa ${p2pAllDone ? "fa-check-circle text-brandGreen" : "fa-exchange text-blue-500"}`}></i>
                    <span className="font-medium">{p2pAllDone ? "全部完成" : "传输进度"}</span>
                    {!p2pAllDone && p2pSpeed > 0 && (
                      <span className="text-xs text-gray-400 font-mono">· {formatSpeed(p2pSpeed)}</span>
                    )}
                  </div>
                  {p2pAllDone && (
                    <span className="text-xs text-brandGreen flex items-center gap-1"><i className="fa fa-check-circle"></i>{transferProgress.length} 个文件</span>
                  )}
                </div>
                <div className="p-4">
                  {transferProgress.map((p) => (
                    <div key={p.index} className="mb-3 last:mb-0">
                      <div className="flex justify-between items-center mb-1.5 text-xs">
                        <span className="font-mono text-gray-700 truncate max-w-[60%]" title={p.name}>{p.name}</span>
                        <span className="text-gray-500 flex-shrink-0 ml-2">
                          {p.done ? (
                            <span className="text-brandGreen"><i className="fa fa-check mr-1"></i>{formatSize(p.total)} · 完成</span>
                          ) : (
                            <>
                              <span>{`${formatSize(p.sent)} / ${formatSize(p.total)}`}</span>
                              {p.speed > 0 && <span className="text-gray-400 font-mono ml-1.5">· {formatSpeed(p.speed)}</span>}
                            </>
                          )}
                        </span>
                      </div>
                      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all duration-300 ${p.done ? "bg-brandGreen" : "bg-gradient-to-r from-blue-500 to-cyan-400"}`} style={{ width: p.total > 0 ? `${Math.min(100, (p.sent / p.total) * 100)}%` : "0%" }} />
                      </div>
                    </div>
                  ))}
                </div>

                {p2pAllDone && p2pSide === "guest" && (
                  <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
                    <span className="text-xs text-gray-500"><i className="fa fa-download mr-1 text-blue-500"></i>所有文件已接收，可保存到本地</span>
                    <button className="bg-blue-500 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-600 transition-colors flex items-center gap-2" onClick={downloadReceivedFiles}>
                      <i className="fa fa-download"></i>下载全部文件
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 完成（host 侧 / 无进度条时） */}
            {p2pStatus === "done" && (
              <div className="flex items-center justify-between bg-brandGreenLight rounded-codeCard p-4">
                <div className="flex items-center gap-3">
                  <i className="fa fa-check-circle text-brandGreen"></i>
                  <div>
                    <div className="text-sm font-medium text-brandGreen">传输完成</div>
                    <div className="text-xs text-gray-500 mt-0.5">{p2pSide === "host" ? "所有文件已成功发送" : "所有文件已接收"}</div>
                  </div>
                </div>
                <button className="text-xs text-gray-500 hover:text-errorRed transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-white/60" onClick={resetP2P}>
                  <i className="fa fa-refresh"></i>重新开始
                </button>
              </div>
            )}
          </div>
        )}

      </div>

      {/* 右下角悬浮徽章 */}
      <div
        className={`fixed bottom-8 right-8 shadow-softFloat px-4 py-2.5 rounded-full flex items-center gap-2 text-sm transition-all duration-300 cursor-pointer hover:scale-105 hover:shadow-lg ${
          isTransferring
            ? "text-white bg-gradient-to-r from-violet-600 via-blue-500 via-cyan-400 to-purple-400 bg-[length:300%_100%] animate-gradient-shift"
            : "bg-errorRed text-white hover:bg-red-700"
        }`}
        title={
          uploadStatus === "uploading"
            ? `上传中 ${uploadProgress.toFixed(0)}% · ${formatSpeed(uploadSpeed)}/s`
            : downloadingPath
            ? `下载中 ${downloadProgress.toFixed(0)}% · ${formatSpeed(downloadSpeed)}/s`
            : p2pStatus === "transferring"
            ? "P2P 文件传输进行中"
            : p2pStatus === "connected"
            ? `P2P 已连接 (${p2pSide === "host" ? "发送方" : "接收方"})`
            : `当前模式: ${!showP2P ? "上传/下载" : "P2P传输"}`
        }
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">{modeLabel}</span>
          {(uploadStatus === "uploading" || downloadingPath) && (
            <span className="font-mono text-xs opacity-80">
              {formatSpeed(uploadStatus === "uploading" ? uploadSpeed : downloadSpeed)}/s
            </span>
          )}
        </span>
      </div>
    </div>
  );
}




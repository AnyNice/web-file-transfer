"use client";
import { useState, useRef, useEffect } from "react";
import { Folder, File as FileIcon, Download, Trash2, Upload, Plus, RefreshCw, LoaderCircle, ExternalLink, BookOpen, Settings } from "lucide-react";
interface FileItem {
  name: string;
  size: number;
  type: "file" | "folder";
  path: string;
  modified: string;
  children?: FileItem[];
}

interface UploadJob {
  name: string;
  size: number;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function ServerPanel() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState<UploadJob | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listFiles(); }, []);

  async function listFiles() {
    setLoading(true);
    try {
      const r = await fetch("/api/files");
      const data = await r.json();
      setFiles(data.files || []);
    } catch { setFiles([]); }
    finally { setLoading(false); }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>, isFolder = false) {
    const fileList = e.target.files;
    if (!fileList?.length) return;
    if (isFolder && (fileList as any).webkitGetAsEntry) {
      const entries = Array.from(fileList).map(f => (f as any).webkitGetAsEntry()).filter(Boolean);
      await uploadEntries(entries);
      return;
    }
    const file = fileList[0];
    await doUpload(file);
  }

  async function uploadEntries(entries: FileSystemEntry[]) {
    const files: File[] = [];
    async function walk(entry: FileSystemEntry) {
      if (entry.isFile) {
        const f = await new Promise<File>((resolve, reject) => ((entry as FileSystemFileEntry).file as any)(resolve, reject as any));
        files.push(f);
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const children = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve));
        for (const child of children) await walk(child);
      }
    }
    for (const entry of entries) await walk(entry);
    if (files.length === 0) return;
    for (const file of files) await doUpload(file);
  }

  async function doUpload(file: File) {
    setUploading({ name: file.name, size: file.size, progress: 0, status: "uploading" });
    const fd = new FormData();
    fd.append("file", file);
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          setUploadProgress(pct);
          setUploading(prev => prev ? { ...prev, progress: pct } : null);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploading(prev => prev ? { ...prev, status: "done" } : null);
          setTimeout(() => setUploading(null), 2000);
          listFiles();
        } else {
          setUploading(prev => prev ? { ...prev, status: "error", error: xhr.statusText } : null);
        }
      };
      xhr.onerror = () => {
        setUploading(prev => prev ? { ...prev, status: "error", error: "上传失败" } : null);
      };
      xhr.send(fd);
    } catch (err) {
      setUploading(prev => prev ? { ...prev, status: "error", error: String(err) } : null);
    }
  }

  async function downloadFile(path: string, name: string) {
    const a = document.createElement("a");
    a.href = `/api/files/${encodeURIComponent(path)}`;
    a.download = name;
    a.click();
  }

  async function openFile(path: string, name: string) {
    const url = `/api/files/${encodeURIComponent(path)}`;
    window.open(url, "_blank");
  }

  async function deleteFile(path: string) {
    if (!window.confirm(`确定删除 ${path}？`)) return;
    await fetch(`/api/files/${encodeURIComponent(path)}`, { method: "DELETE" });
    listFiles();
  }

  return (
    <>
      {/* Upload area - light gray code card style */}
      <div className="code-card">
        <div className="code-card-header">
          <span className="code-card-path">
            <Upload size={13} />
            上传文件
          </span>
          <div className="code-card-actions">
            <button title="设置"><Settings size={12} /></button>
          </div>
        </div>
        <div className="code-card-body">
          <div
            className={`drop-zone ${dragOver ? "dragover" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setDragOver(false);
              const items = e.dataTransfer.items;
              const entries: FileSystemEntry[] = [];
              for (let i = 0; i < items.length; i++) {
                const entry = items[i].webkitGetAsEntry?.();
                if (entry) entries.push(entry);
              }
              if (entries.length > 0) {
                await uploadEntries(entries);
              } else if (e.dataTransfer.files.length > 0) {
                await doUpload(e.dataTransfer.files[0]);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={28} />
            <p>拖拽文件到这里，或点击选择</p>
            <span className="hint">支持单文件和文件夹上传</span>
          </div>
          <input ref={fileInputRef} type="file" multiple hidden onChange={e => handleUpload(e, false)} />
          <input ref={folderInputRef} type="file" multiple hidden onChange={e => handleUpload(e, true)} />

          {uploading && (
            <div style={{ marginTop: 14 }}>
              <div className="progress-text">
                <span style={{ fontFamily: "DM Mono", fontSize: 11 }}>{uploading.name}</span>
                <span style={{ fontFamily: "DM Mono", fontSize: 11 }}>
                  {uploading.status === "done" ? "✓ 完成" : `${uploading.progress}%`}
                </span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${uploading.progress}%` }} />
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn btn-sm" onClick={() => fileInputRef.current?.click()}>
              <Plus size={12} />选择文件
            </button>
            <button className="btn btn-sm" onClick={() => folderInputRef.current?.click()}>
              <Folder size={12} />选择文件夹
            </button>
          </div>
        </div>
      </div>

      {/* File browser - light gray code card style */}
      <div className="code-card">
        <div className="code-card-header">
          <span className="code-card-path">
            <Folder size={13} />
            uploads/
            <span style={{ color: "var(--gray-400)" }}>({files.length})</span>
          </span>
          <div className="code-card-actions">
            <button title="刷新" onClick={listFiles}>
              <RefreshCw size={12} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
            </button>
            <button title="在新窗口打开"><ExternalLink size={12} /></button>
            <button title="查看文档"><BookOpen size={12} /></button>
            <button title="设置"><Settings size={12} /></button>
          </div>
        </div>
        <div className="code-card-body" style={{ padding: 0 }}>
          {loading ? (
            <div style={{ padding: "24px", textAlign: "center", color: "var(--gray-400)", fontSize: 12 }}>
              <LoaderCircle size={14} className="spin" style={{ marginRight: 6, verticalAlign: "middle" }} />
              加载中...
            </div>
          ) : files.length === 0 ? (
            <div className="empty-state">
              <Folder size={36} />
              <p>暂无上传文件</p>
              <small>请拖拽文件到上方区域上传</small>
            </div>
          ) : (
            <ul className="file-list">
              {files.map((f, i) => (
                <li key={i} onClick={() => f.type === "file" && openFile(f.path, f.name)}>
                  {f.type === "folder" ? <Folder size={15} className="file-icon" /> : <FileIcon size={15} className="file-icon" />}
                  <span className="file-name" title={f.path}>{f.name}</span>
                  <span className="file-size">
                    {f.type === "folder" ? "" : formatSize(f.size)}
                  </span>
                  {f.type === "file" && (
                    <div className="file-actions" onClick={e => e.stopPropagation()}>
                      <button title="下载" onClick={() => downloadFile(f.path, f.name)}>
                        <Download size={12} />
                      </button>
                      <button title="在新窗口打开" onClick={() => openFile(f.path, f.name)}>
                        <ExternalLink size={12} />
                      </button>
                      <button title="删除" onClick={() => deleteFile(f.path)}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

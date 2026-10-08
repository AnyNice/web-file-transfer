"use client";
import { useState, useRef, useEffect } from "react";
import { Info } from "lucide-react";

export default function Tooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <span
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        style={{ cursor: "pointer", color: "#aaa", padding: 2, display: "flex", alignItems: "center", border: "none", background: "transparent" }}
      >
        <Info size={14} />
      </span>
      {open && (
        <div style={{
          position: "absolute",
          bottom: "100%",
          left: 0,
          marginBottom: 6,
          background: "#18191c",
          color: "#ececf0",
          borderRadius: 7,
          padding: "8px 11px",
          fontSize: 12,
          lineHeight: 1.6,
          width: 240,
          zIndex: 100,
          boxShadow: "0 4px 16px #0004",
        }}>
          {text}
          <div style={{ position: "absolute", top: "100%", left: 12, border: "6px solid transparent", borderTopColor: "#18191c" }} />
        </div>
      )}
    </div>
  );
}

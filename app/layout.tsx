import type { Metadata } from "next";
import "font-awesome/css/font-awesome.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "局域网快传 · 文件传输",
  description: "基于 WebRTC 的局域网文件传输工具，支持服务器模式和 P2P 模式",
};

// 2026-11-12：Tailwind 与 Font Awesome 改为本地打包（原先走 CDN，
// 无外网的局域网里页面会没样式没图标，与「局域网工具」的定位冲突）。主题
// 配置迁移到 tailwind.config.js。
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="bg-pageBg min-h-screen">
        {children}
      </body>
    </html>
  );
}

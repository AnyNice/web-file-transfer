import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "局域网快传 · 文件传输",
  description: "基于 WebRTC 的局域网文件传输工具，支持服务器模式和 P2P 模式",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script src="https://cdn.tailwindcss.com" />
        <script dangerouslySetInnerHTML={{ __html: `
          tailwind.config = {
            theme: {
              extend: {
                colors: {
                  pageBg: "#faf9f9",
                  errorRed: "#d92525",
                  errorRedLight: "#fde8e8",
                  brandGreen: "#28a745",
                  brandGreenLight: "#eafceb",
                },
                boxShadow: {
                  softFloat: "0 14px 44px rgba(0,0,0,0.055)"
                },
                borderRadius: {
                  shell: "22px",
                  tab: "14px 14px 4px 4px",
                  codeCard: "14px"
                }
              }
            }
          }
        ` }} />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" />
      </head>
      <body className="bg-pageBg min-h-screen flex items-center justify-center p-6">
        {children}
      </body>
    </html>
  );
}

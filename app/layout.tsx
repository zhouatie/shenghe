import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "价值突变雷达",
  description: "本地实战投研工作台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

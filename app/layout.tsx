import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  // 反向代理会转发原始 Host/Proto；使用它们生成正确的 canonical、OG 图片和 manifest URL。
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const description = "私有、跨设备的文本、链接与文件投递箱。";
  return {
    metadataBase: base,
    title: "Drop Worker",
    description,
    applicationName: "Drop Worker",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
    openGraph: {
      title: "Drop Worker",
      description,
      type: "website",
      images: [{ url: new URL("/og.png", base), width: 1536, height: 1024, alt: "Drop Worker" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Drop Worker",
      description,
      images: [new URL("/og.png", base)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

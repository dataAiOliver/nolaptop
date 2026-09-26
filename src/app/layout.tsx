import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TabBar, TopBar } from "@/components/Nav";
import { LiveProvider } from "@/components/LiveProvider";
import { RegisterSW } from "@/components/RegisterSW";

export const metadata: Metadata = {
  title: "NoLaptop",
  description: "Start a coding agent on any of your servers — from your phone.",
  manifest: "/manifest.webmanifest",
  applicationName: "NoLaptop",
  appleWebApp: {
    capable: true,
    title: "NoLaptop",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#101113" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LiveProvider>
          <RegisterSW />
          <TopBar />
          <main className="mx-auto w-full max-w-5xl px-4 pb-28 pt-4 md:pb-12 md:pt-6">
            {children}
          </main>
          <TabBar />
        </LiveProvider>
      </body>
    </html>
  );
}

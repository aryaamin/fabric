import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cn } from "../lib/cn";
import "./globals.css";

export const metadata = {
  title: "Fabric Studio",
  description: "Create software like documents. Interpreted, never deployed.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("dark", GeistSans.variable, GeistMono.variable)}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

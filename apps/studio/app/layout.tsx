import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cn } from "../lib/cn";
import { TooltipProvider } from "../components/ui/AiTooltip";
import "./globals.css";

export const metadata = {
  title: "Fabric",
  description: "Projects that people and AI can build, run, and share.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const content = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
    <ClerkProvider>{children}</ClerkProvider>
  ) : (
    children
  );
  return (
    <html lang="en" className={cn(GeistSans.variable, GeistMono.variable, "font-sans")}>
      <body className="min-h-screen antialiased">
        <TooltipProvider>{content}</TooltipProvider>
      </body>
    </html>
  );
}

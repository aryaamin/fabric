import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cn } from "../lib/cn";
import { TooltipProvider } from "../components/ui/AiTooltip";
import "./globals.css";
import { Geist } from "next/font/google";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata = {
  title: "Fabric Studio",
  description: "Create software like documents. Interpreted, never deployed.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const content = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? (
    <ClerkProvider>{children}</ClerkProvider>
  ) : (
    children
  );
  return (
    <html lang="en" className={cn("dark", GeistSans.variable, GeistMono.variable, "font-sans", geist.variable)}>
      <body className="min-h-screen antialiased">
        <TooltipProvider>{content}</TooltipProvider>
      </body>
    </html>
  );
}

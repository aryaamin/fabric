import Link from "next/link";
import type { ReactNode } from "react";
import { Bot, Cable, FolderKanban } from "lucide-react";
import { cn } from "../lib/cn";

const NAVIGATION = [
  { label: "Projects", href: "/projects", icon: FolderKanban, activeOn: "projects" },
  { label: "Connections", href: "/connect", icon: Cable, activeOn: "connections" },
] as const;

export function CloudShell({
  active,
  title,
  description,
  actions,
  children,
}: {
  active: "projects" | "connections";
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-base">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[200px] flex-col border-r border-line bg-panel lg:flex">
        <Link href="/projects" className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span className="flex size-7 items-center justify-center rounded-md bg-accent text-[14px] font-bold text-white shadow-[0_0_24px_#7c5cff55]">
            ▚
          </span>
          <div className="leading-tight">
            <div className="text-[13.5px] font-semibold">Fabric</div>
            <div className="text-[10px] text-ink-3">Workspace</div>
          </div>
        </Link>

        <nav aria-label="Workspace navigation" className="space-y-1 p-2.5">
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            const selected = item.activeOn === active;
            const content = (
              <>
                <Icon className="size-3.5" strokeWidth={1.8} />
                <span>{item.label}</span>
              </>
            );
            return (
              <Link
                key={item.label}
                href={item.href}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
                  selected
                    ? "bg-accent-dim text-accent-hi"
                    : "text-ink-2 hover:bg-hover hover:text-ink",
                )}
              >
                {content}
              </Link>
            );
          })}
        </nav>

        <div className="mx-3 mt-auto border-t border-line-soft py-3">
          <Link
            href="/connect"
            className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
          >
            <Bot className="size-3.5 text-accent-hi" />
            Connect an AI
          </Link>
        </div>
      </aside>

      <div className="lg:pl-[200px]">
        <header className="sticky top-0 z-20 flex h-14 items-center border-b border-line bg-base/90 px-4 backdrop-blur-xl sm:px-6">
          <Link href="/projects" className="flex items-center gap-2 lg:hidden">
            <span className="text-accent">▚</span>
            <span className="text-[13px] font-semibold">Fabric</span>
          </Link>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>

        <main>
          <div className="border-b border-line-soft bg-panel/35 px-4 py-5 sm:px-6">
            <div className="mx-auto max-w-[1500px]">
              <h1 className="text-[20px] font-semibold tracking-[-0.025em]">{title}</h1>
              {description ? (
                <p className="mt-1 max-w-[760px] text-[12.5px] text-ink-2">
                  {description}
                </p>
              ) : null}
            </div>
          </div>
          <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

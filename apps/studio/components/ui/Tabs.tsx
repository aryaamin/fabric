"use client";

import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Tabs — controlled, minimal. A sliding underline is deliberately avoided in
 * favour of a filled pill: it reads at a glance in dense chrome and never
 * measures the DOM (so it cannot shift).
 */
export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("inline-flex items-center gap-0.5 rounded-md border border-line bg-base p-0.5", className)}>
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-[12.5px] font-medium transition-colors duration-150",
              active ? "bg-raised text-ink shadow-[0_1px_0_#ffffff0d_inset]" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {it.label}
            {it.count !== undefined && (
              <span className={cn("font-mono text-[11px]", active ? "text-ink-3" : "text-ink-3/70")}>{it.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

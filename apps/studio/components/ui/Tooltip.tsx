import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Tooltip — CSS-only (group-hover), so it costs no JS, no portal, and no
 * measurement. Sufficient for chrome affordances; anything richer would be a
 * popover, which is a different component.
 */
export function Tooltip({
  label,
  side = "bottom",
  children,
  className,
}: {
  label: ReactNode;
  side?: "top" | "bottom";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("group/tt relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 scale-95 whitespace-nowrap rounded-sm border border-line bg-raised px-2 py-1 text-[11.5px] text-ink-2 opacity-0 shadow-lg transition-[opacity,transform] duration-150",
          "group-hover/tt:scale-100 group-hover/tt:opacity-100",
          side === "bottom" ? "top-[calc(100%+6px)]" : "bottom-[calc(100%+6px)]",
        )}
      >
        {label}
      </span>
    </span>
  );
}

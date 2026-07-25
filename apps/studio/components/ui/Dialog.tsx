"use client";

import { useEffect, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/**
 * Dialog / Sheet — hand-built, no Radix. Escape closes, the backdrop closes,
 * body scroll is locked, and the panel animates in without moving layout.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  width = "560px",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  width?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="animate-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 p-4 backdrop-blur-[2px] sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        style={{ width: `min(${width}, 100%)` }}
        className="animate-pop my-auto overflow-hidden rounded-xl border border-line bg-panel shadow-[0_32px_80px_-24px_#000000cc]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[14.5px] font-semibold tracking-[-0.01em]">{title}</div>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 14 14" className="size-3.5">
              <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line-soft bg-base/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Sheet — the same machinery, docked to an edge. Used for version history. */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  side = "right",
  width = "480px",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  side?: "right" | "left";
  width?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="animate-fade fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" onClick={onClose} role="presentation">
      <aside
        style={{ width: `min(${width}, 100%)` }}
        className={cn(
          "absolute inset-y-0 flex flex-col border-line bg-panel shadow-[0_0_80px_#000000aa]",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-4 py-3">
          <div>
            <div className="text-[14px] font-semibold tracking-[-0.01em]">{title}</div>
            {subtitle && <div className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 14 14" className="size-3.5">
              <path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

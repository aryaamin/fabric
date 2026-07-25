import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Badge — the IR's `tone` vocabulary, exactly: neutral | success | warning |
 * danger. The renderer maps a data value ("approved") onto a tone, so the same
 * component serves app data and studio chrome.
 */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-raised text-ink-2",
  success: "border-ok/25 bg-ok-dim text-ok",
  warning: "border-warn/25 bg-warn-dim text-warn",
  danger: "border-bad/25 bg-bad-dim text-bad",
  accent: "border-accent/30 bg-accent-dim text-accent-hi",
};

/** Words a data column commonly carries, mapped onto a tone. */
export function toneForValue(value: unknown): BadgeTone {
  const v = String(value ?? "").toLowerCase();
  if (/(approved|active|done|paid|success|open|complete|ok|yes|live)/.test(v)) return "success";
  if (/(pending|review|waiting|draft|queued|hold)/.test(v)) return "warning";
  if (/(rejected|failed|error|denied|blocked|overdue|no)/.test(v)) return "danger";
  return "neutral";
}

export function Badge({
  tone = "neutral",
  dot = false,
  mono = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  mono?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-[18px] whitespace-nowrap",
        mono && "font-mono text-[11px]",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

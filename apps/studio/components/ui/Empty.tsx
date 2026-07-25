import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Empty / Error states. Every surface in the studio has one, because a blank
 * region is the fastest way to make a product feel broken.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {icon && (
        <div className="mb-1 flex size-9 items-center justify-center rounded-md border border-line bg-raised text-ink-3">
          {icon}
        </div>
      )}
      <div className="text-[13.5px] font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-[46ch] text-[12.5px] leading-relaxed text-ink-3">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: ReactNode }) {
  return (
    <div className="animate-rise m-4 rounded-md border border-bad/25 bg-bad-dim px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0 text-bad">
          <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 5v4M8 11h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-bad">Something went wrong</div>
          <div className="mt-0.5 break-words font-mono text-[11.5px] leading-relaxed text-bad/80">{message}</div>
        </div>
        {retry}
      </div>
    </div>
  );
}

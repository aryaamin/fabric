import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Card — the one container primitive. A 1px line, a slightly raised fill. */
export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-line bg-panel", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  if (!title && !subtitle && !actions) return null;
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line-soft px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        {title && <div className="truncate text-[13.5px] font-medium text-ink">{title}</div>}
        {subtitle && <div className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-4", className)} {...rest}>
      {children}
    </div>
  );
}

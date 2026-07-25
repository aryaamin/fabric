import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Button — shadcn-shaped API (variant + size), hand-built in Tailwind.
 * Focus rings, disabled states and the 120ms press feel are part of the
 * contract, not decoration: this is the most-clicked object in the studio.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white shadow-[0_1px_0_0_#ffffff26_inset,0_8px_24px_-12px_#7c5cffaa] hover:bg-accent-hi active:translate-y-px",
  secondary: "bg-raised text-ink border border-line hover:bg-hover active:translate-y-px",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  outline: "border border-line text-ink-2 hover:border-ink-3 hover:text-ink",
  danger: "bg-bad-dim text-bad border border-bad/30 hover:bg-bad/20",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-sm px-2.5 text-[12.5px]",
  md: "h-8.5 gap-2 rounded-md px-3 text-[13.5px]",
  lg: "h-10 gap-2 rounded-md px-4 text-[14px]",
  icon: "size-8 rounded-md justify-center",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex select-none items-center whitespace-nowrap font-medium transition-[background-color,border-color,color,transform,opacity] duration-150",
        "disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "animate-spin-slow inline-block size-3 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent opacity-70",
        className,
      )}
    />
  );
}

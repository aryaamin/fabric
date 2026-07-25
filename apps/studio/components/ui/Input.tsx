import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const FIELD =
  "w-full rounded-md border border-line bg-raised px-2.5 text-[13.5px] text-ink placeholder:text-ink-3 transition-colors duration-150 hover:border-ink-3/50 focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50";

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cn(FIELD, "h-8.5", invalid && "border-bad/60 focus:ring-bad/25", className)} {...rest} />;
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={cn(FIELD, "min-h-[76px] resize-y py-2 leading-relaxed", invalid && "border-bad/60 focus:ring-bad/25", className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  invalid,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <select
        className={cn(
          FIELD,
          "h-8.5 cursor-pointer appearance-none pr-7",
          invalid && "border-bad/60 focus:ring-bad/25",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-ink-3"
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function Label({ children, htmlFor, hint }: { children: React.ReactNode; htmlFor?: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="flex items-baseline gap-2 text-[12.5px] font-medium text-ink-2">
      {children}
      {hint && <span className="font-normal text-ink-3">{hint}</span>}
    </label>
  );
}

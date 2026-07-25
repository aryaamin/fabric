import { cn } from "../../lib/cn";

/** Skeleton — reserves the exact final geometry so nothing shifts on load. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-sm", className)} />;
}

/** The canvas placeholder: shaped like a real app view, not a grey box. */
export function CanvasSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[860px] space-y-6 p-8">
      <Skeleton className="h-7 w-56" />
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-[86px] rounded-lg" />
        <Skeleton className="h-[86px] rounded-lg" />
        <Skeleton className="h-[86px] rounded-lg" />
      </div>
      <Skeleton className="h-[196px] rounded-lg" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    </div>
  );
}

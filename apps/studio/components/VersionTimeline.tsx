"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RenderNode } from "@fabric/interpreter";
import { cn } from "../lib/cn";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Sheet } from "./ui/Dialog";
import { Skeleton } from "./ui/Skeleton";

/**
 * Version history and time travel.
 *
 * The scrubber is the sharpest demonstration in the product. Dragging it
 * re-renders the app at each past version, live, against real data — because a
 * version is an immutable document and rendering one costs a fraction of a
 * millisecond. Nothing is committed while scrubbing, so head stays where the
 * user left it until they choose Restore.
 *
 * A codegen platform cannot offer this control at all: recovering an old state
 * there means checking out an old source tree and rebuilding and redeploying it.
 * You can offer a list of commits. You cannot offer a slider.
 */

export interface VersionEntry {
  id: string;
  parent?: string;
  author: string;
  message: string;
  createdAt: string;
  summary: string;
  changes: number;
  irBytes: number;
  isHead: boolean;
}

export function VersionTimeline({
  open,
  onClose,
  slug,
  onPreview,
  onCommitted,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  /** show a previewed tree on the canvas; null returns the canvas to head. */
  onPreview: (view: RenderNode | null, label: string | null) => void;
  /** a restore or fork changed the app; the parent should refresh. */
  onCommitted: (view: RenderNode) => void;
}) {
  const [versions, setVersions] = useState<VersionEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [previewMs, setPreviewMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/version?slug=${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (data.ok) {
      setVersions(data.versions as VersionEntry[]);
      setIndex((data.versions as VersionEntry[]).length - 1);
    } else {
      setError(data.error ?? "Could not load history.");
    }
  }, [slug]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Scrubbing: preview the selected version unless it is head, in which case the
  // canvas returns to the live app.
  const preview = useCallback(
    async (i: number) => {
      if (!versions) return;
      const v = versions[i];
      if (!v) return;
      if (v.isHead) {
        onPreview(null, null);
        setPreviewMs(null);
        return;
      }
      const seq = ++inflight.current;
      const res = await fetch("/api/version", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "preview", versionId: v.id }),
      });
      const data = await res.json();
      // Drop stale responses: a fast drag fires many requests and only the last
      // one describes what the user is looking at.
      if (seq !== inflight.current) return;
      if (data.ok) {
        onPreview(data.view as RenderNode, `${short(v.id)} · ${relative(v.createdAt)}`);
        setPreviewMs(data.ms as number);
      }
    },
    [versions, slug, onPreview],
  );

  async function restore() {
    const v = versions?.[index];
    if (!v || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/version", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "restore", versionId: v.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Could not restore.");
        return;
      }
      onPreview(null, null);
      onCommitted(data.view as RenderNode);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function fork() {
    const v = versions?.[index];
    if (!v || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/version", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, op: "fork", versionId: v.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Could not fork.");
        return;
      }
      window.location.href = `/w/${data.slug}`;
    } finally {
      setBusy(false);
    }
  }

  const current = versions?.[index];
  const atHead = current?.isHead ?? true;

  return (
    <Sheet
      open={open}
      onClose={() => {
        onPreview(null, null);
        onClose();
      }}
      title="Version history"
      subtitle="Every prompt is a version. Drag to travel; nothing is committed until you restore."
      width="460px"
    >
      {error && <div className="m-4 rounded-md border border-bad/25 bg-bad-dim px-3 py-2 text-[12.5px] text-bad">{error}</div>}

      {!versions ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 rounded-md" />
          ))}
        </div>
      ) : (
        <>
          {/* The scrubber */}
          <div className="border-b border-line-soft bg-base/40 px-4 py-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-medium uppercase tracking-[0.05em] text-ink-3">Time travel</span>
              <span className="font-mono text-[11.5px] text-ink-3">
                {index + 1} / {versions.length}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(0, versions.length - 1)}
              value={index}
              onChange={(e) => {
                const i = Number(e.target.value);
                setIndex(i);
                void preview(i);
              }}
              className="mt-3 w-full accent-[var(--color-accent)]"
              aria-label="Version scrubber"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[12px] text-ink-3">
                {atHead ? "Live (head)" : `Viewing ${short(current!.id)}`}
              </span>
              {previewMs !== null && !atHead && (
                <span className="font-mono text-[11.5px] text-accent-hi">rendered in {previewMs.toFixed(2)} ms</span>
              )}
            </div>
            {!atHead && (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="primary" loading={busy} onClick={restore}>
                  Restore this version
                </Button>
                <Button size="sm" variant="secondary" loading={busy} onClick={fork}>
                  Fork from here
                </Button>
              </div>
            )}
          </div>

          {/* The list, newest first */}
          <ol className="p-2">
            {[...versions].reverse().map((v) => {
              const i = versions.findIndex((x) => x.id === v.id);
              const selected = i === index;
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setIndex(i);
                      void preview(i);
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors duration-150",
                      selected ? "border-accent/45 bg-accent-dim" : "border-transparent hover:bg-hover",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] text-ink">{v.message}</span>
                      {v.isHead && (
                        <Badge tone="success" className="ml-auto shrink-0">
                          head
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
                      <span>{short(v.id)}</span>
                      <span>·</span>
                      <span>{v.author}</span>
                      <span>·</span>
                      <span>{relative(v.createdAt)}</span>
                      <span>·</span>
                      <span>{(v.irBytes / 1024).toFixed(1)} KB</span>
                    </div>
                    <div className="text-[12px] text-ink-2">{v.summary}</div>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </Sheet>
  );
}

function short(id: string): string {
  return id.replace(/^v_/, "").slice(0, 8);
}

function relative(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

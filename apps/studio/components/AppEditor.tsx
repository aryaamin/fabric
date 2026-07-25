"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { RenderNode } from "@fabric/interpreter";
import { cn } from "../lib/cn";
import type { DiffChip } from "../lib/patch-summary";
import { Renderer } from "./Renderer";
import { ShareDialog } from "./ShareDialog";
import { VersionTimeline } from "./VersionTimeline";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { ErrorState } from "./ui/Empty";
import { Input } from "./ui/Input";

/**
 * The app editor: three panes — workspace rail, live canvas, AI chat.
 *
 * The canvas arrives server-rendered (see page.tsx) and is then swapped in place
 * by whatever returns a fresh tree: an edit, a form submit, a button, a restore,
 * or a time-travel preview. There is no build step in any of those paths, which
 * is why "the app updates while you talk to it" is a property of the
 * architecture rather than a trick of the UI.
 */

export interface RailItem {
  slug: string;
  name: string;
  icon: string;
}

interface Message {
  role: "user" | "assistant";
  text: string;
  chips?: DiffChip[];
  ms?: number;
  versionId?: string;
  suggestions?: string[];
  failed?: boolean;
}

export function AppEditor({
  slug,
  name,
  icon,
  viewName,
  initialView,
  readOnly = false,
  rail,
  plannerLabel,
  examples,
}: {
  slug: string;
  name: string;
  icon: string;
  viewName: string;
  initialView: RenderNode;
  readOnly?: boolean;
  rail: RailItem[];
  plannerLabel: string;
  examples: string[];
}) {
  const [tree, setTree] = useState<RenderNode>(initialView);
  const [preview, setPreview] = useState<{ view: RenderNode; label: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  const shown = preview?.view ?? tree;

  function scrollChat() {
    requestAnimationFrame(() => chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
  }

  async function send(text?: string) {
    const prompt = (text ?? input).trim();
    if (!prompt || busy) return;
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", text: prompt }]);
    scrollChat();

    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, prompt }),
      });
      const data = await res.json();

      if (data.ok) {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `Applied ${data.chips?.length ?? 0} change${data.chips?.length === 1 ? "" : "s"}.`,
            chips: data.chips,
            ms: data.ms,
            versionId: data.versionId,
          },
        ]);
        if (data.view) {
          setPreview(null);
          setTree(data.view as RenderNode);
        }
      } else {
        setMessages((m) => [
          ...m,
          { role: "assistant", text: data.error ?? "That didn't work.", chips: data.chips, suggestions: data.suggestions, failed: true },
        ]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: (e as Error).message, failed: true }]);
    } finally {
      setBusy(false);
      scrollChat();
    }
  }

  /** A form inside the app submitted. Raw values only — the server maps them. */
  async function submit(action: string, values: Record<string, unknown>) {
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, view: viewName, action, form: values }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "Submit failed");
    setPreview(null);
    setTree(data.view as RenderNode);
  }

  /** A button inside the app fired. */
  async function invoke(action: string, args: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, action, args }),
    });
    const data = await res.json();
    if (!data.ok) {
      setError(data.error ?? "That action failed.");
      return;
    }
    if (data.view) {
      setPreview(null);
      setTree(data.view as RenderNode);
    }
  }

  const canvas = (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      {preview && (
        <div className="sticky top-0 z-10 flex items-center gap-2.5 border-b border-accent/25 bg-accent-dim/90 px-4 py-2 backdrop-blur">
          <Badge tone="accent" dot>
            Time travel
          </Badge>
          <span className="font-mono text-[12px] text-accent-hi">{preview.label}</span>
          <span className="text-[12px] text-ink-3">read-only preview of an older version</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPreview(null)}>
            Back to live
          </Button>
        </div>
      )}
      {error && <ErrorState message={error} retry={<Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>} />}
      <Renderer node={shown} onAction={invoke} onSubmit={submit} readOnly={readOnly || preview !== null} />
    </div>
  );

  /* ---- the run-only surface: a shared app, no editor chrome ---------- */
  if (readOnly) {
    return (
      <div className="flex min-h-screen flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-line bg-panel px-4">
          <span className="text-[15px] leading-none">{icon}</span>
          <span className="text-[13.5px] font-medium">{name}</span>
          <Badge tone="neutral">View only</Badge>
          <span className="ml-auto flex items-center gap-2">
            <span className="text-[12.5px] text-ink-3">Shared with you</span>
            <Button size="sm" variant="secondary" onClick={() => (window.location.href = `/w/${slug}?fork=1`)}>
              Fork a copy
            </Button>
          </span>
        </header>
        {canvas}
      </div>
    );
  }

  /* ---- the studio surface ------------------------------------------- */
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
        <Link href="/" className="flex items-center gap-2 text-ink-3 transition-colors hover:text-ink">
          <span className="text-[15px] leading-none text-accent">▚</span>
          <span className="text-[13px]">Acme Inc</span>
        </Link>
        <span className="text-ink-3">/</span>
        <span className="text-[15px] leading-none">{icon}</span>
        <span className="text-[13.5px] font-medium tracking-[-0.01em]">{name}</span>
        <Badge tone="neutral" mono className="ml-1">
          {viewName}
        </Badge>

        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
            History
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShareOpen(true)}>
            Embed
          </Button>
          <Button size="sm" variant="primary" onClick={() => setShareOpen(true)}>
            Share
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* workspace rail */}
        <nav className="hidden w-[210px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-panel/60 p-2 lg:flex">
          <div className="px-2 py-1.5 text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">Workspace</div>
          {rail.map((r) => (
            <Link
              key={r.slug}
              href={`/w/${r.slug}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150",
                r.slug === slug ? "bg-raised text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              <span className="text-[14px] leading-none">{r.icon}</span>
              <span className="truncate">{r.name}</span>
            </Link>
          ))}
        </nav>

        {/* canvas */}
        <main className="flex min-w-0 flex-1 flex-col bg-base">{canvas}</main>

        {/* AI chat */}
        <aside className="flex w-[368px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="shrink-0 border-b border-line-soft px-4 py-3">
            <div className="text-[13.5px] font-medium">Edit by conversation</div>
            <div className="mt-0.5 font-mono text-[11.5px] text-ink-3">{plannerLabel}</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
            {messages.length === 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  Describe a change and the document is patched, validated and re-rendered. Every change becomes a
                  version you can scrub back through.
                </p>
                <div className="flex flex-col gap-1.5">
                  {examples.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => void send(ex)}
                      className="rounded-md border border-line bg-raised px-2.5 py-2 text-left text-[12.5px] text-ink-2 transition-colors duration-150 hover:border-accent/40 hover:bg-accent-dim hover:text-ink"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3.5">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="animate-rise self-end rounded-lg rounded-br-sm bg-accent px-3 py-2 text-[13px] text-white">
                    {m.text}
                  </div>
                ) : (
                  <div key={i} className="animate-rise flex flex-col gap-2">
                    <div className={cn("text-[13px] leading-relaxed", m.failed ? "text-warn" : "text-ink-2")}>
                      {m.text}
                    </div>

                    {m.chips && m.chips.length > 0 && (
                      <ul className="flex flex-col gap-1">
                        {m.chips.map((c, j) => (
                          <li
                            key={j}
                            title={c.path}
                            className="flex items-start gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5"
                          >
                            <span
                              className={cn(
                                "mt-px font-mono text-[12px] leading-5",
                                c.kind === "added" ? "text-ok" : c.kind === "removed" ? "text-bad" : "text-warn",
                              )}
                            >
                              {c.kind === "added" ? "+" : c.kind === "removed" ? "−" : "~"}
                            </span>
                            <span className="text-[12.5px] leading-5 text-ink-2">{renderTicks(c.text)}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {m.suggestions && (
                      <div className="flex flex-col gap-1">
                        <div className="text-[12px] text-ink-3">Try one of these:</div>
                        {m.suggestions.slice(0, 4).map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => void send(s)}
                            className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:border-accent/40 hover:text-ink"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}

                    {m.ms !== undefined && (
                      <div className="flex items-center gap-2 font-mono text-[11.5px] text-ink-3">
                        <span className="text-accent-hi">applied in {m.ms.toFixed(2)} ms</span>
                        {m.versionId && <span>· {m.versionId.replace(/^v_/, "").slice(0, 8)}</span>}
                        <span>· no rebuild</span>
                      </div>
                    )}
                  </div>
                ),
              )}
              <div ref={chatEnd} />
            </div>
          </div>

          <div className="shrink-0 border-t border-line-soft p-3">
            <div className="flex items-center gap-2">
              <Input
                value={input}
                placeholder="Describe a change…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void send();
                }}
                disabled={busy}
              />
              <Button variant="primary" loading={busy} onClick={() => void send()} disabled={!input.trim()}>
                Send
              </Button>
            </div>
          </div>
        </aside>
      </div>

      <ShareDialog slug={slug} name={name} open={shareOpen} onClose={() => setShareOpen(false)} />
      <VersionTimeline
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        slug={slug}
        onPreview={(view, label) => setPreview(view && label ? { view, label } : null)}
        onCommitted={(view) => setTree(view)}
      />
    </div>
  );
}

/** Render `code spans` from the patch summaries without a markdown dependency. */
function renderTicks(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded-xs bg-base px-1 font-mono text-[11.5px] text-ink">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

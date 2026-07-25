"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Textarea } from "./ui/Input";

/**
 * "New app" — describe it, get a URL.
 *
 * The composer is deliberately a single textarea with example chips rather than
 * a form of fields: the promise of the product is that describing software is
 * enough, and a wizard would quietly contradict it.
 */

const EXAMPLES = [
  { label: "Track team expenses with approvals", template: "expense-tracker" },
  { label: "Leave requests my managers approve", template: "leave-requests" },
  { label: "A revenue dashboard by month", template: "revenue-dashboard" },
  { label: "A simple accounting ledger", template: "accounting" },
];

export function NewAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; template: string; ms: number; note?: string } | null>(null);

  async function create(template?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, template }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Could not create the app.");
        return;
      }
      setResult({ name: data.name, template: data.template, ms: data.ms, note: data.note });
      // Let the "created in Xms" land for a beat before navigating: the number
      // is the whole point of this screen.
      setTimeout(() => router.push(`/w/${data.slug}`), 700);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New app"
      subtitle="Describe it in a sentence. You get a live URL — nothing is built or deployed."
      width="620px"
      footer={
        <>
          <span className="mr-auto text-[12px] text-ink-3">
            Starts from the closest template, then applies your description as an edit.
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void create()} disabled={!prompt.trim()}>
            Create app
          </Button>
        </>
      }
    >
      {result ? (
        <div className="animate-rise flex flex-col items-center gap-2 py-8 text-center">
          <div className="font-mono text-[34px] font-medium leading-none tracking-[-0.03em] text-ink">
            {result.ms.toFixed(2)}
            <span className="ml-1 text-[16px] text-ink-3">ms</span>
          </div>
          <div className="text-[13.5px] text-ink-2">
            <span className="font-medium text-ink">{result.name}</span> is live.
          </div>
          <div className="text-[12.5px] text-ink-3">
            Started from the {result.template} template. Opening it…
          </div>
          {result.note && <div className="mt-1 text-[12px] text-warn">{result.note}</div>}
        </div>
      ) : (
        <>
          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="I need a way for the team to submit expenses and for managers to approve them…"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void create();
            }}
          />
          <div className="mt-3.5">
            <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.05em] text-ink-3">Or start from</div>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.template}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPrompt(ex.label);
                    void create(ex.template);
                  }}
                  className="rounded-full border border-line bg-raised px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors duration-150 hover:border-accent/40 hover:bg-accent-dim hover:text-ink disabled:opacity-50"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
          {error && <div className="mt-3 text-[12.5px] text-bad">{error}</div>}
          <div className="mt-4 flex items-center gap-2 border-t border-line-soft pt-3.5">
            <Badge tone="accent" mono>
              ⌘↵
            </Badge>
            <span className="text-[12px] text-ink-3">to create</span>
          </div>
        </>
      )}
    </Dialog>
  );
}

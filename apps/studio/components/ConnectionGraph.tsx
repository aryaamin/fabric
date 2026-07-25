"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardHeader } from "./ui/Card";
import { EmptyState } from "./ui/Empty";

/**
 * The connection graph — composition you can see.
 *
 * Two apps written independently are wired by one subscription in a document:
 * no endpoint, no client, no shared schema package, no credential. That is the
 * claim, so the graph shows the wire and then shows an event actually travelling
 * along it, live, against real data.
 *
 * Geometry is computed, never measured: fixed card sizes and column positions
 * mean the SVG paths are pure functions of the data, so the graph cannot shift
 * as it loads and needs no ResizeObserver.
 */

export interface GraphApp {
  id: string;
  name: string;
  icon: string;
  events: string[];
  subscriptions: { from: string; event: string; action: string }[];
}

const CARD_W = 216;
const CARD_H = 74;
const ROW_GAP = 26;
const COL_X = [8, 336];
const VIEW_W = 560;

interface Placed extends GraphApp {
  x: number;
  y: number;
}

export function ConnectionGraph({ apps }: { apps: GraphApp[] }) {
  const [pulse, setPulse] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subscribers = new Set(apps.filter((a) => a.subscriptions.length > 0).map((a) => a.id));
  const left = apps.filter((a) => !subscribers.has(a.id));
  const right = apps.filter((a) => subscribers.has(a.id));

  const placed: Placed[] = [
    ...left.map((a, i) => ({ ...a, x: COL_X[0]!, y: i * (CARD_H + ROW_GAP) })),
    ...right.map((a, i) => ({ ...a, x: COL_X[1]!, y: i * (CARD_H + ROW_GAP) })),
  ];
  const byId = new Map(placed.map((p) => [p.id, p]));
  const height = Math.max(1, Math.max(left.length, right.length)) * (CARD_H + ROW_GAP);

  const wires = placed.flatMap((target) =>
    target.subscriptions
      .map((sub) => {
        const source = byId.get(sub.from);
        if (!source) return null;
        return { source, target, ...sub };
      })
      .filter((w): w is { source: Placed; target: Placed; from: string; event: string; action: string } => w !== null),
  );

  /**
   * Fire a real action whose event the wires carry. Nothing is simulated: the
   * approval writes a row, the runtime publishes the event, the subscribing app
   * runs its own action. The animation is just the receipt.
   */
  async function traceEvent() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "expense-tracker", action: "approveOldest" }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Nothing left to approve.");
        return;
      }
      setPulse((n) => n + 1);
      setFlash("expenseApproved → accounting.recordEntry");
      setTimeout(() => setFlash(null), 2600);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (apps.length === 0) {
    return (
      <Card>
        <EmptyState title="No apps to connect yet" hint="Create two apps and one can subscribe to the other's events." />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Connections"
        subtitle="Apps publish events; other apps subscribe. No APIs, no credentials, no glue code."
        actions={
          <Button size="sm" variant="secondary" loading={busy} onClick={traceEvent}>
            Trace an event
          </Button>
        }
      />
      <div className="p-4">
        <div className="relative mx-auto" style={{ width: VIEW_W, height }}>
          <svg
            className="absolute inset-0 overflow-visible"
            width={VIEW_W}
            height={height}
            aria-hidden
          >
            {wires.map((w, i) => {
              const x1 = w.source.x + CARD_W;
              const y1 = w.source.y + CARD_H / 2;
              const x2 = w.target.x;
              const y2 = w.target.y + CARD_H / 2;
              const mid = (x1 + x2) / 2;
              const d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
              const id = `wire-${i}`;
              return (
                <g key={id}>
                  <path d={d} fill="none" stroke="var(--color-line)" strokeWidth={1.5} />
                  <path
                    id={id}
                    d={d}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth={1.5}
                    strokeOpacity={0.55}
                    className="wire-flow"
                  />
                  {pulse > 0 && (
                    // Keyed by the pulse count so a new packet is minted per
                    // fire; animateMotion runs once and then disappears.
                    <circle key={`${id}-${pulse}`} r={4} fill="var(--color-accent-hi)">
                      <animateMotion dur="0.85s" repeatCount="1" fill="remove" path={d} />
                    </circle>
                  )}
                  <text
                    x={mid}
                    y={(y1 + y2) / 2 - 8}
                    textAnchor="middle"
                    className="fill-ink-3 font-mono"
                    style={{ fontSize: 10.5 }}
                  >
                    {w.event}
                  </text>
                </g>
              );
            })}
          </svg>

          {placed.map((a) => (
            <Link
              key={a.id}
              href={`/w/${a.id}`}
              className="group absolute rounded-lg border border-line bg-raised px-3 py-2.5 transition-[border-color,background-color] duration-150 hover:border-accent/45 hover:bg-hover"
              style={{ left: a.x, top: a.y, width: CARD_W, height: CARD_H }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[15px] leading-none">{a.icon}</span>
                <span className="truncate text-[13px] font-medium text-ink">{a.name}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden">
                {a.events.length > 0 && (
                  <Badge tone="neutral" mono>
                    {a.events.length} event{a.events.length === 1 ? "" : "s"}
                  </Badge>
                )}
                {a.subscriptions.length > 0 && (
                  <Badge tone="accent" mono>
                    {a.subscriptions.length} wired
                  </Badge>
                )}
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-4 flex min-h-[20px] items-center gap-2 border-t border-line-soft pt-3.5">
          {flash ? (
            <span className="animate-fade font-mono text-[12px] text-accent-hi">{flash}</span>
          ) : error ? (
            <span className="text-[12px] text-warn">{error}</span>
          ) : (
            <span className="text-[12px] text-ink-3">
              Approving an expense publishes an event the accounting app subscribes to — click Trace an event.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

"use client";

import { useState } from "react";
import type { BenchmarkReport } from "@fabric/benchmark";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardHeader } from "./ui/Card";
import { Skeleton } from "./ui/Skeleton";

/**
 * The benchmark panel — the argument, measured live.
 *
 * Presentation rules that are NOT cosmetic:
 *   • Everything under "measured" was measured in this request, on this machine.
 *   • The comparison column is labelled a reference range for the
 *     regenerate → install → build → deploy cycle. It names no product and
 *     quotes no vendor's figures, because we have measured none.
 *   • The multiplier is shown as a range, since the reference is a range, and
 *     the round-trip-inclusive figure is shown next to the raw one — a hosted
 *     edit pays a network hop, and quoting the in-process number alone would be
 *     the kind of overstatement that loses an audience the moment they notice.
 */
export function BenchmarkPanel() {
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallMs, setWallMs] = useState<number | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/benchmark", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "The benchmark did not complete.");
        return;
      }
      setReport(data.report as BenchmarkReport);
      setWallMs(data.wallMs as number);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Run it yourself"
          subtitle="Measures this machine, right now. Nothing here is recorded or pre-computed."
          actions={
            <Button variant="primary" loading={busy} onClick={run}>
              {report ? "Run again" : "Run benchmark"}
            </Button>
          }
        />
        {busy && !report && (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 rounded-md" />
            ))}
          </div>
        )}
        {error && <div className="m-4 rounded-md border border-bad/25 bg-bad-dim px-3 py-2 text-[12.5px] text-bad">{error}</div>}
        {!report && !busy && !error && (
          <div className="px-4 py-8 text-center text-[13px] leading-relaxed text-ink-3">
            The claim is that interpreting a document is a different order of magnitude from regenerating and
            redeploying a codebase. Press the button and read the numbers.
          </div>
        )}
        {report && <Results report={report} wallMs={wallMs} />}
      </Card>
    </div>
  );
}

function Results({ report, wallMs }: { report: BenchmarkReport; wallMs: number | null }) {
  const { measured, baseline, speedup, totals, apps, meta } = report;

  // A hosted edit pays one network round trip on top of the platform cost. We
  // state the assumption rather than bury it, and show what it does to the ratio.
  const ROUND_TRIP_MS = 50;
  const hostedMs = measured.editApply.p50 + ROUND_TRIP_MS;
  const hostedLow = Math.round(baseline.lowMs / hostedMs);
  const hostedHigh = Math.round(baseline.highMs / hostedMs);

  const rows: { label: string; timing: { p50: number; p95: number; runs: number }; note: string }[] = [
    { label: "Edit applied", timing: measured.editApply, note: "patch → validate → install → re-render" },
    { label: "App installed", timing: measured.install, note: "validate + version + wire" },
    { label: "View rendered", timing: measured.render, note: "resolve one view against live data" },
    { label: "Forked", timing: measured.fork, note: "a new app from an existing version" },
    { label: "Restored", timing: measured.restore, note: "move head + reinstall + re-render" },
    { label: "Validated", timing: measured.validate, note: "the gate that runs before anything ships" },
  ];

  return (
    <div className="p-4">
      {/* the headline */}
      <div className="rounded-lg border border-accent/25 bg-accent-dim/40 px-5 py-5">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <div className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">Edit → live</div>
            <div className="mt-1.5 font-mono text-[38px] font-medium leading-none tracking-[-0.03em] text-ink">
              {measured.editApply.p50.toFixed(3)}
              <span className="ml-1.5 text-[16px] text-ink-3">ms</span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-3">
              p50 of {measured.editApply.runs} edits · p95 {measured.editApply.p95.toFixed(3)} ms
            </div>
          </div>
          <div className="text-[22px] text-ink-3">vs</div>
          <div>
            <div className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">
              Rebuild + redeploy
            </div>
            <div className="mt-1.5 font-mono text-[38px] font-medium leading-none tracking-[-0.03em] text-ink-2">
              {baseline.lowMs / 1000}–{baseline.highMs / 1000}
              <span className="ml-1.5 text-[16px] text-ink-3">s</span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-3">
              <Badge tone="warning">reference range</Badge> not measured
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t border-accent/15 pt-4">
          <Ratio
            label="Platform cost only"
            value={`${fmt(speedup.lowX)}–${fmt(speedup.highX)}×`}
            hint="in-process, the number above"
          />
          <Ratio
            label={`Including a ${ROUND_TRIP_MS} ms network hop`}
            value={`${fmt(hostedLow)}–${fmt(hostedHigh)}×`}
            hint="the honest figure for a hosted edit"
            emphasis
          />
        </div>
      </div>

      {/* measured table */}
      <div className="mt-5">
        <SectionLabel>
          Measured here <Badge tone="success">this machine</Badge>
        </SectionLabel>
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-raised/50">
                <Th>operation</Th>
                <Th right>p50</Th>
                <Th right>p95</Th>
                <Th right>runs</Th>
                <Th>covers</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2 text-ink">{r.label}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink">{r.timing.p50.toFixed(3)} ms</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-2">{r.timing.p95.toFixed(3)} ms</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-3">{r.timing.runs}</td>
                  <td className="px-3 py-2 text-[12.5px] text-ink-3">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* the artifact */}
      <div className="mt-5">
        <SectionLabel>What an app actually is</SectionLabel>
        <div className="flex flex-wrap gap-3">
          <Fact label="Apps measured" value={String(totals.apps)} />
          <Fact label="Total IR" value={`${(totals.irBytes / 1024).toFixed(1)} KB`} />
          <Fact label="Generated code files" value="0" tone="accent" />
          <Fact label="Dependencies installed" value="0" tone="accent" />
          <Fact label="Build steps" value="0" tone="accent" />
          <Fact label="Deploy steps" value="0" tone="accent" />
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-line">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-raised/50">
                <Th>app</Th>
                <Th right>IR bytes</Th>
                <Th right>models</Th>
                <Th right>actions</Th>
                <Th right>view nodes</Th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} className="border-b border-line-soft last:border-0">
                  <td className="px-3 py-2 text-ink">{a.name}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-2">{a.irBytes.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-3">{a.models}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-3">{a.actions}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-ink-3">{a.viewNodes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* structural wins */}
      <div className="mt-5">
        <SectionLabel>Why the structural wins are hard to copy</SectionLabel>
        <ul className="flex flex-col gap-2.5">
          {report.structuralWins.map((w) => (
            <li key={w.title} className="rounded-lg border border-line bg-raised px-3.5 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-ink">{w.title}</span>
                {w.ourCostMs !== undefined && (
                  <span className="font-mono text-[11.5px] text-accent-hi">{w.ourCostMs.toFixed(3)} ms here</span>
                )}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{w.why}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* how to read it */}
      <div className="mt-5 rounded-lg border border-line bg-raised/40 px-4 py-3.5">
        <SectionLabel>How to read this</SectionLabel>
        <dl className="flex flex-col gap-2.5 text-[12.5px] leading-relaxed">
          <Note term="Measured">
            Every Fabric figure above, taken with <code className="font-mono">performance.now()</code> in the request
            that served this panel. {meta.nodeVersion} on {meta.platform}
            {wallMs !== null && <> · whole run {wallMs} ms</>}.
          </Note>
          <Note term="Reference">{baseline.disclaimer}</Note>
          <Note term="Covers">{baseline.covers}</Note>
          <Note term="Scope">{meta.measurementScope}</Note>
          <Note term="Multiplier">
            Reported as a range because the reference is a range, and shown both with and without a network hop.
          </Note>
        </dl>
      </div>
    </div>
  );
}

function Ratio({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: string;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">{label}</div>
      <div
        className={
          emphasis
            ? "mt-1 font-mono text-[26px] font-medium leading-none tracking-[-0.02em] text-accent-hi"
            : "mt-1 font-mono text-[26px] font-medium leading-none tracking-[-0.02em] text-ink-2"
        }
      >
        {value}
      </div>
      <div className="mt-1 text-[11.5px] text-ink-3">{hint}</div>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "accent" }) {
  return (
    <div className="min-w-[132px] flex-1 rounded-lg border border-line bg-raised px-3.5 py-3">
      <div className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">{label}</div>
      <div
        className={
          tone === "accent"
            ? "mt-1.5 font-mono text-[22px] font-medium leading-none text-accent-hi"
            : "mt-1.5 font-mono text-[22px] font-medium leading-none text-ink"
        }
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">
      {children}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.05em] text-ink-3 ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Note({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-24 shrink-0 font-medium text-ink-2">{term}</dt>
      <dd className="text-ink-3">{children}</dd>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

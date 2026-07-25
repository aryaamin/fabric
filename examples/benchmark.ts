import { runBenchmark, type BenchmarkReport, type Timing } from "@fabric/benchmark";
import type { Runtime } from "@fabric/runtime";
import type { AppDocument } from "@fabric/ir";
import { expenseTracker } from "./apps/expense-tracker.ts";
import { leaveRequests } from "./apps/leave-requests.ts";
import { accounting } from "./apps/accounting.ts";
import { revenueDashboard } from "./apps/revenue-dashboard.ts";
import { feedbackTriage } from "./apps/feedback-triage.ts";

/**
 * The differentiator, measured.
 *
 * All measurement lives in `@fabric/benchmark` so the studio can render exactly
 * these numbers in a UI panel. This file is only a pretty-printer, plus the seed
 * that gives the example apps realistic data before the render/edit loops.
 *
 * Read the honesty notes at the bottom of the output before quoting anything:
 * our figures are measured here; the comparison column is an explicitly
 * labelled typical range for codegen+build+deploy, not a competitor benchmark.
 */

const APPS = [expenseTracker, leaveRequests, accounting, revenueDashboard, feedbackTriage];

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const VIOLET = (s: string) => `\x1b[35m${s}\x1b[0m`;

const line = (s = "") => console.log(s);
const rule = (w = 78) => line(DIM("─".repeat(w)));

/** Give the example apps data, so renders measure real rows and real metrics. */
async function seed(rt: Runtime, apps: AppDocument[]): Promise<void> {
  const owner = { id: "u_bench", roles: ["owner"] };
  const has = (id: string) => apps.some((a) => a.id === id);
  if (has("expense-tracker")) {
    for (let i = 0; i < 12; i++) {
      await rt.invokeAction(
        "expense-tracker",
        "submitExpense",
        { amount: 40 + i * 17, description: `Expense ${i + 1}`, category: i % 2 ? "meals" : "travel" },
        owner,
      );
    }
  }
  if (has("leave-requests")) {
    for (let i = 0; i < 6; i++) {
      await rt.invokeAction(
        "leave-requests",
        "requestLeave",
        { days: 1 + (i % 4), reason: `Reason ${i + 1}`, startDate: "2026-08-01", endDate: "2026-08-04" },
        owner,
      );
    }
  }
  if (has("revenue-dashboard")) await rt.invokeAction("revenue-dashboard", "seedDemoData", {}, owner);
  if (has("feedback-triage")) {
    for (const msg of ["The export is broken", "I love the dashboard", "Could you add dark mode?"]) {
      await rt.invokeAction("feedback-triage", "submitFeedback", { message: msg }, owner);
    }
  }
}

function ms(n: number): string {
  return n < 1 ? `${n.toFixed(3)} ms` : n < 10 ? `${n.toFixed(2)} ms` : `${n.toFixed(1)} ms`;
}
function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visibleLength(s)));
}
function padL(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - visibleLength(s))) + s;
}
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function num(n: number): string {
  return n.toLocaleString("en-US");
}
function secs(msValue: number): string {
  return `${Math.round(msValue / 1000)} s`;
}

/** Wrap a paragraph to the report width, keeping a hanging indent. */
function wrap(text: string, indent: string, width = 78): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && (cur + " " + word).length + indent.length > width) {
      out.push(indent + cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(indent + cur);
  return out;
}

function timingRow(label: string, t: Timing, note: string): string {
  return `  ${pad(label, 26)}${padL(ms(t.p50), 11)}${padL(ms(t.p95), 11)}${padL(String(t.runs), 6)}   ${DIM(note)}`;
}

function print(r: BenchmarkReport) {
  line();
  line(B(VIOLET("▚ FABRIC BENCHMARK")) + DIM(`   node ${r.meta.nodeVersion} · ${r.meta.platform}`));
  line(DIM(`  ${r.meta.iterations.edit} edits · ${r.meta.iterations.install} installs · ${r.meta.iterations.render} renders · run in ${ms(r.meta.totalDurationMs)}`));
  line();

  line(B("MEASURED — Fabric, this machine, right now"));
  rule();
  line(`  ${pad("operation", 26)}${padL("p50", 11)}${padL("p95", 11)}${padL("runs", 6)}   ${DIM("what it covers")}`);
  line(timingRow("app install", r.measured.install, "validate + version + wire, fresh runtime"));
  line(timingRow("validate only", r.measured.validate, "the pure gate the studio runs while typing"));
  line(
    timingRow(
      GREEN("edit apply (headline)"),
      r.measured.editApply,
      "patch → validate → install → re-render",
    ),
  );
  line(timingRow("render a view", r.measured.render, "resolve one view against live data"));
  line(timingRow("fork an app", r.measured.fork, "new app rooted at an existing version"));
  line(timingRow("restore old version", r.measured.restore, "move head + reinstall + re-render"));
  rule();
  line();

  line(B("THE ARTIFACT — what a Fabric app actually is"));
  rule();
  line(
    `  ${pad("app", 22)}${padL("IR bytes", 10)}${padL("models", 8)}${padL("actions", 9)}${padL("views", 7)}${padL("nodes", 7)}${padL("code files", 12)}${padL("deps", 6)}`,
  );
  for (const a of r.apps) {
    line(
      `  ${pad(a.name, 22)}${padL(num(a.irBytes), 10)}${padL(String(a.models), 8)}${padL(String(a.actions), 9)}${padL(String(a.views), 7)}${padL(String(a.viewNodes), 7)}${padL(GREEN("0"), 12)}${padL(GREEN("0"), 6)}`,
    );
  }
  line(
    DIM(`  ${pad("── total", 22)}${padL(num(r.totals.irBytes) + " B", 10)}${padL("", 8)}${padL("", 9)}${padL("", 7)}${padL("", 7)}${padL("0", 12)}${padL("0", 6)}`),
  );
  line(
    DIM(`  ${r.totals.apps} apps in ${(r.totals.irBytes / 1024).toFixed(1)} KB of JSON — no source tree, no lockfile, no build output, no deploy step.`),
  );
  rule();
  line();

  line(B("COMPARISON — iteration speed"));
  rule();
  line(`  ${YELLOW("Reference range (NOT measured):")} ${r.baseline.label}`);
  line(DIM(`  covers: ${r.baseline.covers}`));
  line();
  const cmp = (label: string, ours: string, theirs: string) =>
    line(`  ${pad(label, 24)}${pad(GREEN(ours), 24)}${YELLOW(theirs)}`);
  line(`  ${pad("", 24)}${pad(B("Fabric (measured)"), 24)}${B("codegen+deploy (reference)")}`);
  cmp("edit → live", ms(r.measured.editApply.p50), `${secs(r.baseline.lowMs)} – ${secs(r.baseline.highMs)}`);
  cmp("fork an app", ms(r.measured.fork.p50), "copy repo + reinstall + redeploy");
  cmp("restore an old version", ms(r.measured.restore.p50), "revert commit + rebuild + redeploy");
  cmp("build artifacts", "none", "bundle + node_modules + deploy image");
  cmp("connect two apps", "one subscription in IR", "API + client + shared schema contract");
  rule();
  line(
    `  ${B("⇒")} ${B(GREEN(`~${num(r.speedup.lowX)}×–${num(r.speedup.highX)}× faster iteration`))} ` +
      DIM(`(our measured p50 of ${ms(r.speedup.ourP50Ms)} vs the labelled ${secs(r.baseline.lowMs)}–${secs(r.baseline.highMs)} range)`),
  );
  line();

  line(B("WHY THE STRUCTURAL WINS ARE HARD TO COPY"));
  rule();
  for (const w of r.structuralWins) {
    const cost = w.ourCostMs !== undefined ? ` ${DIM(`[${ms(w.ourCostMs)}]`)}` : "";
    line(`  ${CYAN("•")} ${B(w.title)}${cost}`);
    wrap(w.why, "    ").forEach((l) => line(l));
  }
  rule();
  line();

  line(B(YELLOW("HOW TO READ THIS")));
  line(`  ${GREEN("Measured:")}   every Fabric number above, via performance.now() in this process.`);
  line(`  ${YELLOW("Reference:")}`);
  wrap(r.baseline.disclaimer, "    ").forEach((l) => line(DIM(l)));
  line(`  ${CYAN("Scope:")}`);
  wrap(r.meta.measurementScope, "    ").forEach((l) => line(DIM(l)));
  line(`  ${DIM("Multiplier:")} reported as a range because the reference is a range, never as a single figure.`);
  line();
}

runBenchmark({ apps: APPS, editIterations: 120, seed })
  .then(print)
  .catch((e) => {
    console.error("\x1b[31mBENCHMARK FAILED:\x1b[0m", e);
    process.exit(1);
  });

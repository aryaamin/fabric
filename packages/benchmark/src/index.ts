import type { AppDocument, Patch } from "@fabric/ir";
import { applyPatch } from "@fabric/ir";
import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import { validateApp } from "@fabric/validator";
import type { Principal } from "@fabric/permissions";
import { defaultBenchmarkApps, SEED_ACTION_NAMES } from "./fixtures.ts";

export { defaultBenchmarkApps } from "./fixtures.ts";

/**
 * @fabric/benchmark — the measured case for interpretation over code generation.
 *
 * WHY this is a package and not a script: the same numbers must appear in the
 * terminal (`examples/benchmark.ts`) and in the studio's UI panel. So the
 * measurement is a library returning a typed {@link BenchmarkReport}, and every
 * presentation layer is just a formatter.
 *
 * WHAT IT MEASURES (all with `performance.now()`, in this process):
 *   install    — validate + version + wire an app into a fresh runtime
 *   editApply  — patch → validate → install(new version) → re-render a view
 *                (the loop a user feels when they say "add a notes field")
 *   render     — resolve one view against live data
 *   fork       — start a new app from an existing version
 *   restore    — point head at an old version, reinstall it, re-render
 *
 * HONESTY RULES (deliberate, and load-bearing for how this may be quoted):
 *   • Every number under `measured` is measured here, on this machine, now.
 *   • The comparison in `baseline` is NOT a measurement. It is an explicitly
 *     labelled, conservative *typical range* for a regenerate-code → install
 *     dependencies → build → deploy cycle. It names no product and cites no
 *     vendor's metrics, because we have not measured any.
 *   • `speedup` is therefore reported as a RANGE derived from our measured p50
 *     and that labelled range — never as a single authoritative multiple.
 */

/* ------------------------------------------------------------------ */
/* Report types (the studio's contract)                                */
/* ------------------------------------------------------------------ */

/** Latency distribution for one operation, in milliseconds. */
export interface Timing {
  runs: number;
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
}

/** Per-app facts about the artifact Fabric produces (and does not produce). */
export interface AppMetrics {
  id: string;
  name: string;
  /** size of the IR document as UTF-8 JSON. This is the whole application. */
  irBytes: number;
  models: number;
  actions: number;
  views: number;
  /** total UI nodes across all views. */
  viewNodes: number;
  /** always 0: Fabric emits no source files. */
  generatedCodeFiles: 0;
  /** always 0: apps declare capabilities, never packages. */
  installedDependencies: 0;
}

/**
 * A clearly-labelled reference range for the AI-codegen + redeploy model.
 * NOT a measurement, and intentionally not attributed to any product.
 */
export interface CodegenBaseline {
  label: string;
  lowMs: number;
  highMs: number;
  /** what the range covers, so it cannot be quoted out of context. */
  covers: string;
  /** why it is a range and where it came from. */
  disclaimer: string;
  measured: false;
}

/** A multiplier expressed as a range, because the baseline is a range. */
export interface SpeedupRange {
  operation: string;
  /** our measured p50, in ms. */
  ourP50Ms: number;
  lowX: number;
  highX: number;
}

/** A capability that is structurally cheap here and structurally hard there. */
export interface StructuralWin {
  title: string;
  /** measured cost in this run, when the win corresponds to a measurement. */
  ourCostMs?: number;
  why: string;
}

export interface BenchmarkReport {
  meta: {
    startedAt: string;
    finishedAt: string;
    totalDurationMs: number;
    nodeVersion: string;
    platform: string;
    iterations: { install: number; edit: number; render: number; fork: number; restore: number };
    /** The honest boundary of what our own numbers include. */
    measurementScope: string;
  };
  measured: {
    install: Timing;
    validate: Timing;
    editApply: Timing;
    render: Timing;
    fork: Timing;
    restore: Timing;
  };
  apps: AppMetrics[];
  totals: {
    apps: number;
    irBytes: number;
    generatedCodeFiles: 0;
    installedDependencies: 0;
    buildSteps: 0;
    deploySteps: 0;
  };
  baseline: CodegenBaseline;
  speedup: SpeedupRange;
  structuralWins: StructuralWin[];
}

export interface BenchmarkOptions {
  /** apps to measure. Defaults to {@link defaultBenchmarkApps}. */
  apps?: AppDocument[];
  /** edit-apply iterations. Must be >= 100 for a meaningful p95. */
  editIterations?: number;
  installIterations?: number;
  renderIterations?: number;
  forkIterations?: number;
  restoreIterations?: number;
  /** untimed warmup rounds, to take JIT out of the p50. */
  warmup?: number;
  /**
   * Put data in the app before the render/edit loops. Defaults to invoking any
   * action named in SEED_ACTION_NAMES as the app's owner.
   */
  seed?: (rt: Runtime, apps: AppDocument[]) => Promise<void>;
  /** override the labelled reference range (both ends, in seconds). */
  baselineSeconds?: { low: number; high: number };
}

/* ------------------------------------------------------------------ */
/* The benchmark                                                       */
/* ------------------------------------------------------------------ */

const WORKSPACE = "ws_benchmark";
const OWNER: Principal = { id: "u_bench", roles: ["owner"] };

export async function runBenchmark(opts: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const apps = opts.apps?.length ? opts.apps : defaultBenchmarkApps();
  const iterations = {
    install: opts.installIterations ?? 100,
    edit: opts.editIterations ?? 120,
    render: opts.renderIterations ?? 200,
    fork: opts.forkIterations ?? 100,
    restore: opts.restoreIterations ?? 100,
  };
  const warmup = opts.warmup ?? 10;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  /* -- install: a fresh runtime each time, so this is a first install ---- */
  const install = await measureAsync(iterations.install, warmup, async (i) => {
    const rt = newRuntime();
    const doc = apps[i % apps.length]!;
    return () => void rt.install(doc, { workspaceId: WORKSPACE, message: "benchmark install" });
  });

  /* -- validate: the pure gate the studio runs on every keystroke ------- */
  const validate = measure(iterations.install, warmup, (i) => {
    const doc = apps[i % apps.length]!;
    return () => void validateApp(doc);
  });

  /* -- a live runtime with every app installed and seeded ---------------- */
  const rt = newRuntime();
  for (const doc of apps) rt.install(doc, { workspaceId: WORKSPACE, message: "created" });
  await (opts.seed ?? defaultSeed)(rt, apps);

  const target = apps[0]!;
  const targetView = target.views[0]?.name;
  if (!targetView) throw new Error(`benchmark app "${target.id}" declares no views`);

  /* -- render: resolve one view against live data ------------------------ */
  const render = await measureAsync(iterations.render, warmup, async () => {
    return () => rt.renderView(target.id, targetView, OWNER);
  });

  /* -- editApply: THE headline number ------------------------------------
   * patch → validate → install(new version) → re-render. Every iteration is
   * a genuinely different document (the patch value carries the iteration
   * number), so nothing is deduplicated by the content-addressed version
   * store and every round does the full amount of work.
   */
  let doc = target;
  const editApply = await measureAsync(iterations.edit, warmup, async (i) => {
    const patch: Patch = { op: "set", path: "description", value: `benchmark edit #${i}` };
    return async () => {
      doc = applyPatch(doc, patch);
      const result = validateApp(doc);
      if (!result.ok) throw new Error(`benchmark edit produced an invalid document at #${i}`);
      rt.install(doc, { workspaceId: WORKSPACE, author: "ai", message: `edit #${i}` });
      await rt.renderView(target.id, targetView, OWNER);
    };
  });

  /* -- fork: a new app rooted at an existing version --------------------- */
  const head = rt.versions.head(target.id)!;
  let forkSeq = 0;
  const fork = measure(iterations.fork, warmup, () => {
    const newId = `${target.id}-fork-${++forkSeq}`;
    return () => void rt.versions.fork(head.id, newId);
  });

  /* -- restore: time travel, then run the old document ------------------ */
  const history = rt.versions.history(target.id);
  const older = history[Math.min(history.length - 1, 5)] ?? head;
  const restore = await measureAsync(iterations.restore, warmup, async () => {
    return async () => {
      const v = rt.versions.restore(target.id, older.id);
      rt.install(v.doc, { workspaceId: WORKSPACE, author: "user", message: "restore" });
      await rt.renderView(target.id, targetView, OWNER);
    };
  });

  const metrics = apps.map(appMetrics);
  const baseline = makeBaseline(opts.baselineSeconds);
  const finish = performance.now();

  return {
    meta: {
      startedAt,
      finishedAt: new Date().toISOString(),
      totalDurationMs: round(finish - t0),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      iterations,
      measurementScope:
        "In-process, warm, with the reference in-memory storage adapter. These are platform costs only: " +
        "a hosted edit additionally pays one network round trip, and a production database adapter adds " +
        "query latency to the render figure. Neither changes the order of magnitude of the comparison, " +
        "because the codegen cycle being compared against pays those same costs plus a build and a deploy.",
    },
    measured: { install, validate, editApply, render, fork, restore },
    apps: metrics,
    totals: {
      apps: metrics.length,
      irBytes: metrics.reduce((s, m) => s + m.irBytes, 0),
      generatedCodeFiles: 0,
      installedDependencies: 0,
      buildSteps: 0,
      deploySteps: 0,
    },
    baseline,
    speedup: {
      operation: "edit apply (patch → validate → install → re-render)",
      ourP50Ms: editApply.p50,
      lowX: Math.round(baseline.lowMs / Math.max(editApply.p50, 0.001)),
      highX: Math.round(baseline.highMs / Math.max(editApply.p50, 0.001)),
    },
    structuralWins: structuralWins({ fork, restore, editApply }),
  };
}

/* ------------------------------------------------------------------ */
/* The labelled reference range and the structural argument            */
/* ------------------------------------------------------------------ */

function makeBaseline(seconds?: { low: number; high: number }): CodegenBaseline {
  const low = (seconds?.low ?? 30) * 1000;
  const high = (seconds?.high ?? 120) * 1000;
  return {
    label: `typical AI-codegen platform rebuild+redeploy: ~${low / 1000}–${high / 1000} s`,
    lowMs: low,
    highMs: high,
    covers:
      "regenerate source files → install dependencies → type-check/bundle → upload and activate a deployment",
    disclaimer:
      "REFERENCE RANGE, NOT A MEASUREMENT. A conservative typical window for a code-generation platform's " +
      "edit→live cycle, based on the fact that the cycle contains a dependency install, a bundler run and a " +
      "deployment activation. It is not a benchmark of any named product and no vendor's published figures " +
      "are used or implied. Measure your own toolchain to compare precisely.",
    measured: false,
  };
}

function structuralWins(t: { fork: Timing; restore: Timing; editApply: Timing }): StructuralWin[] {
  return [
    {
      title: "Instant fork",
      ourCostMs: t.fork.p50,
      why: "A fork is a pointer to an immutable JSON version, so there is no repository to copy, no dependency tree to reinstall and no second environment to provision.",
    },
    {
      title: "Instant time travel",
      ourCostMs: t.restore.p50,
      why: "Restoring is moving head to an older document; a codegen platform must recover the matching source tree AND redeploy a matching build to get the same state back.",
    },
    {
      title: "No build artifacts",
      ourCostMs: t.editApply.p50,
      why: "The document IS the program, so an edit skips the entire generate→install→bundle→deploy pipeline that stands between a code change and a running app.",
    },
    {
      title: "Cross-app connect without APIs",
      why: "Apps publish declared events into one workspace bus, so connecting two apps is a subscription in a document rather than an endpoint, a client, a schema contract and a shared secret in two codebases.",
    },
    {
      title: "One document, many renderers",
      why: "Views are an abstract node tree, so the same app renders server-side HTML, React in the studio and an embed without a second implementation to generate and keep in sync.",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Measurement helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Time a synchronous operation. `prepare(i)` does the untimed setup and returns
 * the closure to be timed, which keeps allocation of inputs out of the numbers.
 */
export function measure(runs: number, warmup: number, prepare: (i: number) => () => void): Timing {
  // Warmup uses indices ABOVE the measured range so a prepare() that derives a
  // unique value from `i` never collides with a measured iteration.
  for (let i = 0; i < warmup; i++) prepare(runs + i)();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const run = prepare(i);
    const a = performance.now();
    run();
    samples.push(performance.now() - a);
  }
  return summarize(samples);
}

/** Async twin of {@link measure}. */
export async function measureAsync(
  runs: number,
  warmup: number,
  prepare: (i: number) => Promise<() => unknown>,
): Promise<Timing> {
  for (let i = 0; i < warmup; i++) await (await prepare(runs + i))();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const run = await prepare(i);
    const a = performance.now();
    await run();
    samples.push(performance.now() - a);
  }
  return summarize(samples);
}

export function summarize(samples: number[]): Timing {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.max(0, Math.ceil(q * s.length) - 1)] ?? 0;
  return {
    runs: s.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(s.reduce((x, y) => x + y, 0) / (s.length || 1)),
    min: round(s[0] ?? 0),
    max: round(s[s.length - 1] ?? 0),
  };
}

/** Size of the IR document as UTF-8 JSON — the entire deployable artifact. */
export function irBytes(doc: AppDocument): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

function appMetrics(doc: AppDocument): AppMetrics {
  return {
    id: doc.id,
    name: doc.name,
    irBytes: irBytes(doc),
    models: doc.models.length,
    actions: doc.actions.length,
    views: doc.views.length,
    viewNodes: doc.views.reduce((n, v) => n + countNodes(v.root), 0),
    generatedCodeFiles: 0,
    installedDependencies: 0,
  };
}

function countNodes(node: { children?: unknown[] }): number {
  const kids = (node.children ?? []) as { children?: unknown[] }[];
  return 1 + kids.reduce((n, c) => n + countNodes(c), 0);
}

function newRuntime(): Runtime {
  const rt = new Runtime();
  rt.registry.register(storageCapabilityFactory());
  rt.registry.register(notificationsCapabilityFactory());
  rt.registry.register(aiCapabilityFactory());
  return rt;
}

const defaultSeed = async (rt: Runtime, apps: AppDocument[]): Promise<void> => {
  for (const doc of apps) {
    for (const name of SEED_ACTION_NAMES) {
      if (doc.actions.some((a) => a.name === name)) {
        await rt.invokeAction(doc.id, name, {}, OWNER);
      }
    }
  }
};

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

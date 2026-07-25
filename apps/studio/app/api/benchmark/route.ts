import { runBenchmark, type BenchmarkReport } from "@fabric/benchmark";

/**
 * The benchmark endpoint — the same measurement the terminal report runs.
 *
 * WHY re-measure in the browser's request rather than ship a recorded JSON:
 * a number you can re-run in front of someone is an argument; a number in a
 * slide is a claim. The panel runs this live on the machine serving the demo.
 *
 * It is deliberately a smaller iteration count than the CLI report: this runs
 * inside a request, and the p50 is stable well before 120 edits. The CLI remains
 * the authoritative run.
 *
 * Honesty is enforced by the library, not here: `report.baseline` is explicitly
 * labelled as a reference range for the codegen+build+deploy cycle, names no
 * product, and `report.speedup` is a range derived from it.
 */
export async function GET() {
  const started = performance.now();
  const report: BenchmarkReport = await runBenchmark({
    editIterations: 100,
    installIterations: 60,
    renderIterations: 120,
    forkIterations: 60,
    restoreIterations: 60,
    warmup: 8,
  });
  return Response.json(
    { ok: true, report, wallMs: Math.round(performance.now() - started) },
    // Never cached: the point is that it was measured just now.
    { headers: { "cache-control": "no-store" } },
  );
}

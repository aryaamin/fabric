import Link from "next/link";
import { BenchmarkPanel } from "../../components/BenchmarkPanel";
import { Card, CardHeader } from "../../components/ui/Card";

/**
 * "Why it's faster" — the positioning page, with the numbers attached.
 *
 * The structure is deliberate: the architectural difference first (because the
 * speed is a consequence of it, not a tuning achievement), then the live
 * benchmark, then the things that are not about speed at all and are the more
 * durable argument. A competitor can make their build faster. They cannot make
 * an application stop being a codebase.
 */
export default function WhyPage() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-base/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[980px] items-center gap-3 px-6">
          <Link href="/" className="flex items-center gap-2.5 text-ink-3 transition-colors hover:text-ink">
            <span className="text-[15px] leading-none text-accent">▚</span>
            <span className="text-[13.5px]">Fabric</span>
          </Link>
          <span className="text-ink-3">/</span>
          <span className="text-[13.5px] text-ink-2">Why it&apos;s faster</span>
        </div>
      </header>

      <main className="mx-auto max-w-[980px] px-6 py-10">
        <h1 className="max-w-[30ch] text-[30px] font-semibold leading-[1.15] tracking-[-0.03em]">
          Everyone else generates a codebase. We generate a document.
        </h1>
        <p className="mt-4 max-w-[70ch] text-[14px] leading-relaxed text-ink-2">
          It is the same difference as between compiling a program and editing a spreadsheet. An AI app builder that
          emits source code inherits the whole pipeline that source code requires — install, type-check, bundle,
          upload, activate — and pays it again on every single edit. Fabric&apos;s output is an IR document that an
          interpreter runs directly, so an edit is a validated patch and the app is already live.
        </p>

        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <Pipeline
            title="Code generation"
            steps={["prompt", "generate source files", "install dependencies", "type-check + bundle", "upload + activate", "URL"]}
            tone="muted"
          />
          <Pipeline
            title="Fabric"
            steps={["prompt", "IR patch", "validate", "already live"]}
            tone="accent"
          />
        </div>

        <div className="mt-10">
          <BenchmarkPanel />
        </div>

        <div className="mt-10">
          <Card>
            <CardHeader
              title="The part that isn't about speed"
              subtitle="Capabilities you cannot bolt onto a generated codebase."
            />
            <div className="grid gap-px bg-line-soft sm:grid-cols-2">
              <Point
                title="Scrubbable history"
                body="A version is an immutable document, so rendering any past version costs a fraction of a millisecond. That is why we can offer a slider instead of a list of commits."
              />
              <Point
                title="Forking as a copy"
                body="A fork copies a JSON value. There is no repository to clone, no dependency tree to reinstall and no second environment to provision."
              />
              <Point
                title="Composition without APIs"
                body="Apps declare events; another app subscribes in its own document. No endpoint, no client library, no shared schema package, no credential to rotate."
              />
              <Point
                title="Semantic diffs"
                body="An AI edit is a handful of typed patches, so the change can be read as a sentence and rejected by a validator before anyone sees it. A regenerated codebase can only be reviewed as a diff."
              />
              <Point
                title="Permissions in the runtime"
                body="Roles, action rules and row-level policies are enforced by the platform for every app, so no generated auth code can get them subtly wrong."
              />
              <Point
                title="One document, many renderers"
                body="The same view tree renders as React in the studio, as HTML from the preview server, and chromeless in an embed — without a second implementation to keep in sync."
              />
            </div>
          </Card>
        </div>

        <div className="mt-8 rounded-lg border border-line bg-panel px-5 py-4">
          <h2 className="text-[13.5px] font-medium">Where this trade-off costs us</h2>
          <p className="mt-1.5 max-w-[74ch] text-[12.5px] leading-relaxed text-ink-3">
            An interpreter is slower per operation than compiled code, and the IR can only express what the node and
            expression vocabulary covers — an app needing an arbitrary npm library or a bespoke rendering engine
            belongs in a codegen tool, not here. Fabric is built for Small Software: internal tools, dashboards,
            approvals, trackers, assistants. Within that range the architecture wins outright; outside it, we would
            rather say so than pretend.
          </p>
        </div>
      </main>
    </div>
  );
}

function Pipeline({ title, steps, tone }: { title: string; steps: string[]; tone: "muted" | "accent" }) {
  return (
    <div
      className={
        tone === "accent"
          ? "rounded-lg border border-accent/30 bg-accent-dim/40 p-4"
          : "rounded-lg border border-line bg-panel p-4"
      }
    >
      <div className="text-[13px] font-medium text-ink">{title}</div>
      <ol className="mt-3 flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2.5">
            <span
              className={
                tone === "accent"
                  ? "flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[10px] text-white"
                  : "flex size-[18px] shrink-0 items-center justify-center rounded-full border border-line bg-raised font-mono text-[10px] text-ink-3"
              }
            >
              {i + 1}
            </span>
            <span className={tone === "accent" ? "text-[12.5px] text-ink" : "text-[12.5px] text-ink-2"}>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-panel px-4 py-3.5">
      <div className="text-[13px] font-medium text-ink">{title}</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{body}</p>
    </div>
  );
}

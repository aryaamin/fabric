import Link from "next/link";
import { redirect } from "next/navigation";
import { currentIdentity } from "../lib/auth";
import { ensureRuntime, getRuntime, irBytes } from "../lib/runtime";
import { listWorkspaceObjects, personFor } from "../lib/workspace";
import { ConnectionGraph, type GraphApp } from "../components/ConnectionGraph";
import { NewAppButton } from "../components/NewAppButton";
import { Badge } from "../components/ui/Badge";
import { Card, CardHeader } from "../components/ui/Card";

/**
 * The workspace contents are live runtime state (apps get created, edited and
 * forked between requests), so this page must never be prerendered at build time.
 */
export const dynamic = "force-dynamic";

/**
 * The workspace home — applications sitting where documents sit.
 *
 * A Server Component: it reads the workspace and the runtime on the server and
 * streams HTML, so the first paint is the real thing rather than a spinner. The
 * only client islands are the "New app" composer and the connection graph.
 */
export default async function WorkspacePage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/sign-in");
  await ensureRuntime(identity.workspaceId, identity.id);
  const rt = getRuntime(identity.workspaceId);
  const objects = await listWorkspaceObjects(identity.workspaceId, identity.id);

  const rows = objects.map((obj) => {
    const doc = rt.installed(obj.appId ?? obj.slug);
    const versions = doc ? rt.versions.history(doc.id).length : 0;
    return { obj, doc, versions, bytes: doc ? irBytes(doc) : 0 };
  });

  const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);

  const graphApps: GraphApp[] = rows
    .filter((r) => r.doc)
    .map((r) => ({
      id: r.doc!.id,
      name: r.doc!.name,
      icon: r.obj.icon ?? "✳",
      events: r.doc!.events.map((e) => e.name),
      // `on` is "<appId>.<event>" for a cross-app wire, or "<event>" locally.
      subscriptions: r.doc!.subscriptions.flatMap((s) => {
        const dot = s.on.lastIndexOf(".");
        if (dot < 0) return [];
        return [{ from: s.on.slice(0, dot), event: s.on.slice(dot + 1), action: s.run }];
      }),
    }));

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-base/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-4 px-6">
          <div className="flex items-center gap-2.5">
            <span className="text-[15px] leading-none text-accent">▚</span>
            <span className="text-[14px] font-semibold tracking-[-0.015em]">Fabric</span>
            <span className="text-ink-3">/</span>
            <span className="text-[13.5px] text-ink-2">Acme Inc</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/why"
              className="rounded-md px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
            >
              Why it&apos;s faster
            </Link>
            <NewAppButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-6 py-9">
        <section className="grid-bg animate-rise rounded-xl border border-line bg-panel px-7 py-7">
          <h1 className="max-w-[34ch] text-[26px] font-semibold leading-[1.2] tracking-[-0.025em]">
            Applications, as ordinary as documents.
          </h1>
          <p className="mt-2.5 max-w-[62ch] text-[13.5px] leading-relaxed text-ink-2">
            Every app here is a JSON document run by an interpreter. Editing one is a validated patch, not a
            regenerated codebase — so an edit lands in under a millisecond, a fork is a copy, and version history
            is scrubbable.
          </p>
          <dl className="mt-6 flex flex-wrap gap-x-9 gap-y-4">
            <Metric label="Apps" value={String(rows.length)} />
            <Metric label="Total IR" value={`${(totalBytes / 1024).toFixed(1)} KB`} />
            <Metric label="Dependencies" value="0" hint="per app" />
            <Metric label="Build steps" value="0" hint="ever" />
          </dl>
        </section>

        <div className="mb-3.5 mt-9 flex items-baseline justify-between">
          <h2 className="text-[14px] font-medium text-ink-2">Workspace</h2>
          <span className="font-mono text-[12px] text-ink-3">{rows.length} objects</span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ obj, doc, versions, bytes }, i) => {
            // The owner is a grant like any other; collaborators are everyone else.
            const collaborators = obj.grants.filter((g) => g.role !== "owner").map((g) => g.principalId);
            return (
              <Link
                key={obj.id}
                href={`/w/${obj.slug}`}
                className="animate-rise group flex flex-col rounded-lg border border-line bg-panel p-4 transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-accent/40 hover:bg-raised"
                style={{ animationDelay: `${i * 35}ms` }}
              >
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-[17px] leading-none">
                    {obj.icon ?? "✳"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium tracking-[-0.01em] text-ink">{obj.name}</div>
                    <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
                      {doc?.description ?? "An application."}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-1.5">
                  {obj.public ? (
                    <Badge tone="accent">Published</Badge>
                  ) : obj.linkRole ? (
                    <Badge tone="neutral">Link · {obj.linkRole}</Badge>
                  ) : (
                    <Badge tone="neutral">Restricted</Badge>
                  )}
                  <span className="ml-auto flex -space-x-1.5">
                    {collaborators.slice(0, 3).map((id) => {
                      const p = personFor(id);
                      return (
                        <span
                          key={id}
                          title={p.name}
                          className="flex size-[22px] items-center justify-center rounded-full border border-panel text-[9.5px] font-semibold text-ink"
                          style={{ background: `hsl(${p.hue} 45% 34%)` }}
                        >
                          {p.initials}
                        </span>
                      );
                    })}
                    {collaborators.length > 3 && (
                      <span className="flex size-[22px] items-center justify-center rounded-full border border-panel bg-raised font-mono text-[9.5px] text-ink-3">
                        +{collaborators.length - 3}
                      </span>
                    )}
                  </span>
                </div>

                <div className="mt-3.5 flex items-center justify-between border-t border-line-soft pt-3 font-mono text-[11.5px] text-ink-3">
                  <span>{relative(obj.updatedAt)}</span>
                  <span>
                    {(bytes / 1024).toFixed(1)} KB · v{versions}
                  </span>
                </div>
              </Link>
            );
          })}

          <button
            type="button"
            disabled
            className="flex min-h-[168px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line bg-transparent px-4 text-center"
          >
            <span className="text-[13px] text-ink-3">Describe an app in a sentence</span>
            <span className="text-[12px] text-ink-3/70">Use “New app” above — you get a URL immediately.</span>
          </button>
        </div>

        <div className="mt-10">
          <ConnectionGraph apps={graphApps} />
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">{label}</dt>
      <dd className="mt-1 font-mono text-[20px] font-medium leading-none tracking-[-0.02em] text-ink">
        {value}
        {hint && <span className="ml-1.5 font-sans text-[11.5px] font-normal text-ink-3">{hint}</span>}
      </dd>
    </div>
  );
}

/** "3 minutes ago" — computed on the server, so it never hydrates differently. */
function relative(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

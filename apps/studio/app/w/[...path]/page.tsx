import Link from "next/link";
import { EXAMPLE_PROMPTS } from "@fabric/orchestrator";
import { ensureRuntime, getRuntime, primaryView } from "../../../lib/runtime";
import { allObjects, resolveVisit, visitorQuery } from "../../../lib/workspace";
import { choosePlanner } from "../../../lib/planner";
import { AppEditor, type RailItem } from "../../../components/AppEditor";

/**
 * The app surface router: ONE URL, THREE surfaces.
 *
 * The object's access decides the UI, using the same `surfaceForAccess` the
 * preview server uses, so there is one source of truth for "who sees what":
 *   editor/owner → the full studio (canvas + AI chat + history + share)
 *   viewer       → the running app only
 *   no access    → a lock screen
 *
 * A catch-all segment because a share link is canonically `/w/<workspace>/<app>`
 * (that is what `appUrl` in @fabric/workspace mints, and what the preview server
 * serves) while `/w/<app>` is the convenient internal form. Both must land on the
 * same surface, so the slug is simply the last segment.
 *
 * The canvas is rendered HERE, on the server, and handed to the client as the
 * initial tree. That matters beyond politeness: a shared app link should paint
 * the running application on first byte, exactly as a shared document does.
 *
 * Real auth is out of scope, so the visitor is simulated from the query string:
 *   ?u=<id>  a signed-in person   ?k=<token>  the share-link token
 */
export default async function AppPage({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path } = await params;
  const slug = path[path.length - 1] ?? "";
  const sp = await searchParams;
  await ensureRuntime();

  const visit = resolveVisit(slug, visitorQuery(sp));

  if (!visit.object) return <Lock title="404" body={`No app named “${slug}”.`} />;
  if (visit.surface === "denied") {
    return <Lock title="No access" body="Ask the owner to share this app with you, or to send you a link." icon="🔒" />;
  }

  const rt = getRuntime();
  const doc = rt.installed(visit.object.appId ?? slug);
  if (!doc) return <Lock title="Not installed" body={`“${slug}” is not installed in this runtime.`} />;

  const viewName = primaryView(doc);
  if (!viewName) return <Lock title="No views" body="This app declares no views yet." />;

  // The initial paint: the real application, resolved against real data, as this
  // specific visitor is allowed to see it.
  const initialView = await rt.renderView(doc.id, viewName, visit.principal);

  const rail: RailItem[] = allObjects().map((o) => ({ slug: o.slug, name: o.name, icon: o.icon ?? "✳" }));

  return (
    <AppEditor
      slug={slug}
      name={visit.object.name}
      icon={visit.object.icon ?? "✳"}
      viewName={viewName}
      initialView={initialView}
      readOnly={visit.surface === "run"}
      rail={rail}
      plannerLabel={choosePlanner().label}
      examples={[...EXAMPLE_PROMPTS].slice(0, 5)}
    />
  );
}

function Lock({ title, body, icon }: { title: string; body: string; icon?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="animate-rise max-w-[46ch] text-center">
        {icon && <div className="mb-3 text-[28px]">{icon}</div>}
        <h1 className="text-[19px] font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">{body}</p>
        <Link
          href="/"
          className="mt-5 inline-flex h-8.5 items-center rounded-md border border-line px-3 text-[13px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          Back to the workspace
        </Link>
      </div>
    </main>
  );
}

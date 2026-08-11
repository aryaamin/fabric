import { ensureRuntime, getRuntime, primaryView, WORKSPACE_ID } from "../../../lib/runtime";
import { resolveWorkspaceVisit, visitorQuery } from "../../../lib/workspace";
import { EmbedApp } from "../../../components/EmbedApp";
import { currentIdentity } from "../../../lib/auth";

/**
 * The embed surface — `/embed/<workspace>/<app>?k=<token>`, the URL that
 * `embedSnippet` mints.
 *
 * `surfaceForAccess({ embed: true })` always returns the running app, even for
 * the owner: an iframe is a *placement* of an application, never an editor. So
 * the access check here is only "may this visitor open it at all", and the
 * answer comes from the same resolver the studio and preview server use.
 */
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { path } = await params;
  const slug = path[path.length - 1] ?? "";
  const sp = await searchParams;
  const identity = await currentIdentity();
  const workspaceId = path.length > 1 ? path[path.length - 2]! : identity?.workspaceId ?? WORKSPACE_ID;
  await ensureRuntime(workspaceId, identity?.id);

  const q = visitorQuery(sp, identity?.id, workspaceId);
  const visit = await resolveWorkspaceVisit(
    workspaceId,
    identity?.id ?? "u_owner",
    slug,
    q,
    { embed: true },
  );

  if (!visit.object || visit.surface === "denied") {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-center">
        <p className="text-[13px] text-ink-3">
          This app isn&apos;t shared for embedding.
        </p>
      </main>
    );
  }

  const rt = getRuntime(workspaceId);
  const doc = rt.installed(visit.object.appId ?? slug);
  const viewName = doc ? primaryView(doc) : undefined;
  if (!doc || !viewName) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-center">
        <p className="text-[13px] text-ink-3">Nothing to render.</p>
      </main>
    );
  }

  const initialView = await rt.renderView(doc.id, viewName, visit.principal);

  return (
    <EmbedApp
      slug={slug}
      workspaceId={workspaceId}
      viewName={viewName}
      initialView={initialView}
      {...(q.k ? { token: q.k } : {})}
      // Not read-only: an embedded app stays interactive, and whether this
      // visitor may run a given action is the runtime's decision per action,
      // not a blanket property of the surface.
    />
  );
}

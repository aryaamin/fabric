import { diff } from "@fabric/versioning";
import { ensureRuntime, getRuntime, irBytes, primaryView, WORKSPACE_ID } from "../../../lib/runtime";
import { resolveVisit, visitorFromUrl, registerObject, objectBySlug } from "../../../lib/workspace";
import { summarizeChanges } from "../../../lib/patch-summary";

/**
 * Version history, time travel, restore and fork.
 *
 * The interesting consequence of content-addressed versions is that restoring
 * cannot be modelled as "commit the old document again": re-committing identical
 * content resolves to the version that already holds it, so head simply moves
 * back. That is the honest behaviour, but it means a history that walks head →
 * root would hide every version newer than the restored one. The timeline
 * therefore lists the whole set of versions for the app and marks which one is
 * head, so restoring moves a pointer instead of destroying the future.
 *
 * `preview` is the scrubber's endpoint. It renders an old document through
 * `Runtime.previewView`, which commits nothing, so dragging across the timeline
 * is free and leaves head exactly where the user left it.
 */

export interface VersionEntry {
  id: string;
  parent?: string;
  author: string;
  message: string;
  createdAt: string;
  /** one-line human summary of what changed against the parent version. */
  summary: string;
  changes: number;
  irBytes: number;
  isHead: boolean;
}

export async function GET(req: Request) {
  await ensureRuntime();
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug") ?? "";

  const visit = resolveVisit(slug, visitorFromUrl(req.url));
  if (visit.surface === "denied") {
    return Response.json({ ok: false, error: "no access to this app" }, { status: 403 });
  }

  const rt = getRuntime();
  const head = rt.versions.head(slug);
  // Oldest first: a timeline reads better forwards, and the scrubber's index
  // then maps directly onto "how far back in time am I".
  const history = rt.versions
    .all(slug)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const entries: VersionEntry[] = history.map((v) => {
    const parent = v.parent ? rt.versions.get(v.parent) : undefined;
    const changes = parent ? diff(parent.doc, v.doc) : [];
    return {
      id: v.id,
      ...(v.parent ? { parent: v.parent } : {}),
      author: v.author,
      message: v.message,
      createdAt: v.createdAt,
      summary: parent ? summarizeChanges(changes) : "created",
      changes: changes.length,
      irBytes: irBytes(v.doc),
      isHead: v.id === head?.id,
    };
  });

  return Response.json({ ok: true, versions: entries });
}

export async function POST(req: Request) {
  await ensureRuntime();
  const body = (await req.json()) as {
    slug: string;
    op: "preview" | "restore" | "fork";
    versionId?: string;
    name?: string;
  };

  const visit = resolveVisit(body.slug, visitorFromUrl(req.url));
  if (visit.surface === "denied") {
    return Response.json({ ok: false, error: "no access to this app" }, { status: 403 });
  }
  // Preview and fork are reads (fork creates a *new* object, it does not touch
  // this one); restore mutates the app, so it needs edit authority.
  if (body.op === "restore" && visit.surface !== "studio") {
    return Response.json({ ok: false, error: "view-only access cannot restore" }, { status: 403 });
  }

  const rt = getRuntime();
  const version = body.versionId ? rt.versions.get(body.versionId) : rt.versions.head(body.slug);
  if (!version) return Response.json({ ok: false, error: "unknown version" }, { status: 404 });

  const started = performance.now();

  try {
    if (body.op === "preview") {
      const viewName = primaryView(version.doc);
      if (!viewName) return Response.json({ ok: false, error: "version declares no views" }, { status: 400 });
      const view = await rt.previewView(body.slug, version.doc, viewName, visit.principal);
      return Response.json({ ok: true, view, ms: round(performance.now() - started) });
    }

    if (body.op === "restore") {
      rt.install(version.doc, {
        workspaceId: WORKSPACE_ID,
        author: visit.principal.id,
        message: `restored version ${version.id.slice(0, 8)}`,
      });
      const viewName = primaryView(version.doc)!;
      const view = await rt.renderView(body.slug, viewName, visit.principal);
      return Response.json({ ok: true, view, ms: round(performance.now() - started) });
    }

    // fork: a new app rooted at this version. A fork is a copy of a JSON
    // document — there is no repository to clone and no environment to create,
    // which is why it can be offered as a single click.
    const object = objectBySlug(body.slug);
    const baseName = body.name ?? `${object?.name ?? body.slug} (copy)`;
    const newId = uniqueAppId(body.slug, (id) => rt.installed(id) !== undefined);
    const forked = rt.versions.fork(version.id, newId, visit.principal.id);
    rt.install(forked.doc, {
      workspaceId: WORKSPACE_ID,
      author: visit.principal.id,
      message: `forked from ${body.slug}`,
    });
    const obj = registerObject(newId, baseName, object?.icon ?? "✳");

    return Response.json({
      ok: true,
      slug: obj.slug,
      name: obj.name,
      ms: round(performance.now() - started),
    });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
}

function uniqueAppId(base: string, taken: (id: string) => boolean): string {
  let n = 2;
  let id = `${base}-copy`;
  while (taken(id)) id = `${base}-copy-${n++}`;
  return id;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

import { diff } from "@fabric/versioning";
import {
  ensureRuntime,
  durableVersionRepository,
  getRuntime,
  irBytes,
  primaryView,
  STUDIO_INSTANCE_ID,
  WORKSPACE_ID,
} from "../../../lib/runtime";
import {
  resolveWorkspaceVisit,
  visitorFromUrl,
  createWorkspaceObject,
  findWorkspaceObject,
} from "../../../lib/workspace";
import { currentIdentity, unauthorized } from "../../../lib/auth";
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
  const identity = await currentIdentity();
  const url = new URL(req.url);
  const workspaceId = identity?.workspaceId ?? url.searchParams.get("w") ?? WORKSPACE_ID;
  await ensureRuntime(workspaceId, identity?.id);
  const slug = url.searchParams.get("slug") ?? "";

  const visit = await resolveWorkspaceVisit(
    workspaceId,
    identity?.id ?? "u_owner",
    slug,
    visitorFromUrl(req.url, identity?.id, workspaceId),
  );
  if (visit.surface === "denied") {
    return Response.json({ ok: false, error: "no access to this app" }, { status: 403 });
  }
  const appId = visit.object?.appId ?? slug;

  const rt = getRuntime(workspaceId);
  const repository = durableVersionRepository();
  const head = repository
    ? await repository.head(workspaceId, appId)
    : rt.versions.head(appId) ?? null;
  // Oldest first: a timeline reads better forwards, and the scrubber's index
  // then maps directly onto "how far back in time am I".
  const history = (
    repository ? await repository.all(workspaceId, appId) : rt.versions.all(appId)
  )
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byId = new Map(history.map((version) => [version.id, version]));

  const entries: VersionEntry[] = history.map((v) => {
    const parent = v.parent ? byId.get(v.parent) : undefined;
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
  const identity = await currentIdentity();
  const workspaceId =
    identity?.workspaceId ?? new URL(req.url).searchParams.get("w") ?? WORKSPACE_ID;
  await ensureRuntime(workspaceId, identity?.id);
  const body = (await req.json()) as {
    slug: string;
    op: "preview" | "compare" | "restore" | "fork";
    versionId?: string;
    name?: string;
  };

  const visit = await resolveWorkspaceVisit(
    workspaceId,
    identity?.id ?? "u_owner",
    body.slug,
    visitorFromUrl(req.url, identity?.id, workspaceId),
  );
  if (visit.surface === "denied") {
    return Response.json({ ok: false, error: "no access to this app" }, { status: 403 });
  }
  // Preview and fork are reads (fork creates a *new* object, it does not touch
  // this one); restore mutates the app, so it needs edit authority.
  if (body.op === "restore" && visit.surface !== "studio") {
    return Response.json({ ok: false, error: "view-only access cannot restore" }, { status: 403 });
  }

  if (body.op === "fork" && !identity) return unauthorized();
  const appId = visit.object?.appId ?? body.slug;
  const rt = getRuntime(workspaceId);
  const repository = durableVersionRepository();
  const version = repository
    ? body.versionId
      ? await repository.get(workspaceId, body.versionId)
      : await repository.head(workspaceId, appId)
    : body.versionId
      ? rt.versions.get(body.versionId)
      : rt.versions.head(appId);
  if (!version) return Response.json({ ok: false, error: "unknown version" }, { status: 404 });

  const started = performance.now();

  try {
    if (body.op === "compare") {
      const live = repository
        ? await repository.head(workspaceId, appId)
        : rt.versions.head(appId);
      if (!live) {
        return Response.json({ ok: false, error: "live version not found" }, { status: 404 });
      }
      return Response.json({
        ok: true,
        from: version.id,
        to: live.id,
        changes: diff(version.doc, live.doc),
      });
    }

    if (body.op === "preview") {
      const viewName = primaryView(version.doc);
      if (!viewName) return Response.json({ ok: false, error: "version declares no views" }, { status: 400 });
      const view = await rt.previewView(appId, version.doc, viewName, visit.principal);
      return Response.json({ ok: true, view, ms: round(performance.now() - started) });
    }

    if (body.op === "restore") {
      await repository?.restore(workspaceId, appId, version.id);
      rt.install(version.doc, {
        workspaceId,
        instanceId: STUDIO_INSTANCE_ID,
        author: visit.principal.id,
        message: `restored version ${version.id.slice(0, 8)}`,
      });
      const viewName = primaryView(version.doc)!;
      const view = await rt.renderView(appId, viewName, visit.principal);
      return Response.json({ ok: true, view, ms: round(performance.now() - started) });
    }

    // fork: a new app rooted at this version. A fork is a copy of a JSON
    // document — there is no repository to clone and no environment to create,
    // which is why it can be offered as a single click.
    const object = await findWorkspaceObject(
      workspaceId,
      body.slug,
      identity?.id ?? "u_owner",
    );
    const baseName = body.name ?? `${object?.name ?? body.slug} (copy)`;
    const newId = uniqueAppId(appId, (id) => rt.installed(id) !== undefined);
    const forked = repository
      ? await repository.fork(workspaceId, version.id, newId, visit.principal.id)
      : rt.versions.fork(version.id, newId, visit.principal.id);
    rt.install(forked.doc, {
      workspaceId,
      instanceId: STUDIO_INSTANCE_ID,
      author: visit.principal.id,
      message: `forked from ${body.slug}`,
    });
    const obj = await createWorkspaceObject(
      workspaceId,
      identity!.id,
      newId,
      baseName,
      object?.icon ?? "✳",
    );

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

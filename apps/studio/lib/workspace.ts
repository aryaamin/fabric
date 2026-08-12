import {
  createWorkspace,
  createObject,
  createShareLink,
  setPublic,
  share,
  resolveAccess,
  surfaceForAccess,
  type ShareRole,
  type Surface,
  type Workspace,
  type WorkspaceObject,
  PostgresWorkspaceRepository,
} from "@fabric/workspace";
import type { Principal } from "@fabric/permissions";
import { GUEST_PRINCIPAL, OWNER_PRINCIPAL, WORKSPACE_ID } from "./runtime";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";
import { claimWorkspaceInvitations } from "./invitations";

/**
 * Server-side Workspace singleton for the studio.
 *
 * Mirrors lib/runtime.ts: in production this is a multi-tenant, database-backed
 * object store. Here it is an in-memory workspace with one object per installed
 * app, so the Share dialog, the surface router and the workspace home operate on
 * real objects with real grants, link roles and share tokens — no mock layer.
 *
 * The object slug IS the app id, which keeps /w/[slug], /e/[slug], /api/* and
 * the runtime install key all speaking one key.
 */

declare global {
  // eslint-disable-next-line no-var
  var __fabricWorkspaces: Map<string, Workspace> | undefined;
}

/** The single signed-in user for the demo. */
export const CURRENT_USER = OWNER_PRINCIPAL.id;

export interface Person {
  id: string;
  name: string;
  initials: string;
  /** A hue on the one accent's wheel — never a second brand colour. */
  hue: number;
}

export const PEOPLE: Record<string, Person> = {
  u_owner: { id: "u_owner", name: "You", initials: "YO", hue: 258 },
  u_dana: { id: "u_dana", name: "Dana Ruiz", initials: "DR", hue: 292 },
  u_sam: { id: "u_sam", name: "Sam Iyer", initials: "SI", hue: 205 },
  u_kai: { id: "u_kai", name: "Kai Fischer", initials: "KF", hue: 160 },
  u_mira: { id: "u_mira", name: "Mira Osei", initials: "MO", hue: 25 },
};

export function personFor(id: string): Person {
  return (
    PEOPLE[id] ?? {
      id,
      name: id.replace(/^u_/, ""),
      initials: id.replace(/^u_/, "").slice(0, 2).toUpperCase(),
      hue: 258,
    }
  );
}

export function getWorkspace(workspaceId = WORKSPACE_ID, ownerId = CURRENT_USER): Workspace {
  globalThis.__fabricWorkspaces ??= new Map();
  let workspace = globalThis.__fabricWorkspaces.get(workspaceId);
  if (!workspace) {
    const ws = createWorkspace(workspaceId, workspaceId === WORKSPACE_ID ? "Acme Inc" : "My Workspace");
    globalThis.__fabricWorkspaces.set(workspaceId, ws);
    workspace = ws;
  }
  return workspace;
}

/** Find an object by its slug (which, in the studio, equals the app id). */
export function objectBySlug(
  slug: string,
  workspaceId = WORKSPACE_ID,
  ownerId = CURRENT_USER,
): WorkspaceObject | undefined {
  for (const obj of getWorkspace(workspaceId, ownerId).objects.values()) {
    if (obj.slug === slug) return obj;
  }
  return undefined;
}

export function allObjects(workspaceId = WORKSPACE_ID, ownerId = CURRENT_USER): WorkspaceObject[] {
  return [...getWorkspace(workspaceId, ownerId).objects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Create a workspace object for a newly installed app. */
export function registerObject(
  appId: string,
  name: string,
  icon: string,
  workspaceId = WORKSPACE_ID,
  ownerId = CURRENT_USER,
): WorkspaceObject {
  return createObject(getWorkspace(workspaceId, ownerId), {
    kind: "app",
    name,
    ownerId,
    slug: appId,
    appId,
    icon,
  });
}

export async function loadWorkspace(
  workspaceId: string,
  ownerId: string,
): Promise<Workspace> {
  if (!hasDurableDatabase()) return getWorkspace(workspaceId, ownerId);
  const repository = new PostgresWorkspaceRepository(getDatabaseExecutor());
  const existing = await repository.get(workspaceId);
  const workspace =
    existing ??
    (await repository.create(
      workspaceId,
      workspaceId.startsWith("org_") ? "Team Workspace" : "My Workspace",
    ));
  const loaded = (await repository.get(workspaceId)) ?? workspace;
  await ensureOwnerAppRoles(workspaceId, loaded);
  return loaded;
}

export async function listWorkspaceObjects(
  workspaceId: string,
  ownerId: string,
): Promise<WorkspaceObject[]> {
  const workspace = await loadWorkspace(workspaceId, ownerId);
  return [...workspace.objects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function findWorkspaceObject(
  workspaceId: string,
  slug: string,
  ownerId: string,
): Promise<WorkspaceObject | undefined> {
  if (hasDurableDatabase()) {
    return (
      (await new PostgresWorkspaceRepository(getDatabaseExecutor()).findBySlug(workspaceId, slug)) ??
      undefined
    );
  }
  const workspace = getWorkspace(workspaceId, ownerId);
  for (const object of workspace.objects.values()) if (object.slug === slug) return object;
  return undefined;
}

export async function createWorkspaceObject(
  workspaceId: string,
  ownerId: string,
  appId: string,
  name: string,
  icon: string,
): Promise<WorkspaceObject> {
  if (!hasDurableDatabase()) return registerObject(appId, name, icon, workspaceId, ownerId);
  await loadWorkspace(workspaceId, ownerId);
  const repository = new PostgresWorkspaceRepository(getDatabaseExecutor());
  const object = await repository.createObject(workspaceId, {
    kind: "app",
    name,
    ownerId,
    slug: appId,
    appId,
    icon,
  });
  object.slug = appId;
  await repository.saveObject(workspaceId, object);
  await grantAppRole(workspaceId, appId, ownerId, "owner");
  return object;
}

/** Create a shareable workspace object for a provider-neutral source project. */
export async function createCloudProjectObject(
  workspaceId: string,
  ownerId: string,
  projectId: string,
  name: string,
  slug: string,
  icon = "◫",
): Promise<WorkspaceObject> {
  if (!hasDurableDatabase()) {
    const object = createObject(getWorkspace(workspaceId, ownerId), {
      kind: "project",
      name,
      ownerId,
      slug,
      projectId,
      icon,
    });
    object.slug = slug;
    return object;
  }
  await loadWorkspace(workspaceId, ownerId);
  const repository = new PostgresWorkspaceRepository(getDatabaseExecutor());
  const object = await repository.createObject(workspaceId, {
    kind: "project",
    name,
    ownerId,
    slug,
    projectId,
    icon,
  });
  object.slug = slug;
  await repository.saveObject(workspaceId, object);
  return object;
}

export async function findWorkspaceProjectObject(
  workspaceId: string,
  projectId: string,
  ownerId: string,
): Promise<WorkspaceObject | undefined> {
  return (await listWorkspaceObjects(workspaceId, ownerId)).find(
    (object) => object.projectId === projectId,
  );
}

export async function publishCloudProjectObject(
  workspaceId: string,
  ownerId: string,
  projectId: string,
): Promise<WorkspaceObject> {
  const workspace = await loadWorkspace(workspaceId, ownerId);
  const object = [...workspace.objects.values()].find(
    (candidate) => candidate.projectId === projectId,
  );
  if (!object) throw new Error(`project ${projectId} not found`);
  if (resolveAccess(object, { principalId: ownerId }) !== "owner") {
    throw new Error("only project owners can publish applications");
  }
  setPublic(object, false);
  createShareLink("", workspace, object, "viewer");
  await saveWorkspaceObject(workspaceId, object);
  return object;
}

export async function resolveSharedCloudProject(
  projectId: string,
  token: string,
): Promise<{ workspaceId: string; object: WorkspaceObject } | undefined> {
  if (!token) return undefined;
  if (hasDurableDatabase()) {
    const rows = await getDatabaseExecutor()<{
      workspace_id: string;
      slug: string;
    }>(
      `SELECT workspace_id, slug
       FROM workspace_objects
       WHERE project_id = $1 AND share_token = $2
         AND (link_role IN ('viewer', 'editor') OR public = true)
       LIMIT 1`,
      [projectId, token],
    );
    const row = rows[0];
    if (!row) return undefined;
    const object = await new PostgresWorkspaceRepository(
      getDatabaseExecutor(),
    ).findBySlug(row.workspace_id, row.slug);
    return object ? { workspaceId: row.workspace_id, object } : undefined;
  }
  for (const [workspaceId, workspace] of globalThis.__fabricWorkspaces ?? []) {
    for (const object of workspace.objects.values()) {
      if (
        object.projectId === projectId &&
        object.shareToken === token &&
        (object.linkRole === "viewer" || object.linkRole === "editor" || object.public)
      ) {
        return { workspaceId, object };
      }
    }
  }
  return undefined;
}

export async function saveWorkspaceObject(
  workspaceId: string,
  object: WorkspaceObject,
): Promise<void> {
  if (!hasDurableDatabase()) return;
  await new PostgresWorkspaceRepository(getDatabaseExecutor()).saveObject(workspaceId, object);
}

export async function resolveWorkspaceVisit(
  workspaceId: string,
  ownerId: string,
  slug: string,
  query: VisitorQuery,
  opts: { embed?: boolean } = {},
): Promise<Visit> {
  if (query.principalId) {
    await claimWorkspaceInvitations(workspaceId, query.principalId);
  }
  const object = await findWorkspaceObject(workspaceId, slug, ownerId);
  if (!object) return { surface: "denied", principal: GUEST_PRINCIPAL };
  const visit = visitForObject(object, query, opts);
  if (!query.principalId || visit.surface === "denied") return visit;
  const roles = await appRoles(
    workspaceId,
    object.appId ?? slug,
    query.principalId,
    visit.role,
  );
  return {
    ...visit,
    principal: {
      id: query.principalId,
      roles: roles.length > 0 ? roles : ["guest"],
    },
  };
}

export async function grantAppRole(
  workspaceId: string,
  appId: string,
  principalId: string,
  role: string,
): Promise<void> {
  if (!hasDurableDatabase()) return;
  await getDatabaseExecutor()(
    `INSERT INTO app_role_grants (workspace_id, app_id, principal_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, app_id, principal_id, role) DO NOTHING`,
    [workspaceId, appId, principalId, role],
  );
}

async function appRoles(
  workspaceId: string,
  appId: string,
  principalId: string,
  documentRole?: ShareRole,
): Promise<string[]> {
  if (!hasDurableDatabase()) {
    return documentRole === "owner" || documentRole === "editor" ? ["owner"] : ["guest"];
  }
  const rows = await getDatabaseExecutor()<{ role: string }>(
    `SELECT role FROM app_role_grants
     WHERE workspace_id = $1 AND app_id = $2 AND principal_id = $3`,
    [workspaceId, appId, principalId],
  );
  return rows.map((row) => row.role);
}

async function ensureOwnerAppRoles(
  workspaceId: string,
  workspace: Workspace,
): Promise<void> {
  for (const object of workspace.objects.values()) {
    if (!object.appId) continue;
    for (const grant of object.grants) {
      if (grant.role === "owner") {
        await grantAppRole(workspaceId, object.appId, grant.principalId, "owner");
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Access → surface, resolved in exactly one place                     */
/* ------------------------------------------------------------------ */

export interface VisitorQuery {
  workspaceId?: string;
  /** Authenticated identity supplied by Clerk, never by a query parameter. */
  principalId?: string;
  /** ?k=<token> — the share-link capability token. */
  k?: string;
}

export interface Visit {
  object?: WorkspaceObject;
  role?: ShareRole;
  surface: Surface;
  /** in-app authority for this visitor: owner/editor act as owner, viewers are guests. */
  principal: Principal;
}

/**
 * Resolve a visitor to { role, surface, principal } using @fabric/workspace's
 * decision functions. Object access (can you open it?) chooses the surface;
 * the in-app principal chooses what you may do inside. Two planes, one place.
 */
export function resolveVisit(slug: string, q: VisitorQuery, opts: { embed?: boolean } = {}): Visit {
  const object = objectBySlug(slug, q.workspaceId ?? WORKSPACE_ID, q.principalId ?? CURRENT_USER);
  if (!object) return { surface: "denied", principal: GUEST_PRINCIPAL };
  return visitForObject(object, q, opts);
}

function visitForObject(object: WorkspaceObject, q: VisitorQuery, opts: { embed?: boolean }): Visit {
  const principalId = q.principalId;
  const role = resolveAccess(object, { ...(principalId ? { principalId } : {}), ...(q.k ? { token: q.k } : {}) });
  const surface = surfaceForAccess(role, opts);
  const principal =
    role === "owner" || role === "editor"
      ? { id: principalId ?? CURRENT_USER, roles: ["owner"] }
      : { id: principalId ?? GUEST_PRINCIPAL.id, roles: ["guest"] };

  return { object, ...(role ? { role } : {}), surface, principal };
}

/** Read `?u`/`?k` out of a Next.js searchParams bag. */
export function visitorQuery(
  sp: Record<string, string | string[] | undefined>,
  principalId?: string,
  workspaceId = WORKSPACE_ID,
): VisitorQuery {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const k = first(sp.k);
  return { workspaceId, ...(principalId ? { principalId } : {}), ...(k ? { k } : {}) };
}

/** Read the share token from a request URL and combine it with Clerk identity. */
export function visitorFromUrl(
  url: string,
  principalId?: string,
  workspaceId = WORKSPACE_ID,
): VisitorQuery {
  const sp = new URL(url).searchParams;
  const k = sp.get("k");
  return { workspaceId, ...(principalId ? { principalId } : {}), ...(k ? { k } : {}) };
}

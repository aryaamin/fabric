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
} from "@fabric/workspace";
import type { Principal } from "@fabric/permissions";
import { GUEST_PRINCIPAL, OWNER_PRINCIPAL, WORKSPACE_ID } from "./runtime";

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
  var __fabricWorkspace: Workspace | undefined;
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

interface SeedObject {
  appId: string;
  name: string;
  icon: string;
  /** minutes ago, so "last edited" reads plausibly on first load. */
  editedMinutesAgo: number;
  grants?: { principalId: string; role: ShareRole }[];
  linkRole?: ShareRole;
  isPublic?: boolean;
}

const SEED: SeedObject[] = [
  {
    appId: "expense-tracker",
    name: "Expense Tracker",
    icon: "🧾",
    editedMinutesAgo: 3,
    grants: [
      { principalId: "u_dana", role: "editor" },
      { principalId: "u_sam", role: "viewer" },
      { principalId: "u_kai", role: "viewer" },
    ],
    linkRole: "viewer",
  },
  {
    appId: "accounting",
    name: "Accounting",
    icon: "📒",
    editedMinutesAgo: 26,
    grants: [{ principalId: "u_mira", role: "editor" }],
  },
  {
    appId: "revenue-dashboard",
    name: "Revenue Dashboard",
    icon: "📊",
    editedMinutesAgo: 184,
    grants: [
      { principalId: "u_sam", role: "editor" },
      { principalId: "u_mira", role: "viewer" },
    ],
    isPublic: true,
  },
  {
    appId: "leave-requests",
    name: "Leave Requests",
    icon: "🏖",
    editedMinutesAgo: 1445,
    grants: [{ principalId: "u_dana", role: "viewer" }],
  },
];

export function getWorkspace(): Workspace {
  if (!globalThis.__fabricWorkspace) {
    const ws = createWorkspace(WORKSPACE_ID, "Acme Inc");
    for (const s of SEED) {
      const obj = createObject(ws, {
        kind: "app",
        name: s.name,
        ownerId: CURRENT_USER,
        appId: s.appId,
        icon: s.icon,
      });
      obj.slug = s.appId;
      obj.updatedAt = new Date(Date.now() - s.editedMinutesAgo * 60_000).toISOString();
      for (const g of s.grants ?? []) share(obj, g.principalId, g.role);
      if (s.linkRole) createShareLink("", ws, obj, s.linkRole);
      if (s.isPublic) setPublic(obj, true);
      // `share`/`createShareLink` bump updatedAt; restore the seeded time so
      // "last edited" reflects the app, not the seeding order.
      obj.updatedAt = new Date(Date.now() - s.editedMinutesAgo * 60_000).toISOString();
    }
    globalThis.__fabricWorkspace = ws;
  }
  return globalThis.__fabricWorkspace;
}

/** Find an object by its slug (which, in the studio, equals the app id). */
export function objectBySlug(slug: string): WorkspaceObject | undefined {
  for (const obj of getWorkspace().objects.values()) {
    if (obj.slug === slug) return obj;
  }
  return undefined;
}

export function allObjects(): WorkspaceObject[] {
  return [...getWorkspace().objects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Create a workspace object for a newly installed app. */
export function registerObject(appId: string, name: string, icon: string): WorkspaceObject {
  const obj = createObject(getWorkspace(), { kind: "app", name, ownerId: CURRENT_USER, appId, icon });
  obj.slug = appId;
  return obj;
}

/* ------------------------------------------------------------------ */
/* Access → surface, resolved in exactly one place                     */
/* ------------------------------------------------------------------ */

export interface VisitorQuery {
  /** ?u=<id> — simulate a signed-in visitor (real auth is out of scope). */
  u?: string;
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
  const object = objectBySlug(slug);
  if (!object) return { surface: "denied", principal: GUEST_PRINCIPAL };

  const principalId = q.u ?? (q.k ? undefined : CURRENT_USER);
  const role = resolveAccess(object, { ...(principalId ? { principalId } : {}), ...(q.k ? { token: q.k } : {}) });
  const surface = surfaceForAccess(role, opts);
  const principal =
    role === "owner" || role === "editor"
      ? { id: principalId ?? CURRENT_USER, roles: ["owner"] }
      : { id: principalId ?? GUEST_PRINCIPAL.id, roles: ["guest"] };

  return { object, ...(role ? { role } : {}), surface, principal };
}

/** Read `?u`/`?k` out of a Next.js searchParams bag. */
export function visitorQuery(sp: Record<string, string | string[] | undefined>): VisitorQuery {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const u = first(sp.u);
  const k = first(sp.k);
  return { ...(u ? { u } : {}), ...(k ? { k } : {}) };
}

/** Read `?u`/`?k` out of a request URL (API routes). */
export function visitorFromUrl(url: string): VisitorQuery {
  const sp = new URL(url).searchParams;
  const u = sp.get("u");
  const k = sp.get("k");
  return { ...(u ? { u } : {}), ...(k ? { k } : {}) };
}

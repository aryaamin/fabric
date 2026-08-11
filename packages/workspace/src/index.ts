/**
 * The Workspace.
 *
 * WHY this exists as its own layer: the runtime knows how to *run* an app; the
 * workspace knows that an app is an *object* a person owns, names, files in a
 * folder, shares, and embeds — exactly like a Google Doc. Sharing here is
 * document-style (owner / editor / viewer / public) and is deliberately
 * separate from an app's *internal* roles (manager, finance). Access to the
 * object (can you open it?) is a different question from authority inside it
 * (can you approve?). Conflating them is the classic mistake; we keep them
 * orthogonal.
 */

export type ShareRole = "owner" | "editor" | "viewer";

export interface Grant {
  principalId: string;
  role: ShareRole;
}

export type ObjectKind = "app" | "document" | "folder";

export interface WorkspaceObject {
  id: string;
  kind: ObjectKind;
  name: string;
  icon?: string;
  parentId?: string;
  /** app objects point at the app id the runtime installs. */
  appId?: string;
  /** stable public slug used for URLs and embeds. */
  slug: string;
  /** people explicitly invited by id (like typing an email in Google Docs). */
  grants: Grant[];
  /**
   * "Anyone with the link" access, exactly like Google Docs' link sharing:
   *   undefined  → Restricted (only people in `grants`)
   *   "viewer"   → Anyone with the link can view
   *   "editor"   → Anyone with the link can edit
   * Holding the link means holding `shareToken`.
   */
  linkRole?: ShareRole;
  /** unguessable capability token embedded in the share link. */
  shareToken: string;
  /** published to the web: anyone, no token required (read-only). */
  public: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  objects: Map<string, WorkspaceObject>;
}

function makeSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "app";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Unguessable capability token for bearer share links. */
function makeToken(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

export function createWorkspace(id: string, name: string): Workspace {
  return { id, name, objects: new Map() };
}

export interface CreateObjectInput {
  kind: ObjectKind;
  name: string;
  ownerId: string;
  appId?: string;
  parentId?: string;
  icon?: string;
}

export function createObject(ws: Workspace, input: CreateObjectInput): WorkspaceObject {
  const now = new Date().toISOString();
  const obj: WorkspaceObject = {
    id: `obj_${crypto.randomUUID()}`,
    kind: input.kind,
    name: input.name,
    slug: makeSlug(input.name),
    grants: [{ principalId: input.ownerId, role: "owner" }],
    shareToken: makeToken(),
    public: false,
    createdAt: now,
    updatedAt: now,
    ...(input.appId ? { appId: input.appId } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
  };
  ws.objects.set(obj.id, obj);
  return obj;
}

export function share(obj: WorkspaceObject, principalId: string, role: ShareRole): void {
  const existing = obj.grants.find((g) => g.principalId === principalId);
  if (existing) existing.role = role;
  else obj.grants.push({ principalId, role });
  obj.updatedAt = new Date().toISOString();
}

export function setPublic(obj: WorkspaceObject, isPublic: boolean): void {
  obj.public = isPublic;
  obj.updatedAt = new Date().toISOString();
}

/**
 * Turn on "anyone with the link" sharing at a given role and return the link.
 * This is the Google-Docs "Get link" button. The returned URL carries the
 * capability token; whoever holds it gets `role` access.
 */
export function createShareLink(
  base: string,
  ws: Workspace,
  obj: WorkspaceObject,
  role: ShareRole = "viewer",
): string {
  obj.linkRole = role;
  obj.updatedAt = new Date().toISOString();
  return appUrl(base, ws, obj, obj.shareToken);
}

/** "Restricted" again — the link stops working. Optionally rotate the token. */
export function disableShareLink(obj: WorkspaceObject, rotate = false): void {
  obj.linkRole = undefined;
  if (rotate) obj.shareToken = makeToken();
  obj.updatedAt = new Date().toISOString();
}

const RANK: Record<ShareRole, number> = { viewer: 1, editor: 2, owner: 3 };

export interface AccessContext {
  /** the signed-in viewer, if any. */
  principalId?: string;
  /** the `k` token from the share link, if any. */
  token?: string;
}

/**
 * The single access decision, mirroring Google Docs precedence:
 *   1. an explicit grant (you were invited) wins and gives its role;
 *   2. otherwise, a valid link token grants the object's linkRole;
 *   3. otherwise, a published (public) object is viewable by anyone;
 *   4. otherwise, no access.
 */
export function resolveAccess(obj: WorkspaceObject, ctx: AccessContext): ShareRole | undefined {
  if (ctx.principalId) {
    const grant = obj.grants.find((g) => g.principalId === ctx.principalId);
    if (grant) return grant.role;
  }
  if (obj.linkRole && ctx.token && ctx.token === obj.shareToken) return obj.linkRole;
  if (obj.public) return "viewer";
  return undefined;
}

export function accessRole(obj: WorkspaceObject, principalId: string): ShareRole | undefined {
  return resolveAccess(obj, { principalId });
}

export function canOpen(obj: WorkspaceObject, ctx: AccessContext): boolean {
  return resolveAccess(obj, ctx) !== undefined;
}

export function canEdit(obj: WorkspaceObject, ctx: AccessContext): boolean {
  const r = resolveAccess(obj, ctx);
  return r !== undefined && RANK[r] >= RANK.editor;
}

/**
 * The three surfaces a Fabric object resolves to.
 *   "studio" — the make surface (canvas + AI chat + toolbar). Editing.
 *   "run"    — the use surface (the running app only). No editing.
 *   "denied" — no access at all (renders a 403 / lock screen).
 */
export type Surface = "studio" | "run" | "denied";

export interface SurfaceOptions {
  /** an embed (<iframe>) request: always the chromeless running app. */
  embed?: boolean;
}

/**
 * "One link, three surfaces": the SINGLE source of truth mapping a resolved
 * access role onto the UI a visitor should get. Both the preview server and the
 * studio import this so the two can never drift.
 *
 * WHY these rules:
 *  - No role at all → "denied". Access is decided *before* surface; a link you
 *    can't open shows a lock screen, never an app.
 *  - embed → always "run". An <iframe> is a *placement* of the app, never an
 *    editor — even the owner embedding their own app wants the chromeless
 *    running app, not the studio, inside the frame.
 *  - editor/owner → "studio". The people who can change the app get the make
 *    surface (canvas + conversation + toolbar).
 *  - viewer → "run". People who can only open it get the running app, plus a
 *    "Fork a copy" affordance so they can make it their own.
 * This mirrors the product's two verbs — "make" (studio) and "use" (run) — and
 * keeps object access (can you open it?) orthogonal to in-app authority.
 */
export function surfaceForAccess(role: ShareRole | undefined, opts: SurfaceOptions = {}): Surface {
  if (!role) return "denied";
  if (opts.embed) return "run";
  return RANK[role] >= RANK.editor ? "studio" : "run";
}

/** URL + embed helpers. Apps are addressable and embeddable by slug. */
export function appUrl(base: string, ws: Workspace, obj: WorkspaceObject, token?: string): string {
  const url = `${base}/w/${ws.id}/${obj.slug}`;
  return token ? `${url}?k=${token}` : url;
}
export function embedUrl(base: string, ws: Workspace, obj: WorkspaceObject, token?: string): string {
  const url = `${base}/embed/${ws.id}/${obj.slug}`;
  return token ? `${url}?k=${token}` : url;
}
export function embedSnippet(base: string, ws: Workspace, obj: WorkspaceObject, token?: string): string {
  const src = embedUrl(base, ws, obj, token);
  return `<iframe src="${src}" style="width:100%;height:600px;border:0" title="${obj.name}"></iframe>`;
}

export * from "./repository.ts";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import {
  createWorkspace,
  createObject,
  createShareLink,
  setPublic,
  share,
  resolveAccess,
  surfaceForAccess,
  appUrl,
  type ShareRole,
  type Workspace,
  type WorkspaceObject,
} from "@fabric/workspace";
import type { Principal } from "@fabric/permissions";
import type { AppDocument } from "@fabric/ir";
import { expenseTracker } from "../../../examples/apps/expense-tracker.ts";
import { accounting } from "../../../examples/apps/accounting.ts";
import { leaveRequests } from "../../../examples/apps/leave-requests.ts";
import { revenueDashboard } from "../../../examples/apps/revenue-dashboard.ts";
import { feedbackTriage } from "../../../examples/apps/feedback-triage.ts";
import { renderNode, page, readOnlyChrome, studioBanner, submittedBanner } from "./render-html.ts";

/**
 * The preview/runtime server.
 *
 * WHY it exists: "instantly receive a URL." An installed app is reachable at a
 * stable URL and embeddable via an <iframe> the moment it exists. This is a
 * zero-dependency Node HTTP server hosting the same runtime the studio uses;
 * in production it is the multi-tenant edge/serverless host.
 */

const rt = new Runtime();
rt.registry.register(storageCapabilityFactory());
rt.registry.register(notificationsCapabilityFactory());
rt.registry.register(aiCapabilityFactory());

const ws: Workspace = createWorkspace("ws_acme", "Acme Inc");
const objects: WorkspaceObject[] = [];

const APPS: AppDocument[] = [expenseTracker, accounting, leaveRequests, revenueDashboard, feedbackTriage];

export async function boot(): Promise<void> {
  for (const doc of APPS) {
    rt.install(doc, { workspaceId: ws.id, message: "created" });
    const obj = createObject(ws, {
      kind: "app",
      name: doc.name,
      ownerId: "u_mgr",
      appId: doc.id,
      ...(doc.icon ? { icon: doc.icon } : {}),
    });
    // The manager owns everything here; give the demo an editor too so the
    // "editor can submit / viewer cannot" split is reachable from a URL.
    share(obj, "u_editor", "editor");
    objects.push(obj);
  }
  // Expense Tracker: anyone with the link can view. Accounting: published.
  createShareLink("", ws, objects[0]!, "viewer");
  setPublic(objects[1]!, true);
  setPublic(objects[3]!, true);

  // Seed data so every URL shows something real.
  const emp: Principal = { id: "u_emp", roles: ["employee"] };
  const mgr: Principal = { id: "u_mgr", roles: ["manager"] };
  const owner: Principal = { id: "u_mgr", roles: ["owner"] };
  await rt.invokeAction("expense-tracker", "submitExpense", { amount: 120, description: "Team lunch", category: "meals" }, emp);
  await rt.invokeAction("expense-tracker", "submitExpense", { amount: 300, description: "Client dinner", category: "meals" }, mgr);
  await rt.invokeAction("revenue-dashboard", "seedDemoData", {}, owner);
  await rt.invokeAction("feedback-triage", "submitFeedback", { message: "The export button is broken on Safari" }, owner);
  await rt.invokeAction("feedback-triage", "submitFeedback", { message: "I love the new dashboard, great work" }, owner);
}

function principalFromReq(url: URL): Principal {
  const role = url.searchParams.get("as") ?? "owner";
  return { id: url.searchParams.get("u") ?? `u_${role}`, roles: [role] };
}

/** Where an editor/owner is sent to actually edit — the studio, not the server. */
const STUDIO_BASE = process.env.STUDIO_URL ?? "http://localhost:3000";
function studioUrl(obj: WorkspaceObject): string {
  return `${STUDIO_BASE}/w/${obj.slug}`;
}

/** Object-level access: only editors and owners may write through a surface. */
function mayWrite(role: ShareRole | undefined): boolean {
  return role === "editor" || role === "owner";
}

/** Carry identity/token params across the POST → redirect round trip. */
function accessQuery(url: URL): string {
  const keep = new URLSearchParams();
  for (const k of ["u", "k", "as", "view"]) {
    const v = url.searchParams.get(k);
    if (v) keep.set(k, v);
  }
  return keep.toString();
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // GET /  -> workspace index
    if (parts.length === 0) return send(res, 200, page("Acme Inc", indexHtml()));

    // POST /submit/:ws/:slug  -> data entry from a rendered <form>
    if (parts[0] === "submit" && req.method === "POST" && parts.length >= 3) {
      return await handleSubmit(req, res, url, parts[2]!);
    }

    // GET /w/:ws/:slug  and  GET /embed/:ws/:slug
    const embed = parts[0] === "embed";
    if ((parts[0] === "w" || embed) && parts.length >= 3) {
      const obj = objects.find((o) => o.slug === parts[2]);
      if (!obj?.appId) return send(res, 404, page("Not found", `<main class="page"><h1>404</h1></main>`));

      // Google-Docs-style access: explicit grant OR ?k link token OR public.
      const access = resolveAccess(obj, {
        principalId: url.searchParams.get("u") ?? undefined,
        token: url.searchParams.get("k") ?? undefined,
      });

      // One link, three surfaces: the object's access decides the UI. This is
      // the SAME decision the studio makes — surfaceForAccess is shared.
      const surface = surfaceForAccess(access, { embed });
      if (surface === "denied") {
        return send(res, 403, page("No access", `<main class="page"><h1>🔒 No access</h1><p class="sub">Ask the owner to share this app with you or send you the link.</p></main>`, embed));
      }

      // Editor/owner via the server → point them at the studio (the server runs
      // apps, it is not the editor).
      if (surface === "studio") {
        return send(res, 200, page(obj.name, studioBanner(obj.name, studioUrl(obj))));
      }

      // surface === "run": render the running app.
      const doc = rt.installed(obj.appId)!;
      const wanted = url.searchParams.get("view");
      const view = doc.views.find((v) => v.name === wanted) ?? doc.views[0]!;
      const tree = await rt.renderView(obj.appId, view.name, principalFromReq(url));
      const query = accessQuery(url);
      const appHtml = renderNode(tree, {
        submitUrl: `/submit/${ws.id}/${obj.slug}`,
        viewName: view.name,
        submitQuery: query,
        returnTo: `${url.pathname}${query ? `?${query}` : ""}`,
        canSubmit: mayWrite(access),
      });
      const flash = url.searchParams.get("submitted") ? submittedBanner("Saved.") : "";
      // Embed → chromeless. Viewer (non-embed) → read-only chrome + Fork.
      if (embed) return send(res, 200, page(obj.name, flash + appHtml, true));
      return send(res, 200, page(obj.name, flash + readOnlyChrome(appHtml, appUrl("", ws, obj) + "?fork=1")));
    }

    // POST /api/:app/actions/:action
    if (parts[0] === "api" && parts[3] === "actions" && req.method === "POST") {
      const body = await readBody(req);
      const out = await rt.invokeAction(parts[1]!, parts[4]!, body, principalFromReq(url));
      return sendJson(res, 200, { ok: true, result: out });
    }

    send(res, 404, page("Not found", `<main class="page"><h1>404</h1></main>`));
  } catch (e) {
    sendJson(res, 400, { ok: false, error: (e as Error).message });
  }
}

/**
 * The write path.
 *
 * The body contains raw field values plus `__view` / `__action`. It contains NO
 * action arguments: `rt.submit` derives those from the installed IR, so a hand
 * crafted POST cannot smuggle in a parameter the document never declared. This
 * handler's only job is the *object-level* question — may this visitor write to
 * this workspace object at all? — which is the same `resolveAccess` decision the
 * GET path makes. A read-only viewer is refused here even though they can see
 * the form (it renders disabled for them).
 */
async function handleSubmit(req: IncomingMessage, res: ServerResponse, url: URL, slug: string) {
  const obj = objects.find((o) => o.slug === slug);
  if (!obj?.appId) return send(res, 404, page("Not found", `<main class="page"><h1>404</h1></main>`));

  const access = resolveAccess(obj, {
    principalId: url.searchParams.get("u") ?? undefined,
    token: url.searchParams.get("k") ?? undefined,
  });
  if (!mayWrite(access)) {
    return send(
      res,
      403,
      page(
        "Read-only",
        `<main class="page"><h1>🔒 Read-only</h1><p class="sub">${
          access ? "You can view this app but not submit to it." : "You do not have access to this app."
        }</p></main>`,
      ),
    );
  }

  const body = await readBody(req);
  const viewName = String(body.__view ?? "");
  const action = String(body.__action ?? "");
  const returnTo = String(body.__return ?? "");
  const form = { ...body };
  delete form.__view;
  delete form.__action;
  delete form.__return;

  await rt.submit(obj.appId, viewName, action, form, principalFromReq(url));

  // Redirect (see-other) so a refresh does not re-submit. Only same-origin
  // paths are honoured, so `__return` cannot become an open redirect.
  const base = returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : `/w/${ws.id}/${obj.slug}`;
  const location = `${base}${base.includes("?") ? "&" : "?"}submitted=1`;
  res.writeHead(303, { location });
  res.end();
}

function indexHtml(): string {
  const items = objects
    .map(
      (o) =>
        `<a class="card" style="text-decoration:none;color:inherit" href="${appUrl("", ws, o)}?u=u_editor"><div class="card-body"><strong>${o.icon ?? "▚"} ${o.name}</strong><span class="sub">/${o.slug}</span></div></a>`,
    )
    .join("");
  return `<main class="page"><header class="page-head"><h1>Acme Inc — Workspace</h1><p class="sub">${objects.length} apps, all running on the interpreter.</p></header><div class="stack">${items}</div></main>`;
}

function send(res: ServerResponse, code: number, html: string) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
function sendJson(res: ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** Accepts both JSON (the API) and urlencoded form posts (the run surface). */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      if (!d) return resolve({});
      const type = String(req.headers["content-type"] ?? "");
      if (type.includes("application/x-www-form-urlencoded")) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of new URLSearchParams(d)) out[k] = v;
        return resolve(out);
      }
      try {
        resolve(JSON.parse(d) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

/** `--check` boots the runtime and exits: a headless smoke test for CI. */
const checkOnly = process.argv.includes("--check");
const port = Number(process.env.PORT ?? 7777);

boot().then(() => {
  if (checkOnly) {
    console.log(`✓ server boots: ${objects.length} apps installed, ${rt.installedDocs(ws.id).length} in workspace ${ws.id}`);
    objects.forEach((o) => console.log(`  /w/${ws.id}/${o.slug}`));
    return;
  }
  const base = `http://localhost:${port}`;
  createServer(handle).listen(port, () => {
    console.log(`Fabric preview server on ${base}`);
    console.log(`  workspace:        ${base}/`);
    console.log(`  owner → studio:   ${base}/w/ws_acme/${objects[0]?.slug}?u=u_mgr   (edit access → "Open in Studio" banner)`);
    console.log(`  editor → forms:   ${base}/embed/ws_acme/${objects[0]?.slug}?u=u_editor&as=manager   (can submit)`);
    console.log(`  viewer → run:     ${base}/w/ws_acme/${objects[0]?.slug}?k=${objects[0]?.shareToken}   (read-only: form disabled, POST → 403)`);
    console.log(`  no-access (403):  ${base}/w/ws_acme/${objects[0]?.slug}`);
    console.log(`  published embed:  ${base}/embed/ws_acme/${objects[3]?.slug}   (revenue dashboard, chromeless)`);
  });
});

import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import { createWorkspace, createObject, createShareLink, resolveAccess, surfaceForAccess } from "@fabric/workspace";
import { findHandler } from "@fabric/interpreter";
import type { RenderNode } from "@fabric/interpreter";
import { expenseTracker } from "./apps/expense-tracker.ts";
import { feedbackTriage } from "./apps/feedback-triage.ts";
import { renderNode } from "../apps/server/src/render-html.ts";

/**
 * Forms end-to-end: the write path a non-technical user actually uses.
 *
 * Proves, in-process:
 *   1. a `Form` in the IR becomes real HTML with real inputs;
 *   2. `rt.submit` runs the declared action and returns the fresh view;
 *   3. arguments come from the DOCUMENT, so a crafted submission cannot set a
 *      field the form never declared;
 *   4. a read-only viewer is refused (403 at the object layer, permission_denied
 *      at the app layer).
 */

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n\x1b[1m\x1b[36m# ${s}\x1b[0m`);
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => line(`    ${s}`);

let failures = 0;
function assert(cond: unknown, what: string) {
  if (cond) ok(what);
  else {
    failures++;
    line(`  \x1b[31m✗ ${what}\x1b[0m`);
  }
}

/** Depth-first search for the first node of a type in a resolved tree. */
function find(node: RenderNode, type: string): RenderNode | undefined {
  if (node.type === type) return node;
  for (const c of node.children) {
    const hit = find(c, type);
    if (hit) return hit;
  }
  return undefined;
}

const employee = { id: "u_emp", roles: ["employee"] };
const finance = { id: "u_fin", roles: ["finance"] };

async function main() {
  h("1. Install an app whose view contains a Form");
  const rt = new Runtime();
  rt.registry.register(storageCapabilityFactory());
  rt.registry.register(notificationsCapabilityFactory());
  rt.registry.register(aiCapabilityFactory());
  rt.install(expenseTracker, { workspaceId: "ws_acme", message: "created" });
  rt.install(feedbackTriage, { workspaceId: "ws_acme", message: "created" });
  const view = expenseTracker.views[0]!;
  const handler = findHandler(view, "submit", "submitExpense");
  assert(handler !== undefined, `findHandler located the submit handler for "submitExpense"`);
  assert(Object.keys(handler?.args ?? {}).join(",") === "amount,description,category", `its args are declared in the IR: ${Object.keys(handler?.args ?? {}).join(", ")}`);

  h("2. The Form renders as real HTML with real inputs (no client JS)");
  const tree = await rt.renderView("expense-tracker", "list", employee);
  const html = renderNode(tree, { submitUrl: "/submit/ws_acme/expenses", viewName: "list", canSubmit: true });
  assert(html.includes(`<form class="form" method="POST" action="/submit/ws_acme/expenses"`), `emits <form method="POST">`);
  assert(html.includes(`name="amount"`) && html.includes(`type="number"`), `emits <input name="amount" type="number">`);
  assert(html.includes(`name="description"`), `emits <input name="description">`);
  assert(html.includes(`<select id="f_category" name="category"`), `emits <select name="category"> with options`);
  assert(html.includes(`name="__action" value="submitExpense"`), `posts the action NAME only — never its arguments`);

  h("3. Submit the form: rt.submit(app, view, action, form, principal)");
  const before = find(tree, "Table")?.data?.length ?? 0;
  const submitted = await rt.submit(
    "expense-tracker",
    "list",
    "submitExpense",
    // Values arrive as strings, exactly as an HTML form delivers them.
    { amount: "250", description: "Standing desk", category: "software" },
    employee,
  );
  const table = find(submitted.view, "Table");
  const rows = (table?.data ?? []) as Record<string, unknown>[];
  assert(rows.length === before + 1, `a row was created (${before} → ${rows.length})`);
  const row = rows.find((r) => r.description === "Standing desk");
  assert(row !== undefined, `the returned view already contains it — one round trip, no refetch`);
  assert(row?.amount === 250, `"250" was coerced to the number 250 from the Field's kind`);
  assert(row?.status === "pending", `status came from the document, not the form`);
  assert(row?.submittedBy === "u_emp", `submittedBy came from the principal, not the form`);
  assert(typeof submitted.result === "string", `the action's return value is handed back too (id ${String(submitted.result).slice(0, 8)}…)`);

  h("4. Security: a crafted submission cannot invent arguments");
  const crafted = await rt.submit(
    "expense-tracker",
    "list",
    "submitExpense",
    {
      amount: "9",
      description: "Coffee",
      category: "meals",
      // None of these are declared Fields, and none appear in the handler's
      // args. They are dropped before the action ever runs.
      status: "approved",
      submittedBy: "u_ceo",
      id: "forged",
    },
    employee,
  );
  const forged = ((find(crafted.view, "Table")?.data ?? []) as Record<string, unknown>[]).find(
    (r) => r.description === "Coffee",
  );
  assert(forged?.status === "pending", `injected status:"approved" was ignored → still "pending"`);
  assert(forged?.submittedBy === "u_emp", `injected submittedBy:"u_ceo" was ignored → still "u_emp"`);
  info(`the IR declares the argument list, so the request cannot extend it`);

  h("5. AI inside the app: one form field in, two AI tags out");
  const triaged = await rt.submit(
    "feedback-triage",
    "triage",
    "submitFeedback",
    { message: "The export button is broken on Safari" },
    { id: "u_member", roles: ["member"] },
  );
  const fb = ((find(triaged.view, "Table")?.data ?? []) as Record<string, unknown>[])[0];
  assert(typeof fb?.sentiment === "string" && typeof fb?.category === "string", `stored with sentiment="${fb?.sentiment}" category="${fb?.category}" from ai.classify`);

  h("6. A read-only viewer cannot submit");
  const ws = createWorkspace("ws_acme", "Acme Inc");
  const obj = createObject(ws, { kind: "app", name: "Expense Tracker", ownerId: "u_mgr", appId: expenseTracker.id });
  const token = new URL("http://x" + createShareLink("", ws, obj, "viewer")).searchParams.get("k")!;
  const viewerRole = resolveAccess(obj, { token });
  const mayWrite = viewerRole === "editor" || viewerRole === "owner";
  assert(surfaceForAccess(viewerRole) === "run", `link visitor resolves to access "${viewerRole}" → surface "run"`);
  assert(!mayWrite, `object layer: POST /submit would answer 403 (viewer may read, not write)`);

  const viewerHtml = renderNode(tree, { submitUrl: "/submit/ws_acme/expenses", viewName: "list", canSubmit: false });
  assert(viewerHtml.includes("<fieldset disabled>"), `and the form renders disabled for them`);

  let denied = "";
  try {
    await rt.submit("expense-tracker", "list", "submitExpense", { amount: "1", description: "nope" }, finance);
  } catch (e) {
    denied = (e as Error).message;
  }
  assert(denied.includes("cannot run submitExpense"), `app layer: finance is refused too → ${denied}`);

  h(failures === 0 ? "Done — data entry works, and only for people allowed to enter it." : `${failures} ASSERTION(S) FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\x1b[31mFORMS DEMO FAILED:\x1b[0m", e);
  process.exit(1);
});

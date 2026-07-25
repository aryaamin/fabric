import { applyPatches, type AppDocument } from "@fabric/ir";
import { validateWorkspace } from "@fabric/validator";
import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import { expenseTracker } from "./apps/expense-tracker.ts";
import { accounting } from "./apps/accounting.ts";

/**
 * Cross-app connections, checked.
 *
 * A subscription is the one part of a document that talks about another app:
 * "when expense-tracker.expenseApproved, run recordEntry, mapping the event's
 * `description` onto `memo`". Nothing inside `accounting` can tell whether
 * `description` is really part of that event — only the pair can. This demo
 * proves `validateWorkspace` catches the three ways that pair can be wrong, and
 * that the runtime reports them as warnings without refusing a valid document.
 */

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n\x1b[1m\x1b[36m# ${s}\x1b[0m`);
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => line(`  \x1b[33m!\x1b[0m ${s}`);
const info = (s: string) => line(`    ${s}`);

let failures = 0;
function assert(cond: unknown, what: string) {
  if (cond) ok(what);
  else {
    failures++;
    line(`  \x1b[31m✗ ${what}\x1b[0m`);
  }
}

/** Break the map so it reads a field the source event does not declare. */
function withBadField(): AppDocument {
  return applyPatches(accounting, [
    { op: "set", path: "subscriptions.0.map.memo", value: { $: "event.note" } },
  ]);
}

/** Break the event name so the subscription points at nothing. */
function withBadEvent(): AppDocument {
  return applyPatches(accounting, [
    { op: "set", path: "subscriptions.0.on", value: "expense-tracker.expenseArchived" },
  ]);
}

/** Break the target param so the mapped value would be dropped on the floor. */
function withBadParam(): AppDocument {
  return applyPatches(accounting, [
    { op: "set", path: "subscriptions.0.map.note", value: { $: "event.description" } },
  ]);
}

function main() {
  h("1. The real workspace: expense-tracker → accounting");
  const clean = validateWorkspace([expenseTracker, accounting]);
  assert(clean.diagnostics.length === 0, `no diagnostics — the map only reads declared payload fields`);
  info(`expenseApproved declares: expenseId, amount, description`);
  info(`accounting maps:          amount ← event.amount, memo ← event.description`);

  h("2. Break the map: read a field the source event does not declare");
  const d2 = validateWorkspace([expenseTracker, withBadField()]).diagnostics;
  assert(d2.length === 1 && d2[0]!.code === "conn.map", `caught it as ${d2[0]?.code}`);
  bad(d2[0]!.message);
  info(`path: ${d2[0]!.path}`);

  h("3. Break the event name: subscribe to something that does not exist");
  const d3 = validateWorkspace([expenseTracker, withBadEvent()]).diagnostics;
  assert(d3.some((x) => x.code === "conn.event"), `caught it as conn.event`);
  bad(d3[0]!.message);

  h("4. Break the target: map onto a param the local action does not declare");
  const d4 = validateWorkspace([expenseTracker, withBadParam()]).diagnostics;
  assert(d4.some((x) => x.code === "conn.param"), `caught it as conn.param`);
  bad(d4.find((x) => x.code === "conn.param")!.message);

  h("5. A missing source app is silent by default, loud on request");
  const alone = validateWorkspace([accounting]);
  assert(alone.diagnostics.length === 0, `accounting alone: no complaint (the source may live elsewhere)`);
  const strict = validateWorkspace([accounting], { requireKnownSources: true });
  assert(strict.diagnostics[0]?.code === "conn.source", `with requireKnownSources: ${strict.diagnostics[0]?.message}`);

  h("6. The runtime warns but never refuses: a bad connection is not a bad app");
  const rt = new Runtime();
  rt.registry.register(storageCapabilityFactory());
  rt.registry.register(notificationsCapabilityFactory());
  rt.registry.register(aiCapabilityFactory());
  rt.install(expenseTracker, { workspaceId: "ws_acme", message: "created" });
  rt.install(withBadField(), { workspaceId: "ws_acme", message: "created" });
  assert(rt.installed("accounting") !== undefined, `the app installed and is running`);
  const warned = rt.logs.entries.filter((e) => e.level === "warn" && e.msg.includes("conn.map"));
  assert(warned.length === 1, `and the runtime logged the warning: ${warned[0]?.msg}`);
  const live = rt.workspaceDiagnostics("ws_acme");
  assert(live.length === 1 && live[0]!.level === "warning", `rt.workspaceDiagnostics() surfaces it for the UI too`);

  h(failures === 0 ? "Done — a connection is only as good as both sides agree." : `${failures} ASSERTION(S) FAILED`);
  if (failures > 0) process.exit(1);
}

main();

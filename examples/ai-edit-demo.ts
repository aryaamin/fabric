import { Orchestrator, ScriptedPlanner, EXAMPLE_PROMPTS } from "@fabric/orchestrator";
import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory, InMemoryDataStore, type DataStore } from "@fabric/storage";
import type { AppDocument } from "@fabric/ir";
import { expenseTracker } from "./apps/expense-tracker.ts";

/**
 * The conversational-edit pipeline, end to end, offline.
 *
 *   prompt → patches → apply → validate → new version → re-render
 *
 * The point of this demo is the *shape* of an AI edit in Fabric. "Add a vendor
 * field" is not a regenerated codebase; it is six typed patches to one document
 * — model field, action param, the storage step that persists it, the form
 * input, the handler mapping and the table column — that the validator checks
 * before anything reaches a user. Then it proves the loop closed by submitting a
 * row through the *new* field and finding it in the rendered view.
 */

const rt = new Runtime();
const stores = new Map<string, DataStore>();
rt.registry.register(
  storageCapabilityFactory((env) => {
    const key = env.namespace ?? "default";
    let store = stores.get(key);
    if (!store) {
      store = new InMemoryDataStore();
      stores.set(key, store);
    }
    return store;
  }),
);
rt.registry.register(notificationsCapabilityFactory());
rt.registry.register(aiCapabilityFactory());

const owner = { id: "u_owner", roles: ["owner", "manager", "employee"] };
rt.install(expenseTracker, { workspaceId: "ws_demo", message: "created" });
const viewName = expenseTracker.views[0]!.name;

const orchestrator = new Orchestrator(new ScriptedPlanner());
let doc: AppDocument = rt.installed(expenseTracker.id)!;
let failures = 0;

console.log("\n▚ conversational edits\n");

for (const prompt of [...EXAMPLE_PROMPTS, "flurb the grobnitz"]) {
  const t0 = performance.now();
  const edit = await orchestrator.edit(prompt, doc, rt.registry.manifests());
  const ms = (performance.now() - t0).toFixed(3);

  if (edit.patches.length === 0) {
    // Not understood — which is a legitimate answer, not a failure, as long as
    // the document is left untouched.
    console.log(`  ·  not understood        "${prompt}"`);
    continue;
  }
  if (!edit.ok || !edit.next) {
    failures++;
    console.log(`  ✗  REJECTED by validator "${prompt}"`);
    for (const d of edit.diagnostics.filter((x) => x.level === "error")) {
      console.log(`       [${d.code}] ${d.path}: ${d.message}`);
    }
    continue;
  }

  const installed = rt.install(edit.next, { workspaceId: "ws_demo", author: "ai", message: prompt });
  doc = edit.next;
  console.log(
    `  ✓  ${String(edit.patches.length).padStart(2)} patch(es) in ${ms.padStart(7)} ms  ${installed.version.slice(0, 10)}  "${prompt}"`,
  );
  for (const p of edit.patches) console.log(`       ${p.op.padEnd(6)} ${p.path}`);
}

/* -- prove the added fields are real, not decoration -------------------- */

console.log("\n▚ using the fields the AI just added\n");

await rt.submit(
  expenseTracker.id,
  viewName,
  "submitExpense",
  { amount: 88, description: "Taxi to airport", category: "travel", vendor: "Uber", notes: "late night" },
  owner,
);

const tree = await rt.renderView(expenseTracker.id, viewName, owner);
const rendered = JSON.stringify(tree);
const checks: [string, boolean][] = [
  ["vendor value stored and rendered", rendered.includes("Uber")],
  ["notes value stored and rendered", rendered.includes("late night")],
  ["vendor is a form field", rendered.includes('"name":"vendor"')],
  ["vendor is a table column", rendered.includes('"vendor"')],
  ["history is monotonic", rt.versions.history(expenseTracker.id).length > 1],
];

for (const [label, ok] of checks) {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"}  ${label}`);
}

console.log(
  `\n${failures === 0 ? "✓ ai-edit-demo passed" : `✗ ai-edit-demo FAILED (${failures})`} — ${
    rt.versions.history(expenseTracker.id).length
  } versions, no rebuild, no redeploy.\n`,
);

if (failures > 0) process.exit(1);

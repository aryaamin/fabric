import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import { diff } from "@fabric/versioning";
import {
  createWorkspace,
  createObject,
  share,
  setPublic,
  appUrl,
  embedSnippet,
} from "@fabric/workspace";
import { applyPatches } from "@fabric/ir";
import { expenseTracker } from "./apps/expense-tracker.ts";
import { accounting } from "./apps/accounting.ts";

const line = (s = "") => console.log(s);
const h = (s: string) => line(`\n\x1b[1m\x1b[36m# ${s}\x1b[0m`);
const ok = (s: string) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => line(`    ${s}`);

const employee = { id: "u_emp", roles: ["employee"] };
const manager = { id: "u_mgr", roles: ["manager"] };
const finance = { id: "u_fin", roles: ["finance"] };

async function main() {
  h("1. Boot the runtime and install capabilities (plugins)");
  const rt = new Runtime({ echoLogs: false });
  rt.registry.register(storageCapabilityFactory());
  rt.registry.register(notificationsCapabilityFactory());
  rt.registry.register(aiCapabilityFactory());
  ok(`capabilities available: ${rt.registry.names().join(", ")}`);

  h("2. Create a workspace and file two apps as objects (like docs)");
  const ws = createWorkspace("ws_acme", "Acme Inc");
  const expObj = createObject(ws, { kind: "app", name: "Expense Tracker", ownerId: manager.id, appId: expenseTracker.id, icon: "🧾" });
  const accObj = createObject(ws, { kind: "app", name: "Accounting", ownerId: manager.id, appId: accounting.id, icon: "📒" });
  ok(`workspace "${ws.name}" now contains ${ws.objects.size} objects`);
  info(`${expObj.icon} ${expObj.name}   → ${appUrl("https://fabric.app", ws, expObj)}`);
  info(`${accObj.icon} ${accObj.name}       → ${appUrl("https://fabric.app", ws, accObj)}`);

  h("3. Install the apps into the runtime (validate → version → wire)");
  rt.install(expenseTracker, { workspaceId: ws.id, message: "initial expense tracker" });
  rt.install(accounting, { workspaceId: ws.id, message: "initial accounting" });
  ok("both apps installed with storage, permissions, events, connections — zero config");

  h("4. Employee submits an expense (an action = declarative IR steps)");
  const id1 = (await rt.invokeAction("expense-tracker", "submitExpense", { amount: 120, description: "Team lunch" }, employee)) as string;
  await rt.invokeAction("expense-tracker", "submitExpense", { amount: 40, description: "Taxi" }, employee);
  await rt.invokeAction("expense-tracker", "submitExpense", { amount: 300, description: "Client dinner" }, manager);
  ok(`3 expenses submitted (2 by employee, 1 by manager) + notifications sent`);

  h("5. Permission model: employee tries to approve (should be denied)");
  try {
    await rt.invokeAction("expense-tracker", "approveExpense", { id: id1 }, employee);
  } catch (e) {
    ok(`denied as expected: ${(e as Error).message}`);
  }

  h("6. Manager approves → event fires → Accounting reacts automatically");
  await rt.invokeAction("expense-tracker", "approveExpense", { id: id1 }, manager);
  ok("manager approved the expense");
  const ledger = (await rt.invokeAction("accounting", "ledger", {}, { id: "system", roles: ["owner"] })) as any[];
  ok(`Accounting ledger now has ${ledger.length} entry (created via a connection, no API):`);
  ledger.forEach((e) => info(`- $${e.amount} "${e.memo}" from ${e.source}`));

  h("7. Row-level permissions: who sees which expenses");
  const asMgr = await rt.renderView("expense-tracker", "list", manager);
  const asEmp = await rt.renderView("expense-tracker", "list", employee);
  const asFin = await rt.renderView("expense-tracker", "list", finance);
  const count = (n: any) => (n.children[0]?.data ?? []).length;
  ok(`manager sees ${count(asMgr)}, finance sees ${count(asFin)}, employee sees ${count(asEmp)} (only their own 2 of 3)`);

  h("8. AI capability + aggregation via monthlySummary");
  const summary = (await rt.invokeAction("expense-tracker", "monthlySummary", {}, manager)) as any;
  ok(`summary: count=${summary.count}, text="${summary.summary}"`);

  h("9. Live editing: a prompt adds a 'notes' field — as an IR patch");
  const edited = applyPatches(expenseTracker, [
    { op: "insert", path: "models.name(Expense).fields", value: { name: "notes", type: "text" } },
  ]);
  const v2 = rt.install(edited, { workspaceId: ws.id, author: "ai", message: "add notes field to expenses" });
  ok(`re-installed instantly (no rebuild/redeploy). new version ${v2.version}`);

  h("10. Version history + diff (Git-like, without exposing Git)");
  const hist = rt.versions.history("expense-tracker");
  hist.forEach((v) => info(`${v.id}  ${v.author.padEnd(6)}  ${v.message}`));
  const changes = diff(hist[1]!.doc, hist[0]!.doc);
  ok(`diff v1→v2: ${changes.map((c) => `${c.kind} ${c.path}`).join("; ")}`);

  h("11. Restore an earlier version");
  const restored = rt.versions.restore("expense-tracker", hist[1]!.id);
  ok(`head is back at ${restored.id} ("${restored.message}")`);

  h("12. Sharing & embedding (Google-Docs-style)");
  share(expObj, finance.id, "viewer");
  share(expObj, employee.id, "editor");
  setPublic(accObj, true);
  ok(`Expense Tracker shared: finance=viewer, employee=editor`);
  ok(`Accounting made public`);
  info(`embed anywhere:`);
  info(embedSnippet("https://fabric.app", ws, accObj));

  h("Done — an application platform, not an app. Everything above ran on the interpreter.");
}

main().catch((e) => {
  console.error("\x1b[31mDEMO FAILED:\x1b[0m", e);
  process.exit(1);
});

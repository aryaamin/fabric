import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import { Orchestrator, MockPlanner } from "@fabric/orchestrator";
import { expenseTracker } from "./apps/expense-tracker.ts";

/**
 * "Editing an app is a conversation." Each user message becomes IR patches,
 * which are validated and installed as a new version — live, no redeploy.
 */
async function main() {
  const rt = new Runtime();
  rt.registry.register(storageCapabilityFactory());
  rt.registry.register(notificationsCapabilityFactory());
  rt.registry.register(aiCapabilityFactory());
  rt.install(expenseTracker, { workspaceId: "ws", message: "created" });

  const orchestrator = new Orchestrator(new MockPlanner());
  const conversation = [
    "Add a text field called notes to Expense",
    "Add an approver role",
    "Add a number field called limit to Expense",
  ];

  let doc = rt.installed("expense-tracker")!;
  for (const prompt of conversation) {
    const res = await orchestrator.edit(prompt, doc, rt.registry.manifests());
    if (!res.ok) {
      console.log(`✗ "${prompt}" rejected: ${res.diagnostics.map((d) => d.message).join(", ")}`);
      continue;
    }
    const v = rt.install(res.next!, { workspaceId: "ws", author: "ai", message: prompt });
    doc = res.next!;
    console.log(`✓ "${prompt}"`);
    console.log(`    patches: ${JSON.stringify(res.patches)}`);
    console.log(`    version: ${v.version}`);
  }

  console.log(`\nHistory (newest first):`);
  for (const v of rt.versions.history("expense-tracker")) console.log(`  ${v.id}  ${v.message}`);
  console.log(`\nExpense now has fields: ${doc.models[0]!.fields.map((f) => f.name).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import type { Principal } from "@fabric/permissions";
import { leaveRequests } from "./apps/leave-requests.ts";

const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m# ${s}\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);

const alice: Principal = { id: "alice", roles: ["employee"] };
const bob: Principal = { id: "bob", roles: ["employee"] };
const mgr: Principal = { id: "mona", roles: ["manager"] };

async function main() {
  h("Boot runtime + install the Leave Requests app");
  const rt = new Runtime();
  rt.registry.register(storageCapabilityFactory());
  rt.registry.register(notificationsCapabilityFactory());
  rt.registry.register(aiCapabilityFactory());
  rt.install(leaveRequests, { workspaceId: "ws_acme", message: "created" });
  ok("installed with storage, notifications, permissions — zero config");

  h("Employees request leave");
  const r1 = (await rt.invokeAction("leave-requests", "requestLeave", { days: 3, reason: "Vacation", startDate: "2026-08-01", endDate: "2026-08-03" }, alice)) as string;
  const r2 = (await rt.invokeAction("leave-requests", "requestLeave", { days: 1, reason: "Doctor", startDate: "2026-08-05", endDate: "2026-08-05" }, bob)) as string;
  ok(`alice → request ${r1}; bob → request ${r2}`);

  h("Permission gate: an employee cannot decide");
  try {
    await rt.invokeAction("leave-requests", "decide", { id: r1, approve: true }, alice);
  } catch (e) {
    ok(`denied as expected: ${(e as Error).message}`);
  }

  h("Manager decides — `if` step branches on approve/reject");
  await rt.invokeAction("leave-requests", "decide", { id: r1, approve: true }, mgr);
  await rt.invokeAction("leave-requests", "decide", { id: r2, approve: false }, mgr);
  ok("alice approved (✅ branch), bob declined (❌ branch)");

  h("`forEach` step: remind manager about anything still pending");
  await rt.invokeAction("leave-requests", "requestLeave", { days: 2, reason: "Moving", startDate: "2026-08-10", endDate: "2026-08-11" }, alice);
  const pending = (await rt.invokeAction("leave-requests", "remindPending", {}, mgr)) as any[];
  ok(`remindPending looped over ${pending.length} pending request(s), one notification each`);

  h("Row-level permissions: who sees which requests");
  const seen = async (p: Principal) => ((await rt.renderView("leave-requests", "list", p)).children[0]?.data ?? []).length;
  ok(`manager sees ${await seen(mgr)}, alice sees ${await seen(alice)} (own only), bob sees ${await seen(bob)} (own only)`);

  h("Notifications emitted during the run (from the notifications capability)");
  rt.logs.entries.filter((e) => e.msg.startsWith("notify ")).forEach((e) => info(`🔔 ${e.msg.replace(/^notify /, "")}`));

  console.log("\n\x1b[1mDone — new app, same runtime, no new infrastructure.\x1b[0m");
}

main().catch((e) => {
  console.error("\x1b[31mFAILED:\x1b[0m", e);
  process.exit(1);
});

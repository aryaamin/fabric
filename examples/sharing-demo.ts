import {
  createWorkspace,
  createObject,
  share,
  createShareLink,
  disableShareLink,
  setPublic,
  resolveAccess,
  appUrl,
  embedSnippet,
  type WorkspaceObject,
  type Workspace,
} from "@fabric/workspace";
import { expenseTracker } from "./apps/expense-tracker.ts";

const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m# ${s}\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);

const BASE = "https://fabric.app";

/** Show what four different visitors get for this object right now. */
function report(ws: Workspace, obj: WorkspaceObject, token?: string) {
  const who = [
    { label: "owner (mona)", ctx: { principalId: "mona" } },
    { label: "invited viewer (finn)", ctx: { principalId: "finn" } },
    { label: "stranger, no link", ctx: { principalId: "rando" } },
    { label: "stranger WITH link", ctx: { principalId: "rando", token } },
  ];
  for (const w of who) {
    const role = resolveAccess(obj, w.ctx);
    info(`${w.label.padEnd(24)} → ${role ?? "\x1b[31mno access\x1b[0m"}`);
  }
}

function main() {
  const ws = createWorkspace("ws_acme", "Acme Inc");
  const obj = createObject(ws, { kind: "app", name: "Expense Tracker", ownerId: "mona", appId: expenseTracker.id, icon: "🧾" });

  h("1. A fresh app is Restricted — only the owner can open it");
  info(`URL: ${appUrl(BASE, ws, obj)}`);
  report(ws, obj);

  h('2. Invite a specific person (like typing an email → "viewer")');
  share(obj, "finn", "viewer");
  ok("finn was granted viewer");
  report(ws, obj);

  h('3. "Get link" → anyone with the link can VIEW');
  const link = createShareLink(BASE, ws, obj, "viewer");
  ok(`shareable link created:`);
  info(link);
  report(ws, obj, obj.shareToken);

  h("4. Upgrade the link to EDITOR (anyone with the link can edit)");
  const editLink = createShareLink(BASE, ws, obj, "editor");
  ok(`link now grants editor:`);
  info(editLink);
  report(ws, obj, obj.shareToken);

  h("5. Revoke: set back to Restricted (the old link stops working)");
  disableShareLink(obj, /* rotate token */ true);
  ok("link disabled + token rotated");
  report(ws, obj, /* old token no longer valid */ "stale-token");

  h('6. Publish to the web (anyone, no link needed — read-only)');
  setPublic(obj, true);
  ok("published");
  report(ws, obj);

  h("7. Embed it anywhere (iframe uses the link token)");
  const embedTok = createShareLink(BASE, ws, obj, "viewer"); // fresh link for embeds
  void embedTok;
  info(embedSnippet(BASE, ws, obj, obj.shareToken));

  console.log("\n\x1b[1mThat's the Google-Doc model: Restricted → invite → link (viewer/editor) → publish → embed.\x1b[0m");
}

main();

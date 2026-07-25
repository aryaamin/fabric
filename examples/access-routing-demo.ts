import {
  createWorkspace,
  createObject,
  createShareLink,
  setPublic,
  resolveAccess,
  surfaceForAccess,
  appUrl,
  type Surface,
  type WorkspaceObject,
  type Workspace,
} from "@fabric/workspace";
import { expenseTracker } from "./apps/expense-tracker.ts";

/**
 * "One link, three surfaces" — proof.
 *
 * A single object URL resolves to a DIFFERENT UI depending on the visitor's
 * access, and both the preview server (apps/server) and the studio (apps/studio)
 * make that decision through the SAME pure function, surfaceForAccess. This
 * script exercises every visitor kind and prints the surface each would land on,
 * so the routing can be verified without booting an HTTP server (curl is blocked
 * in the sandbox).
 */

const h = (s: string) => console.log(`\n\x1b[1m\x1b[36m# ${s}\x1b[0m`);
const info = (s: string) => console.log(`    ${s}`);

const BASE = "https://fabric.app";

const SURFACE_LABEL: Record<Surface, string> = {
  studio: "\x1b[35mSTUDIO\x1b[0m  (canvas + AI chat + toolbar — make)",
  run: "\x1b[32mRUN\x1b[0m     (running app only — use)",
  denied: "\x1b[31mDENIED\x1b[0m  (403 / lock screen)",
};

/** Print the surface each visitor archetype lands on for this object right now. */
function report(obj: WorkspaceObject) {
  const visitors: { label: string; ctx: { principalId?: string; token?: string }; embed?: boolean }[] = [
    { label: "owner (mona)", ctx: { principalId: "mona" } },
    { label: "link-holder (token, no grant)", ctx: { token: obj.shareToken } },
    { label: "stranger (no grant, no link)", ctx: { principalId: "rando" } },
    { label: "anonymous (nothing)", ctx: {} },
    { label: "embed <iframe> (with link)", ctx: { token: obj.shareToken }, embed: true },
  ];
  for (const v of visitors) {
    const role = resolveAccess(obj, v.ctx);
    const surface = surfaceForAccess(role, { embed: v.embed });
    info(`${v.label.padEnd(32)} role=${(role ?? "—").padEnd(7)} → ${SURFACE_LABEL[surface]}`);
  }
}

function main() {
  const ws: Workspace = createWorkspace("ws_acme", "Acme Inc");
  const obj = createObject(ws, { kind: "app", name: "Expense Tracker", ownerId: "mona", appId: expenseTracker.id, icon: "🧾" });
  info(`object URL: ${appUrl(BASE, ws, obj)}`);

  h("1. Restricted — only the owner (an explicit grant) gets in; everyone else DENIED");
  report(obj);

  h('2. "Anyone with the link" = VIEWER → the link opens the RUNNING app, not the editor');
  createShareLink(BASE, ws, obj, "viewer");
  report(obj);

  h('3. "Anyone with the link" = EDITOR → now link-holders land in the STUDIO');
  createShareLink(BASE, ws, obj, "editor");
  report(obj);

  h("4. Published to the web — anonymous visitors get the RUN surface (read-only)");
  setPublic(obj, true);
  report(obj);

  console.log("\n\x1b[1mSame link, three surfaces: editors/owners → studio, viewers/public → run, none → denied; embeds are always chromeless run.\x1b[0m");
}

main();

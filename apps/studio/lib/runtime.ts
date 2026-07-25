import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory, InMemoryDataStore, type DataStore } from "@fabric/storage";
import type { AppDocument } from "@fabric/ir";
import type { Principal } from "@fabric/permissions";
import { SEED_DOCS, SEED_ROWS } from "./seed-apps";

/**
 * Server-side Runtime singleton for the studio.
 *
 * In production this is not a process global but a multi-tenant host keyed by
 * workspace, with storage backed by Neon and events by a durable queue. The
 * capability *set* is identical to the demo — that is the whole point: dev,
 * preview and prod differ only in which adapters back each capability.
 *
 * Two studio-specific decisions live here:
 *
 * 1. **Stores are memoized per namespace.** The reference storage factory hands
 *    out a fresh in-memory store per installation, which is right for a script
 *    but wrong for a live editor: every conversational edit re-installs the app,
 *    and the user's rows must survive their own edit. `env.namespace` is stable
 *    across re-installs of the same app instance, so keying on it makes data
 *    outlive the document that shaped it — exactly the property that makes
 *    "edit a running app" feel like editing a document rather than redeploying.
 *
 * 2. **The workspace is seeded on first touch**, so the demo boots with four
 *    installed apps, real rows, and an event chain that has already fired.
 */

declare global {
  // eslint-disable-next-line no-var
  var __fabricRuntime: Runtime | undefined;
  // eslint-disable-next-line no-var
  var __fabricStores: Map<string, DataStore> | undefined;
  // eslint-disable-next-line no-var
  var __fabricSeeded: Promise<void> | undefined;
}

export const WORKSPACE_ID = "ws_acme";

/** The principal the studio acts as (the signed-in owner of the workspace). */
export const OWNER_PRINCIPAL: Principal = { id: "u_owner", roles: ["owner"] };

/**
 * A shared-link viewer. Object access decided they may open the app; their
 * in-app authority is the read-only `guest` role every seed app declares. This
 * is the two-planes rule made concrete in one line.
 */
export const GUEST_PRINCIPAL: Principal = { id: "u_guest", roles: ["guest"] };

function stores(): Map<string, DataStore> {
  globalThis.__fabricStores ??= new Map();
  return globalThis.__fabricStores;
}

function createRuntime(): Runtime {
  const rt = new Runtime();
  rt.registry.register(
    storageCapabilityFactory((env) => {
      const key = env.namespace ?? "default";
      let store = stores().get(key);
      if (!store) {
        store = new InMemoryDataStore();
        stores().set(key, store);
      }
      return store;
    }),
  );
  rt.registry.register(notificationsCapabilityFactory());
  // The AI capability would be wired to the Vercel AI Gateway here.
  rt.registry.register(aiCapabilityFactory());
  return rt;
}

export function getRuntime(): Runtime {
  globalThis.__fabricRuntime ??= createRuntime();
  return globalThis.__fabricRuntime;
}

/**
 * Install the seed apps and their sample rows exactly once per process.
 * Idempotent and safe to await from any request path (pages included).
 */
export function ensureRuntime(): Promise<void> {
  globalThis.__fabricSeeded ??= seed();
  return globalThis.__fabricSeeded;
}

async function seed(): Promise<void> {
  const rt = getRuntime();
  for (const doc of SEED_DOCS) {
    if (!rt.installed(doc.id)) {
      rt.install(doc, { workspaceId: WORKSPACE_ID, author: "u_owner", message: `created ${doc.name}` });
    }
  }
  for (const row of SEED_ROWS) {
    try {
      await rt.invokeAction(row.appId, row.action, row.args, OWNER_PRINCIPAL);
    } catch {
      // Seeding is best-effort: a demo row must never keep the studio from
      // booting. A failure here shows up as an empty table, not a 500.
    }
  }
}

/** The installed document for an app, after seeding. */
export async function installedDoc(appId: string): Promise<AppDocument | undefined> {
  await ensureRuntime();
  return getRuntime().installed(appId);
}

/** The first view of an app — what the canvas shows by default. */
export function primaryView(doc: AppDocument): string | undefined {
  return doc.views[0]?.name;
}

/** Size of a document on the wire, the honest measure of an app's footprint. */
export function irBytes(doc: AppDocument): number {
  return Buffer.byteLength(JSON.stringify(doc), "utf8");
}

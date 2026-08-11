import { Runtime, notificationsCapabilityFactory, aiCapabilityFactory } from "@fabric/runtime";
import { createSlackWebhookTransport } from "@fabric/integrations";
import {
  storageCapabilityFactory,
  InMemoryDataStore,
  PostgresDataStore,
  type DataStore,
} from "@fabric/storage";
import type { AppDocument } from "@fabric/ir";
import type { Principal } from "@fabric/permissions";
import {
  PostgresVersionRepository,
  type CommitInput,
  type VersionRepository,
} from "@fabric/versioning";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";
import { hasDurableQueue, publishFabricEvent } from "./queue";
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
  var __fabricRuntimes: Map<string, Runtime> | undefined;
  // eslint-disable-next-line no-var
  var __fabricStores: Map<string, DataStore> | undefined;
  // eslint-disable-next-line no-var
  var __fabricSeeded: Map<string, Promise<void>> | undefined;
}

export const WORKSPACE_ID = "ws_acme";
export const STUDIO_INSTANCE_ID = "primary";

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
  const rt = new Runtime({ connectEvents: !hasDurableQueue() });
  if (hasDurableDatabase()) rt.bus.addSink(publishFabricEvent);
  rt.registry.register(
    storageCapabilityFactory((env) => {
      const key = env.namespace ?? "default";
      if (hasDurableDatabase()) {
        return new PostgresDataStore(getDatabaseExecutor(), key);
      }
      let store = stores().get(key);
      if (!store) {
        store = new InMemoryDataStore();
        stores().set(key, store);
      }
      return store;
    }),
  );
  const slackWebhook = process.env.SLACK_WEBHOOK_URL;
  rt.registry.register(
    notificationsCapabilityFactory(
      slackWebhook ? createSlackWebhookTransport(slackWebhook) : undefined,
    ),
  );
  // The AI capability would be wired to the Vercel AI Gateway here.
  rt.registry.register(aiCapabilityFactory());
  return rt;
}

export function durableVersionRepository(): VersionRepository | null {
  return hasDurableDatabase()
    ? new PostgresVersionRepository(getDatabaseExecutor())
    : null;
}

export async function persistVersion(
  workspaceId: string,
  input: CommitInput,
): Promise<void> {
  const repository = durableVersionRepository();
  if (!repository) return;
  const version = await repository.commit(workspaceId, input);
  const sql = getDatabaseExecutor();
  await sql(
    "DELETE FROM connection_routes WHERE workspace_id = $1 AND target_app_id = $2",
    [workspaceId, input.appId],
  );
  for (const subscription of input.doc.subscriptions) {
    const pattern = subscription.on.includes(".")
      ? subscription.on
      : `${input.appId}.${subscription.on}`;
    await sql(
      `INSERT INTO connection_routes
        (id, workspace_id, target_app_id, pattern, action, input_map, head_version_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        `route_${crypto.randomUUID()}`,
        workspaceId,
        input.appId,
        pattern,
        subscription.run,
        JSON.stringify(subscription.map ?? {}),
        version.id,
      ],
    );
  }
}

export function getRuntime(workspaceId = WORKSPACE_ID): Runtime {
  globalThis.__fabricRuntimes ??= new Map();
  let runtime = globalThis.__fabricRuntimes.get(workspaceId);
  if (!runtime) {
    runtime = createRuntime();
    globalThis.__fabricRuntimes.set(workspaceId, runtime);
  }
  return runtime;
}

/**
 * Install the seed apps and their sample rows exactly once per process.
 * Idempotent and safe to await from any request path (pages included).
 */
export function ensureRuntime(
  workspaceId = WORKSPACE_ID,
  ownerId = OWNER_PRINCIPAL.id,
): Promise<void> {
  globalThis.__fabricSeeded ??= new Map();
  let pending = globalThis.__fabricSeeded.get(workspaceId);
  if (!pending) {
    pending = seed(workspaceId, ownerId);
    globalThis.__fabricSeeded.set(workspaceId, pending);
  }
  return pending;
}

async function seed(workspaceId: string, ownerId: string): Promise<void> {
  const rt = getRuntime(workspaceId);
  const owner: Principal = { id: ownerId, roles: ["owner"] };
  const repository = durableVersionRepository();
  const heads = (await repository?.listHeads(workspaceId)) ?? [];
  for (const version of heads) {
    rt.install(version.doc, {
      workspaceId,
      instanceId: STUDIO_INSTANCE_ID,
      author: version.author,
      message: version.message,
    });
  }
  for (const doc of SEED_DOCS) {
    if (!rt.installed(doc.id)) {
      const installed = rt.install(doc, {
        workspaceId,
        instanceId: STUDIO_INSTANCE_ID,
        author: ownerId,
        message: `created ${doc.name}`,
      });
      await persistVersion(workspaceId, {
        appId: doc.id,
        doc,
        author: ownerId,
        message: `created ${doc.name}`,
      });
    }
  }
  for (const row of hasDurableDatabase() ? [] : SEED_ROWS) {
    try {
      await rt.invokeAction(row.appId, row.action, row.args, owner);
    } catch {
      // Seeding is best-effort: a demo row must never keep the studio from
      // booting. A failure here shows up as an empty table, not a 500.
    }
  }
}

/** The installed document for an app, after seeding. */
export async function installedDoc(
  appId: string,
  workspaceId = WORKSPACE_ID,
): Promise<AppDocument | undefined> {
  await ensureRuntime(workspaceId);
  return getRuntime(workspaceId).installed(appId);
}

/** The first view of an app — what the canvas shows by default. */
export function primaryView(doc: AppDocument): string | undefined {
  return doc.views[0]?.name;
}

/** Size of a document on the wire, the honest measure of an app's footprint. */
export function irBytes(doc: AppDocument): number {
  return Buffer.byteLength(JSON.stringify(doc), "utf8");
}

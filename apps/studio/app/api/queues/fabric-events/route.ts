import { handleCallback } from "@vercel/queue";
import type { FabricEvent } from "@fabric/events";
import { evaluate } from "@fabric/interpreter";
import type { Expr } from "@fabric/ir";
import { getDatabaseExecutor } from "../../../../lib/database";
import { ensureRuntime, getRuntime } from "../../../../lib/runtime";

interface ConnectionRoute extends Record<string, unknown> {
  id: string;
  target_app_id: string;
  pattern: string;
  action: string;
  input_map: Record<string, unknown> | string;
}

export const POST = handleCallback<FabricEvent>(
  async (event, metadata) => {
    const sql = getDatabaseExecutor();
    const key = `${event.source}.${event.name}`;
    const routes = await sql<ConnectionRoute>(
      `SELECT id, target_app_id, pattern, action, input_map
       FROM connection_routes
       WHERE workspace_id = $1`,
      [event.workspaceId],
    );
    await ensureRuntime(event.workspaceId, "system");
    const runtime = getRuntime(event.workspaceId);

    for (const route of routes.filter((candidate) => matches(candidate.pattern, key))) {
      const idempotencyKey = `${event.id}:${route.id}`;
      const completed = await sql<{ idempotency_key: string }>(
        `SELECT idempotency_key
         FROM processed_deliveries
         WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (completed[0]) continue;

      const inputMap =
        typeof route.input_map === "string"
          ? (JSON.parse(route.input_map) as Record<string, unknown>)
          : route.input_map;
      const args: Record<string, unknown> = {};
      if (Object.keys(inputMap).length > 0) {
        for (const [name, expression] of Object.entries(inputMap)) {
          args[name] = evaluate(expression as Expr, {
            event: event.payload,
            source: event.source,
          });
        }
      } else if (event.payload && typeof event.payload === "object") {
        Object.assign(args, event.payload);
      }
      args.__fabricEventId = event.id;

      await runtime.invokeAction(route.target_app_id, route.action, args, {
        id: "system",
        roles: ["owner"],
      });
      await sql(
        `INSERT INTO processed_deliveries
          (idempotency_key, event_id, target_app_id, action)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [idempotencyKey, event.id, route.target_app_id, route.action],
      );
    }

    console.info("[fabric-queue] processed event", {
      eventId: event.id,
      deliveryCount: metadata.deliveryCount,
      routes: routes.length,
    });
  },
  {
    visibilityTimeoutSeconds: 300,
    retry: (_error, metadata) =>
      metadata.deliveryCount > 5
        ? { acknowledge: true }
        : { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) },
  },
);

function matches(pattern: string, key: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}

import { send } from "@vercel/queue";
import type { FabricEvent } from "@fabric/events";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";

export const FABRIC_EVENTS_TOPIC = "fabric-events";

export function hasDurableQueue(): boolean {
  return Boolean(
    hasDurableDatabase() &&
      (process.env.VERCEL || process.env.VERCEL_QUEUE_API_TOKEN),
  );
}

export async function publishFabricEvent(event: FabricEvent): Promise<void> {
  if (!hasDurableDatabase()) return;
  const sql = getDatabaseExecutor();
  await sql(
    `WITH persisted AS (
       INSERT INTO fabric_events
         (id, workspace_id, source, name, payload, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     )
     INSERT INTO event_outbox (event_id, payload)
     SELECT id, $8::jsonb FROM persisted
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.id,
      event.workspaceId,
      event.source,
      event.name,
      JSON.stringify(event.payload ?? null),
      event.causationId ?? null,
      event.at,
      JSON.stringify(event),
    ],
  );
  if (hasDurableQueue()) {
    await deliver(event.id, event);
    await flushEventOutbox(20);
  }
}

export async function flushEventOutbox(limit = 50): Promise<number> {
  if (!hasDurableQueue()) return 0;
  const sql = getDatabaseExecutor();
  const pending = await sql<{ event_id: string; payload: FabricEvent | string }>(
    `SELECT event_id, payload
     FROM event_outbox
     WHERE published_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  let delivered = 0;
  for (const row of pending) {
    const event =
      typeof row.payload === "string"
        ? (JSON.parse(row.payload) as FabricEvent)
        : row.payload;
    if (await deliver(row.event_id, event)) delivered += 1;
  }
  return delivered;
}

async function deliver(eventId: string, event: FabricEvent): Promise<boolean> {
  const sql = getDatabaseExecutor();
  try {
    await send(FABRIC_EVENTS_TOPIC, event, {
      idempotencyKey: eventId,
      retentionSeconds: 86_400,
    });
    await sql(
      `UPDATE event_outbox
       SET published_at = NOW(), attempts = attempts + 1, last_error = NULL
       WHERE event_id = $1`,
      [eventId],
    );
    return true;
  } catch (error) {
    await sql(
      `UPDATE event_outbox
       SET attempts = attempts + 1, last_error = $2
       WHERE event_id = $1`,
      [eventId, error instanceof Error ? error.message : String(error)],
    );
    return false;
  }
}

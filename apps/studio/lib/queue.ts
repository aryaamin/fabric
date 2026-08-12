import { send } from "@vercel/queue";
import type { FabricEvent } from "@fabric/events";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";

export const FABRIC_EVENTS_TOPIC = "fabric-events";
export const FABRIC_BUILDS_TOPIC = "fabric-builds";
export const FABRIC_DEPLOYMENTS_TOPIC = "fabric-deployments";

export interface CloudBuildMessage {
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  buildId: string;
}

export interface CloudDeploymentMessage {
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  buildId: string;
  deploymentId: string;
  idempotencyKey: string;
}

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

export async function publishCloudBuild(message: CloudBuildMessage): Promise<boolean> {
  if (!hasDurableDatabase()) return false;
  const sql = getDatabaseExecutor();
  await sql(
    `INSERT INTO cloud_dispatch_outbox
      (workspace_id, operation_type, operation_id, payload)
     VALUES ($1, 'build', $2, $3::jsonb)
     ON CONFLICT (workspace_id, operation_type, operation_id) DO NOTHING`,
    [message.workspaceId, message.buildId, JSON.stringify(message)],
  );
  return hasDurableQueue() ? deliverCloudBuild(message) : false;
}

export async function flushCloudBuildOutbox(limit = 50): Promise<number> {
  if (!hasDurableQueue()) return 0;
  const rows = await getDatabaseExecutor()<{
    payload: CloudBuildMessage | string;
  }>(
    `SELECT payload
     FROM cloud_dispatch_outbox
     WHERE operation_type = 'build' AND published_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  let delivered = 0;
  for (const row of rows) {
    const message =
      typeof row.payload === "string"
        ? (JSON.parse(row.payload) as CloudBuildMessage)
        : row.payload;
    if (await deliverCloudBuild(message)) delivered += 1;
  }
  return delivered;
}

export async function publishCloudDeployment(
  message: CloudDeploymentMessage,
): Promise<boolean> {
  if (!hasDurableDatabase()) return false;
  const sql = getDatabaseExecutor();
  await sql(
    `INSERT INTO cloud_dispatch_outbox
      (workspace_id, operation_type, operation_id, payload)
     VALUES ($1, 'deployment', $2, $3::jsonb)
     ON CONFLICT (workspace_id, operation_type, operation_id) DO NOTHING`,
    [message.workspaceId, message.deploymentId, JSON.stringify(message)],
  );
  return hasDurableQueue() ? deliverCloudDeployment(message) : false;
}

export async function flushCloudDeploymentOutbox(limit = 50): Promise<number> {
  if (!hasDurableQueue()) return 0;
  const rows = await getDatabaseExecutor()<{
    payload: CloudDeploymentMessage | string;
  }>(
    `SELECT payload
     FROM cloud_dispatch_outbox
     WHERE operation_type = 'deployment' AND published_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  let delivered = 0;
  for (const row of rows) {
    const message =
      typeof row.payload === "string"
        ? (JSON.parse(row.payload) as CloudDeploymentMessage)
        : row.payload;
    if (await deliverCloudDeployment(message)) delivered += 1;
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

async function deliverCloudBuild(message: CloudBuildMessage): Promise<boolean> {
  const sql = getDatabaseExecutor();
  try {
    await send(FABRIC_BUILDS_TOPIC, message, {
      idempotencyKey: message.buildId,
      retentionSeconds: 86_400,
    });
    await sql(
      `UPDATE cloud_dispatch_outbox
       SET published_at = NOW(), attempts = attempts + 1, last_error = NULL
       WHERE workspace_id = $1 AND operation_type = 'build' AND operation_id = $2`,
      [message.workspaceId, message.buildId],
    );
    return true;
  } catch (error) {
    await sql(
      `UPDATE cloud_dispatch_outbox
       SET attempts = attempts + 1, last_error = $3
       WHERE workspace_id = $1 AND operation_type = 'build' AND operation_id = $2`,
      [
        message.workspaceId,
        message.buildId,
        error instanceof Error ? error.message : String(error),
      ],
    );
    return false;
  }
}

async function deliverCloudDeployment(message: CloudDeploymentMessage): Promise<boolean> {
  const sql = getDatabaseExecutor();
  try {
    await send(FABRIC_DEPLOYMENTS_TOPIC, message, {
      idempotencyKey: message.deploymentId,
      retentionSeconds: 86_400,
    });
    await sql(
      `UPDATE cloud_dispatch_outbox
       SET published_at = NOW(), attempts = attempts + 1, last_error = NULL
       WHERE workspace_id = $1 AND operation_type = 'deployment' AND operation_id = $2`,
      [message.workspaceId, message.deploymentId],
    );
    return true;
  } catch (error) {
    await sql(
      `UPDATE cloud_dispatch_outbox
       SET attempts = attempts + 1, last_error = $3
       WHERE workspace_id = $1 AND operation_type = 'deployment' AND operation_id = $2`,
      [
        message.workspaceId,
        message.deploymentId,
        error instanceof Error ? error.message : String(error),
      ],
    );
    return false;
  }
}

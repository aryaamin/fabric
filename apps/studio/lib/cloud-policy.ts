import { randomUUID } from "node:crypto";
import {
  parseExecutionPolicy,
  quotaViolation,
  type FabricExecutionPolicy,
  type QuotaOperation,
  type WorkspaceUsage,
} from "@fabric/cloud";
import { getDatabaseExecutor, hasDurableDatabase } from "./database.ts";

export type UsageKind =
  | "snapshot_bytes"
  | "build_requested"
  | "deployment_requested"
  | "runtime_request";

export interface WorkspaceCloudStatus {
  policy: FabricExecutionPolicy;
  usage: WorkspaceUsage;
  suspended: boolean;
  suspensionReason?: string;
}

interface MemoryUsageEvent {
  workspaceId: string;
  projectId?: string;
  kind: UsageKind;
  units: number;
  idempotencyKey: string;
  createdAt: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __fabricUsageEvents: MemoryUsageEvent[] | undefined;
  // eslint-disable-next-line no-var
  var __fabricSuspendedWorkspaces:
    | Map<string, { reason?: string }>
    | undefined;
  // eslint-disable-next-line no-var
  var __fabricSuspendedProjects:
    | Map<string, { reason?: string }>
    | undefined;
  // eslint-disable-next-line no-var
  var __fabricRuntimeLeases:
    | Map<string, { workspaceId: string; projectId: string; expiresAt: number }>
    | undefined;
}

export function fabricExecutionPolicy(): FabricExecutionPolicy {
  return parseExecutionPolicy(process.env);
}

export async function workspaceCloudStatus(
  workspaceId: string,
): Promise<WorkspaceCloudStatus> {
  const policy = fabricExecutionPolicy();
  if (!hasDurableDatabase()) {
    const events = (globalThis.__fabricUsageEvents ?? []).filter(
      (event) => event.workspaceId === workspaceId,
    );
    const hourAgo = Date.now() - 60 * 60_000;
    const suspension = globalThis.__fabricSuspendedWorkspaces?.get(workspaceId);
    return {
      policy,
      usage: {
        buildsLastHour: events.filter(
          (event) =>
            event.kind === "build_requested" &&
            new Date(event.createdAt).getTime() >= hourAgo,
        ).length,
        deploymentsLastHour: events.filter(
          (event) =>
            event.kind === "deployment_requested" &&
            new Date(event.createdAt).getTime() >= hourAgo,
        ).length,
        concurrentBuilds: 0,
        snapshotBytes: events
          .filter((event) => event.kind === "snapshot_bytes")
          .reduce((total, event) => total + event.units, 0),
      },
      suspended: Boolean(suspension),
      ...(suspension?.reason ? { suspensionReason: suspension.reason } : {}),
    };
  }
  const rows = await getDatabaseExecutor()<{
    builds_last_hour: number | string;
    deployments_last_hour: number | string;
    concurrent_builds: number | string;
    snapshot_bytes: number | string;
    suspended_at: string | Date | null;
    suspension_reason: string | null;
  }>(
    `SELECT
       (SELECT count(*) FROM usage_events
        WHERE workspace_id = $1 AND kind = 'build_requested'
          AND created_at >= NOW() - INTERVAL '1 hour') AS builds_last_hour,
       (SELECT count(*) FROM usage_events
        WHERE workspace_id = $1 AND kind = 'deployment_requested'
          AND created_at >= NOW() - INTERVAL '1 hour') AS deployments_last_hour,
       (SELECT count(*) FROM builds
        WHERE workspace_id = $1 AND state IN ('QUEUED', 'RUNNING')) AS concurrent_builds,
       (SELECT COALESCE(sum(units), 0) FROM usage_events
        WHERE workspace_id = $1 AND kind = 'snapshot_bytes') AS snapshot_bytes,
       p.suspended_at,
       p.suspension_reason
     FROM (SELECT 1) seed
     LEFT JOIN workspace_cloud_policies p ON p.workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0]!;
  return {
    policy,
    usage: {
      buildsLastHour: Number(row.builds_last_hour),
      deploymentsLastHour: Number(row.deployments_last_hour),
      concurrentBuilds: Number(row.concurrent_builds),
      snapshotBytes: Number(row.snapshot_bytes),
    },
    suspended: Boolean(row.suspended_at),
    ...(row.suspension_reason
      ? { suspensionReason: row.suspension_reason }
      : {}),
  };
}

export async function claimWorkspaceQuota(input: {
  workspaceId: string;
  projectId?: string;
  operation: QuotaOperation;
  units?: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  policy?: FabricExecutionPolicy;
}): Promise<WorkspaceCloudStatus> {
  const units = input.units ?? 1;
  if (await usageClaimExists(input.workspaceId, usageKind(input.operation), input.idempotencyKey)) {
    return workspaceCloudStatus(input.workspaceId);
  }
  const status = await workspaceCloudStatus(input.workspaceId);
  const policy = input.policy ?? status.policy;
  if (status.suspended) {
    throw new Error(
      `workspace_suspended: ${status.suspensionReason ?? "cloud operations are paused"}`,
    );
  }
  if (input.projectId) {
    const projectSuspension = await projectSuspensionStatus(
      input.workspaceId,
      input.projectId,
    );
    if (projectSuspension.suspended) {
      throw new Error(
        `project_suspended: ${projectSuspension.reason ?? "cloud operations are paused"}`,
      );
    }
  }
  const workspaceViolation = quotaViolation(
    status.policy.quota,
    status.usage,
    input.operation,
    units,
  );
  if (workspaceViolation) {
    throw new Error(
      `quota_exceeded: ${workspaceViolation.limit} (${workspaceViolation.used}/${workspaceViolation.maximum})`,
    );
  }
  if (input.policy && input.projectId && input.operation !== "snapshot") {
    const projectUsage = await projectCloudUsage(input.workspaceId, input.projectId);
    const projectViolation = quotaViolation(
      input.policy.quota,
      projectUsage,
      input.operation,
      units,
    );
    if (projectViolation) {
      throw new Error(
        `quota_exceeded: project ${projectViolation.limit} (${projectViolation.used}/${projectViolation.maximum})`,
      );
    }
  }
  await recordUsage({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    kind: usageKind(input.operation),
    units,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata,
  });
  return { ...(await workspaceCloudStatus(input.workspaceId)), policy };
}

export async function projectCloudUsage(
  workspaceId: string,
  projectId: string,
): Promise<WorkspaceUsage> {
  if (!hasDurableDatabase()) {
    const events = (globalThis.__fabricUsageEvents ?? []).filter(
      (event) =>
        event.workspaceId === workspaceId && event.projectId === projectId,
    );
    const hourAgo = Date.now() - 60 * 60_000;
    return {
      buildsLastHour: events.filter(
        (event) =>
          event.kind === "build_requested" &&
          new Date(event.createdAt).getTime() >= hourAgo,
      ).length,
      deploymentsLastHour: events.filter(
        (event) =>
          event.kind === "deployment_requested" &&
          new Date(event.createdAt).getTime() >= hourAgo,
      ).length,
      concurrentBuilds: 0,
      snapshotBytes: events
        .filter((event) => event.kind === "snapshot_bytes")
        .reduce((total, event) => total + event.units, 0),
    };
  }
  const rows = await getDatabaseExecutor()<{
    builds_last_hour: number | string;
    deployments_last_hour: number | string;
    concurrent_builds: number | string;
    snapshot_bytes: number | string;
  }>(
    `SELECT
       (SELECT count(*) FROM usage_events
        WHERE workspace_id = $1 AND project_id = $2 AND kind = 'build_requested'
          AND created_at >= NOW() - INTERVAL '1 hour') AS builds_last_hour,
       (SELECT count(*) FROM usage_events
        WHERE workspace_id = $1 AND project_id = $2 AND kind = 'deployment_requested'
          AND created_at >= NOW() - INTERVAL '1 hour') AS deployments_last_hour,
       (SELECT count(*) FROM builds
        WHERE workspace_id = $1 AND project_id = $2
          AND state IN ('QUEUED', 'RUNNING')) AS concurrent_builds,
       (SELECT COALESCE(sum(units), 0) FROM usage_events
        WHERE workspace_id = $1 AND project_id = $2 AND kind = 'snapshot_bytes') AS snapshot_bytes`,
    [workspaceId, projectId],
  );
  const row = rows[0]!;
  return {
    buildsLastHour: Number(row.builds_last_hour),
    deploymentsLastHour: Number(row.deployments_last_hour),
    concurrentBuilds: Number(row.concurrent_builds),
    snapshotBytes: Number(row.snapshot_bytes),
  };
}

async function usageClaimExists(
  workspaceId: string,
  kind: UsageKind,
  idempotencyKey: string,
): Promise<boolean> {
  if (!hasDurableDatabase()) {
    return (globalThis.__fabricUsageEvents ?? []).some(
      (event) =>
        event.workspaceId === workspaceId &&
        event.kind === kind &&
        event.idempotencyKey === idempotencyKey,
    );
  }
  const rows = await getDatabaseExecutor()<{ found: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM usage_events
       WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3
     ) AS found`,
    [workspaceId, kind, idempotencyKey],
  );
  return Boolean(rows[0]?.found);
}

export async function setWorkspaceSuspended(input: {
  workspaceId: string;
  suspended: boolean;
  principalId: string;
  reason?: string;
}): Promise<void> {
  if (!hasDurableDatabase()) {
    globalThis.__fabricSuspendedWorkspaces ??= new Map();
    if (input.suspended) {
      globalThis.__fabricSuspendedWorkspaces.set(input.workspaceId, {
        ...(input.reason ? { reason: input.reason } : {}),
      });
    } else {
      globalThis.__fabricSuspendedWorkspaces.delete(input.workspaceId);
    }
    return;
  }
  await getDatabaseExecutor()(
    `INSERT INTO workspace_cloud_policies
       (workspace_id, suspended_at, suspended_by, suspension_reason, updated_at)
     VALUES ($1, CASE WHEN $2 THEN NOW() ELSE NULL END, $3, $4, NOW())
     ON CONFLICT (workspace_id) DO UPDATE SET
       suspended_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
       suspended_by = CASE WHEN $2 THEN $3 ELSE NULL END,
       suspension_reason = CASE WHEN $2 THEN $4 ELSE NULL END,
       updated_at = NOW()`,
    [
      input.workspaceId,
      input.suspended,
      input.principalId,
      input.reason ?? null,
    ],
  );
}

export async function projectSuspensionStatus(
  workspaceId: string,
  projectId: string,
): Promise<{ suspended: boolean; reason?: string }> {
  if (!hasDurableDatabase()) {
    const suspension = globalThis.__fabricSuspendedProjects?.get(
      `${workspaceId}\0${projectId}`,
    );
    return {
      suspended: Boolean(suspension),
      ...(suspension?.reason ? { reason: suspension.reason } : {}),
    };
  }
  const rows = await getDatabaseExecutor()<{
    suspended_at: string | Date | null;
    suspension_reason: string | null;
  }>(
    `SELECT suspended_at, suspension_reason
     FROM project_cloud_policies
     WHERE workspace_id = $1 AND project_id = $2`,
    [workspaceId, projectId],
  );
  return {
    suspended: Boolean(rows[0]?.suspended_at),
    ...(rows[0]?.suspension_reason
      ? { reason: rows[0].suspension_reason }
      : {}),
  };
}

export async function setProjectSuspended(input: {
  workspaceId: string;
  projectId: string;
  suspended: boolean;
  principalId: string;
  reason?: string;
}): Promise<void> {
  if (!hasDurableDatabase()) {
    globalThis.__fabricSuspendedProjects ??= new Map();
    const key = `${input.workspaceId}\0${input.projectId}`;
    if (input.suspended) {
      globalThis.__fabricSuspendedProjects.set(key, {
        ...(input.reason ? { reason: input.reason } : {}),
      });
    } else {
      globalThis.__fabricSuspendedProjects.delete(key);
    }
    return;
  }
  await getDatabaseExecutor()(
    `INSERT INTO project_cloud_policies
       (workspace_id, project_id, suspended_at, suspended_by, suspension_reason, updated_at)
     VALUES ($1, $2, CASE WHEN $3 THEN NOW() ELSE NULL END, $4, $5, NOW())
     ON CONFLICT (workspace_id, project_id) DO UPDATE SET
       suspended_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
       suspended_by = CASE WHEN $3 THEN $4 ELSE NULL END,
       suspension_reason = CASE WHEN $3 THEN $5 ELSE NULL END,
       updated_at = NOW()`,
    [
      input.workspaceId,
      input.projectId,
      input.suspended,
      input.principalId,
      input.reason ?? null,
    ],
  );
}

export async function beginRuntimeInvocation(input: {
  workspaceId: string;
  projectId: string;
  policy?: FabricExecutionPolicy;
}): Promise<{ release: () => Promise<void>; policy: FabricExecutionPolicy }> {
  const status = await workspaceCloudStatus(input.workspaceId);
  const policy = input.policy ?? status.policy;
  if (status.suspended) {
    throw new Error(
      `workspace_suspended: ${status.suspensionReason ?? "cloud operations are paused"}`,
    );
  }
  const project = await projectSuspensionStatus(input.workspaceId, input.projectId);
  if (project.suspended) {
    throw new Error(
      `project_suspended: ${project.reason ?? "cloud operations are paused"}`,
    );
  }
  const invocationId = `run_${randomUUID()}`;
  const expiresAt = Date.now() + policy.runtime.maxDurationMs + 5_000;
  if (!hasDurableDatabase()) {
    globalThis.__fabricRuntimeLeases ??= new Map();
    for (const [id, lease] of globalThis.__fabricRuntimeLeases) {
      if (lease.expiresAt <= Date.now()) globalThis.__fabricRuntimeLeases.delete(id);
    }
    const active = [...globalThis.__fabricRuntimeLeases.values()].filter(
      (lease) =>
        lease.workspaceId === input.workspaceId &&
        lease.projectId === input.projectId,
    ).length;
    const minuteAgo = Date.now() - 60_000;
    const requests = (globalThis.__fabricUsageEvents ?? []).filter(
      (event) =>
        event.workspaceId === input.workspaceId &&
        event.projectId === input.projectId &&
        event.kind === "runtime_request" &&
        new Date(event.createdAt).getTime() >= minuteAgo,
    ).length;
    assertRuntimeCapacity(policy, active, requests);
    globalThis.__fabricRuntimeLeases.set(invocationId, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      expiresAt,
    });
  } else {
    const sql = getDatabaseExecutor();
    await sql(
      `DELETE FROM runtime_leases
       WHERE workspace_id = $1 AND project_id = $2 AND expires_at <= NOW()`,
      [input.workspaceId, input.projectId],
    );
    const rows = await sql<{
      active: number | string;
      requests: number | string;
    }>(
      `SELECT
         (SELECT count(*) FROM runtime_leases
          WHERE workspace_id = $1 AND project_id = $2 AND expires_at > NOW()) AS active,
         (SELECT count(*) FROM usage_events
          WHERE workspace_id = $1 AND project_id = $2 AND kind = 'runtime_request'
            AND created_at >= NOW() - INTERVAL '1 minute') AS requests`,
      [input.workspaceId, input.projectId],
    );
    assertRuntimeCapacity(
      policy,
      Number(rows[0]?.active ?? 0),
      Number(rows[0]?.requests ?? 0),
    );
    await sql(
      `INSERT INTO runtime_leases (id, workspace_id, project_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [invocationId, input.workspaceId, input.projectId, new Date(expiresAt).toISOString()],
    );
  }
  await recordUsage({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    kind: "runtime_request",
    units: 1,
    idempotencyKey: invocationId,
  });
  return {
    policy,
    release: async () => {
      if (!hasDurableDatabase()) {
        globalThis.__fabricRuntimeLeases?.delete(invocationId);
        return;
      }
      await getDatabaseExecutor()(`DELETE FROM runtime_leases WHERE id = $1`, [
        invocationId,
      ]);
    },
  };
}

async function recordUsage(input: {
  workspaceId: string;
  projectId?: string;
  kind: UsageKind;
  units: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!hasDurableDatabase()) {
    globalThis.__fabricUsageEvents ??= [];
    const duplicate = globalThis.__fabricUsageEvents.some(
      (event) =>
        event.workspaceId === input.workspaceId &&
        event.kind === input.kind &&
        event.idempotencyKey === input.idempotencyKey,
    );
    if (!duplicate) {
      globalThis.__fabricUsageEvents.push({
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        kind: input.kind,
        units: input.units,
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date().toISOString(),
      });
    }
    return;
  }
  await getDatabaseExecutor()(
    `INSERT INTO usage_events
       (id, workspace_id, project_id, kind, units, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (workspace_id, kind, idempotency_key) DO NOTHING`,
    [
      `use_${randomUUID()}`,
      input.workspaceId,
      input.projectId ?? null,
      input.kind,
      input.units,
      input.idempotencyKey,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

function usageKind(operation: QuotaOperation): UsageKind {
  if (operation === "build") return "build_requested";
  if (operation === "deployment") return "deployment_requested";
  return "snapshot_bytes";
}

function assertRuntimeCapacity(
  policy: FabricExecutionPolicy,
  active: number,
  requestsLastMinute: number,
): void {
  if (active >= policy.runtime.maxConcurrency) {
    throw new Error(
      `runtime_concurrency_limited: maximum ${policy.runtime.maxConcurrency} concurrent requests`,
    );
  }
  if (requestsLastMinute >= policy.runtime.maxRequestsPerMinute) {
    throw new Error(
      `runtime_rate_limited: maximum ${policy.runtime.maxRequestsPerMinute} requests per minute`,
    );
  }
}

import type { SchemaMigrationPlan } from "@fabric/projects";
import { getDatabaseExecutor, hasDurableDatabase } from "./database.ts";

export interface SchemaMigrationReview {
  workspaceId: string;
  projectId: string;
  planId: string;
  plan: SchemaMigrationPlan;
  state: "approved" | "sealed";
  approvedBy: string;
  approvalReason?: string;
  approvedAt: string;
  sealedSnapshotId?: string;
  sealedAt?: string;
}

interface ReviewRow extends Record<string, unknown> {
  workspace_id: string;
  project_id: string;
  plan_id: string;
  plan: SchemaMigrationPlan | string;
  state: SchemaMigrationReview["state"];
  approved_by: string;
  approval_reason: string | null;
  approved_at: string | Date;
  sealed_snapshot_id: string | null;
  sealed_at: string | Date | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __fabricSchemaMigrationReviews:
    | Map<string, SchemaMigrationReview>
    | undefined;
}

export async function approveSchemaMigration(input: {
  workspaceId: string;
  projectId: string;
  plan: SchemaMigrationPlan;
  principalId: string;
  reason?: string;
}): Promise<SchemaMigrationReview> {
  if (!input.plan.approvalRequired || input.plan.classification !== "destructive") {
    throw new Error("schema_approval_not_required");
  }
  const approvedAt = new Date().toISOString();
  const review: SchemaMigrationReview = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    planId: input.plan.id,
    plan: structuredClone(input.plan),
    state: "approved",
    approvedBy: input.principalId,
    approvalReason: input.reason,
    approvedAt,
  };
  if (!hasDurableDatabase()) {
    reviews().set(key(input.workspaceId, input.projectId, input.plan.id), review);
    return review;
  }
  const rows = await getDatabaseExecutor()<ReviewRow>(
    `INSERT INTO schema_migration_reviews
      (workspace_id, project_id, plan_id, from_version, to_version,
       classification, plan, state, approved_by, approval_reason, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'approved', $8, $9, $10)
     ON CONFLICT (workspace_id, project_id, plan_id)
     DO UPDATE SET plan = EXCLUDED.plan, state = 'approved',
                   approved_by = EXCLUDED.approved_by,
                   approval_reason = EXCLUDED.approval_reason,
                   approved_at = EXCLUDED.approved_at,
                   sealed_snapshot_id = NULL, sealed_at = NULL
     RETURNING workspace_id, project_id, plan_id, plan, state, approved_by,
               approval_reason, approved_at, sealed_snapshot_id, sealed_at`,
    [
      input.workspaceId,
      input.projectId,
      input.plan.id,
      input.plan.fromVersion,
      input.plan.toVersion,
      input.plan.classification,
      JSON.stringify(input.plan),
      input.principalId,
      input.reason ?? null,
      approvedAt,
    ],
  );
  if (!rows[0]) throw new Error("failed to approve schema migration");
  return fromRow(rows[0]);
}

export async function getSchemaMigrationReview(
  workspaceId: string,
  projectId: string,
  planId: string,
): Promise<SchemaMigrationReview | null> {
  if (!hasDurableDatabase()) {
    return reviews().get(key(workspaceId, projectId, planId)) ?? null;
  }
  const rows = await getDatabaseExecutor()<ReviewRow>(
    `SELECT workspace_id, project_id, plan_id, plan, state, approved_by,
            approval_reason, approved_at, sealed_snapshot_id, sealed_at
     FROM schema_migration_reviews
     WHERE workspace_id = $1 AND project_id = $2 AND plan_id = $3`,
    [workspaceId, projectId, planId],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function markSchemaMigrationSealed(
  workspaceId: string,
  projectId: string,
  planId: string,
  snapshotId: string,
): Promise<void> {
  const sealedAt = new Date().toISOString();
  if (!hasDurableDatabase()) {
    const current = reviews().get(key(workspaceId, projectId, planId));
    if (current) {
      reviews().set(key(workspaceId, projectId, planId), {
        ...current,
        state: "sealed",
        sealedSnapshotId: snapshotId,
        sealedAt,
      });
    }
    return;
  }
  await getDatabaseExecutor()(
    `UPDATE schema_migration_reviews
     SET state = 'sealed', sealed_snapshot_id = $4, sealed_at = $5
     WHERE workspace_id = $1 AND project_id = $2 AND plan_id = $3`,
    [workspaceId, projectId, planId, snapshotId, sealedAt],
  );
}

export async function recordSchemaMigrationSealed(input: {
  workspaceId: string;
  projectId: string;
  plan: SchemaMigrationPlan;
  snapshotId: string;
  principalId: string;
}): Promise<SchemaMigrationReview> {
  const now = new Date().toISOString();
  const existing = await getSchemaMigrationReview(
    input.workspaceId,
    input.projectId,
    input.plan.id,
  );
  if (input.plan.approvalRequired && existing?.state !== "approved") {
    throw new Error("schema_approval_required");
  }
  const review: SchemaMigrationReview = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    planId: input.plan.id,
    plan: structuredClone(input.plan),
    state: "sealed",
    approvedBy: existing?.approvedBy ?? input.principalId,
    approvalReason:
      existing?.approvalReason ??
      (input.plan.approvalRequired
        ? undefined
        : "Automatically accepted non-destructive migration"),
    approvedAt: existing?.approvedAt ?? now,
    sealedSnapshotId: input.snapshotId,
    sealedAt: now,
  };
  if (!hasDurableDatabase()) {
    reviews().set(
      key(input.workspaceId, input.projectId, input.plan.id),
      review,
    );
    return review;
  }
  const rows = await getDatabaseExecutor()<ReviewRow>(
    `INSERT INTO schema_migration_reviews
      (workspace_id, project_id, plan_id, from_version, to_version,
       classification, plan, state, approved_by, approval_reason,
       approved_at, sealed_snapshot_id, sealed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'sealed', $8, $9, $10, $11, $12)
     ON CONFLICT (workspace_id, project_id, plan_id)
     DO UPDATE SET plan = EXCLUDED.plan, state = 'sealed',
                   sealed_snapshot_id = EXCLUDED.sealed_snapshot_id,
                   sealed_at = EXCLUDED.sealed_at
     RETURNING workspace_id, project_id, plan_id, plan, state, approved_by,
               approval_reason, approved_at, sealed_snapshot_id, sealed_at`,
    [
      input.workspaceId,
      input.projectId,
      input.plan.id,
      input.plan.fromVersion,
      input.plan.toVersion,
      input.plan.classification,
      JSON.stringify(input.plan),
      review.approvedBy,
      review.approvalReason ?? null,
      review.approvedAt,
      input.snapshotId,
      now,
    ],
  );
  if (!rows[0]) throw new Error("failed to record sealed schema migration");
  return fromRow(rows[0]);
}

export async function listSchemaMigrationReviews(
  workspaceId: string,
  projectId: string,
): Promise<SchemaMigrationReview[]> {
  if (!hasDurableDatabase()) {
    return [...reviews().values()]
      .filter(
        (review) =>
          review.workspaceId === workspaceId && review.projectId === projectId,
      )
      .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt));
  }
  const rows = await getDatabaseExecutor()<ReviewRow>(
    `SELECT workspace_id, project_id, plan_id, plan, state, approved_by,
            approval_reason, approved_at, sealed_snapshot_id, sealed_at
     FROM schema_migration_reviews
     WHERE workspace_id = $1 AND project_id = $2
     ORDER BY approved_at DESC`,
    [workspaceId, projectId],
  );
  return rows.map(fromRow);
}

function reviews(): Map<string, SchemaMigrationReview> {
  return (globalThis.__fabricSchemaMigrationReviews ??= new Map());
}

function key(workspaceId: string, projectId: string, planId: string): string {
  return `${workspaceId}:${projectId}:${planId}`;
}

function fromRow(row: ReviewRow): SchemaMigrationReview {
  return {
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planId: row.plan_id,
    plan: typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan,
    state: row.state,
    approvedBy: row.approved_by,
    approvalReason: row.approval_reason ?? undefined,
    approvedAt: iso(row.approved_at),
    sealedSnapshotId: row.sealed_snapshot_id ?? undefined,
    sealedAt: row.sealed_at ? iso(row.sealed_at) : undefined,
  };
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

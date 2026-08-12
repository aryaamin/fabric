import { createHash, randomUUID } from "node:crypto";
import {
  executeLogicalSchemaMigration,
  type LogicalRecord,
  type LogicalSchema,
  type SchemaMigrationPlan,
  type SchemaValidationIssue,
} from "@fabric/projects";
import {
  getDatabaseExecutor,
  hasDurableDatabase,
  runDatabaseTransaction,
} from "./database.ts";

export type SchemaMigrationRunState =
  | "backing_up"
  | "applying"
  | "validating"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface SchemaMigrationRun {
  id: string;
  workspaceId: string;
  projectId: string;
  planId: string;
  targetSnapshotId: string;
  plan: SchemaMigrationPlan;
  desiredSchema: LogicalSchema;
  state: SchemaMigrationRunState;
  backupId?: string;
  changedRecords: number;
  deletedRecords: number;
  issues: SchemaValidationIssue[];
  error?: string;
  initiatedBy: string;
  startedAt: string;
  finishedAt?: string;
  rolledBackBy?: string;
  rolledBackAt?: string;
}

interface RecordRow extends Record<string, unknown> {
  collection: string;
  id: string;
  data: Record<string, unknown> | string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  project_id: string;
  plan_id: string;
  target_snapshot_id: string;
  plan: SchemaMigrationPlan | string;
  desired_schema: LogicalSchema | string;
  state: SchemaMigrationRunState;
  backup_id: string | null;
  changed_records: number;
  deleted_records: number;
  issues: SchemaValidationIssue[] | string;
  error: string | null;
  initiated_by: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  rolled_back_by: string | null;
  rolled_back_at: string | Date | null;
}

interface BackupRow extends Record<string, unknown> {
  id: string;
  records: LogicalRecord[] | string;
  checksum: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __fabricSchemaMigrationRuns:
    | Map<string, SchemaMigrationRun>
    | undefined;
  // eslint-disable-next-line no-var
  var __fabricSchemaMigrationBackups:
    | Map<string, LogicalRecord[]>
    | undefined;
  // eslint-disable-next-line no-var
  var __fabricLogicalProjectRecords:
    | Map<string, LogicalRecord[]>
    | undefined;
}

export async function executeSchemaMigration(input: {
  workspaceId: string;
  projectId: string;
  targetSnapshotId: string;
  plan: SchemaMigrationPlan;
  backupSchema: LogicalSchema;
  desiredSchema: LogicalSchema;
  principalId: string;
}): Promise<SchemaMigrationRun> {
  const existing = await findRunForTarget(
    input.workspaceId,
    input.projectId,
    input.plan.id,
    input.targetSnapshotId,
  );
  if (existing) return existing;

  const id = `smr_${randomUUID()}`;
  const backupId = `smb_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  let run: SchemaMigrationRun = {
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    planId: input.plan.id,
    targetSnapshotId: input.targetSnapshotId,
    plan: structuredClone(input.plan),
    desiredSchema: structuredClone(input.desiredSchema),
    state: "backing_up",
    changedRecords: 0,
    deletedRecords: 0,
    issues: [],
    initiatedBy: input.principalId,
    startedAt,
  };
  await saveRun(run);

  try {
    const records = await loadRecords(input.workspaceId, input.projectId);
    await saveBackup({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      id: backupId,
      planId: input.plan.id,
      schema: input.backupSchema,
      records,
      principalId: input.principalId,
    });
    run = await updateRun(run, { state: "applying", backupId });

    const result = executeLogicalSchemaMigration(
      records,
      input.plan,
      input.desiredSchema,
    );
    if (!result.ok) {
      return updateRun(run, {
        state: "failed",
        issues: result.issues,
        error: "schema validation failed before commit",
        finishedAt: new Date().toISOString(),
      });
    }

    run = await updateRun(run, { state: "validating" });
    await replaceRecords(input.workspaceId, input.projectId, result.records);
    return updateRun(run, {
      state: "succeeded",
      changedRecords: result.changedRecords,
      deletedRecords: result.deletedRecords,
      issues: [],
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (run.backupId) {
      const backup = await loadBackup(input.workspaceId, input.projectId, run.backupId);
      if (backup) {
        await replaceRecords(input.workspaceId, input.projectId, backup.records);
      }
    }
    return updateRun(run, {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    });
  }
}

export async function rollbackSchemaMigration(input: {
  workspaceId: string;
  projectId: string;
  runId: string;
  principalId: string;
}): Promise<SchemaMigrationRun> {
  const run = await getSchemaMigrationRun(
    input.workspaceId,
    input.projectId,
    input.runId,
  );
  if (!run) throw new Error(`schema migration run ${input.runId} not found`);
  if (run.state !== "succeeded") {
    throw new Error(`schema migration run ${input.runId} cannot be rolled back`);
  }
  if (!run.backupId) throw new Error("schema migration backup is missing");
  const backup = await loadBackup(
    input.workspaceId,
    input.projectId,
    run.backupId,
  );
  if (!backup) throw new Error("schema migration backup is missing");
  if (recordChecksum(backup.records) !== backup.checksum) {
    throw new Error("schema migration backup checksum mismatch");
  }
  await replaceRecords(input.workspaceId, input.projectId, backup.records);
  return updateRun(run, {
    state: "rolled_back",
    rolledBackBy: input.principalId,
    rolledBackAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
}

export async function listSchemaMigrationRuns(
  workspaceId: string,
  projectId: string,
): Promise<SchemaMigrationRun[]> {
  if (!hasDurableDatabase()) {
    return [...runs().values()]
      .filter(
        (run) =>
          run.workspaceId === workspaceId && run.projectId === projectId,
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }
  const rows = await getDatabaseExecutor()<RunRow>(
    `${RUN_SELECT}
     WHERE workspace_id = $1 AND project_id = $2
     ORDER BY started_at DESC`,
    [workspaceId, projectId],
  );
  return rows.map(fromRunRow);
}

export async function getSchemaMigrationRun(
  workspaceId: string,
  projectId: string,
  runId: string,
): Promise<SchemaMigrationRun | null> {
  if (!hasDurableDatabase()) {
    return runs().get(runKey(workspaceId, projectId, runId)) ?? null;
  }
  const rows = await getDatabaseExecutor()<RunRow>(
    `${RUN_SELECT}
     WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
    [workspaceId, projectId, runId],
  );
  return rows[0] ? fromRunRow(rows[0]) : null;
}

async function findRunForTarget(
  workspaceId: string,
  projectId: string,
  planId: string,
  targetSnapshotId: string,
): Promise<SchemaMigrationRun | null> {
  if (!hasDurableDatabase()) {
    return (
      [...runs().values()].find(
        (run) =>
          run.workspaceId === workspaceId &&
          run.projectId === projectId &&
          run.planId === planId &&
          run.targetSnapshotId === targetSnapshotId,
      ) ?? null
    );
  }
  const rows = await getDatabaseExecutor()<RunRow>(
    `${RUN_SELECT}
     WHERE workspace_id = $1 AND project_id = $2
       AND plan_id = $3 AND target_snapshot_id = $4`,
    [workspaceId, projectId, planId, targetSnapshotId],
  );
  return rows[0] ? fromRunRow(rows[0]) : null;
}

async function saveRun(run: SchemaMigrationRun): Promise<void> {
  if (!hasDurableDatabase()) {
    runs().set(runKey(run.workspaceId, run.projectId, run.id), structuredClone(run));
    return;
  }
  await getDatabaseExecutor()(
    `INSERT INTO schema_migration_runs
      (workspace_id, project_id, id, plan_id, target_snapshot_id, plan,
       desired_schema, state, backup_id, changed_records, deleted_records,
       issues, error, initiated_by, started_at, finished_at,
       rolled_back_by, rolled_back_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10,
             $11, $12::jsonb, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (workspace_id, project_id, id)
     DO UPDATE SET state = EXCLUDED.state, backup_id = EXCLUDED.backup_id,
                   changed_records = EXCLUDED.changed_records,
                   deleted_records = EXCLUDED.deleted_records,
                   issues = EXCLUDED.issues, error = EXCLUDED.error,
                   finished_at = EXCLUDED.finished_at,
                   rolled_back_by = EXCLUDED.rolled_back_by,
                   rolled_back_at = EXCLUDED.rolled_back_at`,
    [
      run.workspaceId,
      run.projectId,
      run.id,
      run.planId,
      run.targetSnapshotId,
      JSON.stringify(run.plan),
      JSON.stringify(run.desiredSchema),
      run.state,
      run.backupId ?? null,
      run.changedRecords,
      run.deletedRecords,
      JSON.stringify(run.issues),
      run.error ?? null,
      run.initiatedBy,
      run.startedAt,
      run.finishedAt ?? null,
      run.rolledBackBy ?? null,
      run.rolledBackAt ?? null,
    ],
  );
}

async function updateRun(
  run: SchemaMigrationRun,
  patch: Partial<SchemaMigrationRun>,
): Promise<SchemaMigrationRun> {
  const next = { ...run, ...patch };
  await saveRun(next);
  return next;
}

async function saveBackup(input: {
  workspaceId: string;
  projectId: string;
  id: string;
  planId: string;
  schema: LogicalSchema;
  records: LogicalRecord[];
  principalId: string;
}): Promise<void> {
  const checksum = recordChecksum(input.records);
  if (!hasDurableDatabase()) {
    backups().set(
      backupKey(input.workspaceId, input.projectId, input.id),
      structuredClone(input.records),
    );
    return;
  }
  await getDatabaseExecutor()(
    `INSERT INTO schema_record_backups
      (workspace_id, project_id, id, plan_id, namespace, schema, records,
       checksum, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      input.workspaceId,
      input.projectId,
      input.id,
      input.planId,
      dataNamespace(input.workspaceId, input.projectId),
      JSON.stringify(input.schema),
      JSON.stringify(input.records),
      checksum,
      input.principalId,
    ],
  );
}

async function loadBackup(
  workspaceId: string,
  projectId: string,
  backupId: string,
): Promise<{ records: LogicalRecord[]; checksum: string } | null> {
  if (!hasDurableDatabase()) {
    const records = backups().get(backupKey(workspaceId, projectId, backupId));
    return records
      ? { records: structuredClone(records), checksum: recordChecksum(records) }
      : null;
  }
  const rows = await getDatabaseExecutor()<BackupRow>(
    `SELECT id, records, checksum
     FROM schema_record_backups
     WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
    [workspaceId, projectId, backupId],
  );
  if (!rows[0]) return null;
  return {
    records: parseJson<LogicalRecord[]>(rows[0].records),
    checksum: rows[0].checksum,
  };
}

async function loadRecords(
  workspaceId: string,
  projectId: string,
): Promise<LogicalRecord[]> {
  const namespace = dataNamespace(workspaceId, projectId);
  if (!hasDurableDatabase()) {
    return structuredClone(memoryRecords().get(namespace) ?? []);
  }
  const rows = await getDatabaseExecutor()<RecordRow>(
    `SELECT collection, id, data, created_at, updated_at
     FROM app_records
     WHERE namespace = $1
     ORDER BY collection, id`,
    [namespace],
  );
  return rows.map((row) => ({
    collection: row.collection,
    id: row.id,
    data: parseJson<Record<string, unknown>>(row.data),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

async function replaceRecords(
  workspaceId: string,
  projectId: string,
  records: LogicalRecord[],
): Promise<void> {
  const namespace = dataNamespace(workspaceId, projectId);
  if (!hasDurableDatabase()) {
    memoryRecords().set(namespace, structuredClone(records));
    return;
  }
  await runDatabaseTransaction([
    {
      text: "DELETE FROM app_records WHERE namespace = $1",
      params: [namespace],
    },
    ...records.map((record) => ({
      text: `INSERT INTO app_records
        (namespace, collection, id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      params: [
        namespace,
        record.collection,
        record.id,
        JSON.stringify(record.data),
        record.createdAt,
        record.updatedAt,
      ],
    })),
  ]);
}

function dataNamespace(workspaceId: string, projectId: string): string {
  return `${workspaceId}:${projectId}:records`;
}

function recordChecksum(records: LogicalRecord[]): string {
  return createHash("sha256")
    .update(stableJson(records))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function runs(): Map<string, SchemaMigrationRun> {
  return (globalThis.__fabricSchemaMigrationRuns ??= new Map());
}

function backups(): Map<string, LogicalRecord[]> {
  return (globalThis.__fabricSchemaMigrationBackups ??= new Map());
}

function memoryRecords(): Map<string, LogicalRecord[]> {
  return (globalThis.__fabricLogicalProjectRecords ??= new Map());
}

function runKey(workspaceId: string, projectId: string, runId: string): string {
  return `${workspaceId}:${projectId}:${runId}`;
}

function backupKey(
  workspaceId: string,
  projectId: string,
  backupId: string,
): string {
  return `${workspaceId}:${projectId}:${backupId}`;
}

function fromRunRow(row: RunRow): SchemaMigrationRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    planId: row.plan_id,
    targetSnapshotId: row.target_snapshot_id,
    plan: parseJson<SchemaMigrationPlan>(row.plan),
    desiredSchema: parseJson<LogicalSchema>(row.desired_schema),
    state: row.state,
    backupId: row.backup_id ?? undefined,
    changedRecords: Number(row.changed_records),
    deletedRecords: Number(row.deleted_records),
    issues: parseJson<SchemaValidationIssue[]>(row.issues),
    error: row.error ?? undefined,
    initiatedBy: row.initiated_by,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
    rolledBackBy: row.rolled_back_by ?? undefined,
    rolledBackAt: row.rolled_back_at ? iso(row.rolled_back_at) : undefined,
  };
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const RUN_SELECT = `SELECT id, workspace_id, project_id, plan_id,
  target_snapshot_id, plan, desired_schema, state, backup_id,
  changed_records, deleted_records, issues, error, initiated_by,
  started_at, finished_at, rolled_back_by, rolled_back_at
  FROM schema_migration_runs`;

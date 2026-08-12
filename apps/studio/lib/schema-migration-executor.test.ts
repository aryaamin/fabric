import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectLogicalSchema,
  planSchemaMigration,
  type LogicalRecord,
} from "@fabric/projects";
import {
  executeSchemaMigration,
  rollbackSchemaMigration,
} from "./schema-migration-executor.ts";

test("migration runs back up, apply, validate, and restore logical records", async () => {
  const suffix = crypto.randomUUID();
  const workspaceId = `ws_${suffix}`;
  const projectId = `prj_${suffix}`;
  const namespace = `${workspaceId}:${projectId}:records`;
  const timestamp = "2026-08-12T00:00:00.000Z";
  const source: LogicalRecord[] = [
    {
      collection: "Task",
      id: "task_1",
      data: { title: "Test migration" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  globalThis.__fabricLogicalProjectRecords ??= new Map();
  globalThis.__fabricLogicalProjectRecords.set(namespace, structuredClone(source));

  const current = {
    models: [
      {
        name: "Task",
        fields: [{ name: "title", type: "string" as const, required: true }],
      },
    ],
  };
  const desired = {
    models: [
      {
        name: "Task",
        fields: [
          ...current.models[0]!.fields,
          {
            name: "status",
            type: "enum" as const,
            enum: ["todo", "done"],
            required: true,
            default: "todo",
          },
        ],
      },
    ],
  };
  const run = await executeSchemaMigration({
    workspaceId,
    projectId,
    targetSnapshotId: "snap_target",
    plan: planSchemaMigration(current, desired),
    backupSchema: inspectLogicalSchema(current),
    desiredSchema: inspectLogicalSchema(desired),
    principalId: "usr_owner",
  });
  assert.equal(run.state, "succeeded");
  assert.equal(run.changedRecords, 1);
  assert.equal(
    globalThis.__fabricLogicalProjectRecords.get(namespace)?.[0]?.data.status,
    "todo",
  );

  const rolledBack = await rollbackSchemaMigration({
    workspaceId,
    projectId,
    runId: run.id,
    principalId: "usr_owner",
  });
  assert.equal(rolledBack.state, "rolled_back");
  assert.deepEqual(
    globalThis.__fabricLogicalProjectRecords.get(namespace),
    source,
  );
});

test("failed validation never commits a partial backfill", async () => {
  const suffix = crypto.randomUUID();
  const workspaceId = `ws_${suffix}`;
  const projectId = `prj_${suffix}`;
  const namespace = `${workspaceId}:${projectId}:records`;
  const timestamp = "2026-08-12T00:00:00.000Z";
  const source: LogicalRecord[] = [
    {
      collection: "Task",
      id: "task_1",
      data: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  globalThis.__fabricLogicalProjectRecords ??= new Map();
  globalThis.__fabricLogicalProjectRecords.set(namespace, structuredClone(source));
  const current = {
    models: [{ name: "Task", fields: [] }],
  };
  const desired = {
    models: [
      {
        name: "Task",
        fields: [
          { name: "owner", type: "string" as const, required: true },
        ],
      },
    ],
  };
  const run = await executeSchemaMigration({
    workspaceId,
    projectId,
    targetSnapshotId: "snap_blocked",
    plan: planSchemaMigration(current, desired),
    backupSchema: inspectLogicalSchema(current),
    desiredSchema: inspectLogicalSchema(desired),
    principalId: "usr_owner",
  });
  assert.equal(run.state, "failed");
  assert.equal(run.issues[0]?.code, "backfill_value_required");
  assert.deepEqual(
    globalThis.__fabricLogicalProjectRecords.get(namespace),
    source,
  );
});

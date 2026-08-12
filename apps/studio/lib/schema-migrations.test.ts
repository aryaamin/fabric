import assert from "node:assert/strict";
import test from "node:test";
import { planSchemaMigration } from "@fabric/projects";
import {
  approveSchemaMigration,
  getSchemaMigrationReview,
  markSchemaMigrationSealed,
} from "./schema-migrations.ts";

test("destructive schema approvals are scoped to a deterministic plan", async () => {
  const suffix = crypto.randomUUID();
  const workspaceId = `ws_schema_${suffix}`;
  const projectId = `prj_schema_${suffix}`;
  const plan = planSchemaMigration(
    {
      models: [
        {
          name: "Task",
          fields: [{ name: "id", type: "string", required: true }],
        },
      ],
    },
    { models: [] },
  );
  const approved = await approveSchemaMigration({
    workspaceId,
    projectId,
    plan,
    principalId: "usr_owner",
    reason: "Confirmed data removal",
  });
  assert.equal(approved.state, "approved");
  assert.equal(approved.planId, plan.id);
  assert.equal(
    (await getSchemaMigrationReview(workspaceId, projectId, plan.id))?.approvedBy,
    "usr_owner",
  );

  await markSchemaMigrationSealed(
    workspaceId,
    projectId,
    plan.id,
    "snap_after",
  );
  const sealed = await getSchemaMigrationReview(workspaceId, projectId, plan.id);
  assert.equal(sealed?.state, "sealed");
  assert.equal(sealed?.sealedSnapshotId, "snap_after");
});

test("safe schema plans cannot be falsely approved", async () => {
  const plan = planSchemaMigration(undefined, {
    models: [
      {
        name: "Task",
        fields: [{ name: "id", type: "string", required: true }],
      },
    ],
  });
  await assert.rejects(
    approveSchemaMigration({
      workspaceId: "ws_safe",
      projectId: "prj_safe",
      plan,
      principalId: "usr_owner",
    }),
    /schema_approval_not_required/,
  );
});

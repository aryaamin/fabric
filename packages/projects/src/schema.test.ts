import assert from "node:assert/strict";
import test from "node:test";
import type { ManifestDataModel } from "./manifest.ts";
import { inspectLogicalSchema, planSchemaMigration } from "./schema.ts";

const current: ManifestDataModel = {
  models: [
    {
      name: "Task",
      fields: [
        { name: "id", type: "string", required: true },
        {
          name: "status",
          type: "enum",
          required: true,
          enum: ["todo", "done"],
        },
      ],
      indexes: [{ name: "task_id", fields: ["id"], unique: true }],
    },
  ],
};

test("logical schema introspection is canonical and deterministic", () => {
  const reversed: ManifestDataModel = {
    models: [
      {
        ...current.models[0]!,
        fields: [...current.models[0]!.fields].reverse(),
      },
    ],
  };
  assert.equal(
    inspectLogicalSchema(current).version,
    inspectLogicalSchema(reversed).version,
  );
  assert.deepEqual(
    inspectLogicalSchema(reversed).models[0]?.fields.map((field) => field.name),
    ["id", "status"],
  );
});

test("optional additions are safe and do not require approval", () => {
  const desired: ManifestDataModel = {
    models: [
      {
        ...current.models[0]!,
        fields: [
          ...current.models[0]!.fields,
          { name: "notes", type: "text" },
        ],
      },
    ],
  };
  const plan = planSchemaMigration(current, desired);
  assert.equal(plan.classification, "safe");
  assert.equal(plan.approvalRequired, false);
  assert.equal(plan.backupRequired, false);
  assert.equal(plan.changes[0]?.kind, "add_field");
});

test("required additions and unique indexes require a backfill", () => {
  const desired: ManifestDataModel = {
    models: [
      {
        ...current.models[0]!,
        fields: [
          ...current.models[0]!.fields,
          { name: "ownerId", type: "string", required: true },
        ],
        indexes: [
          ...current.models[0]!.indexes!,
          { name: "task_owner", fields: ["ownerId"], unique: true },
        ],
      },
    ],
  };
  const plan = planSchemaMigration(current, desired);
  assert.equal(plan.classification, "backfill_required");
  assert.equal(plan.backfillRequired, true);
  assert.equal(plan.approvalRequired, false);
  assert.ok(plan.validations.includes("validate_backfill"));
});

test("data-removing and incompatible changes require backup and approval", () => {
  const desired: ManifestDataModel = {
    models: [
      {
        name: "Task",
        fields: [
          { name: "id", type: "integer", required: true },
          {
            name: "status",
            type: "enum",
            required: true,
            enum: ["todo"],
          },
        ],
      },
    ],
  };
  const plan = planSchemaMigration(current, desired);
  assert.equal(plan.classification, "destructive");
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.backupRequired, true);
  assert.ok(plan.changes.some((change) => change.kind === "change_field"));
  assert.ok(plan.changes.some((change) => change.kind === "remove_index"));
  assert.ok(plan.validations.includes("verify_backup"));
});

test("migration plan identity is stable for the same logical change", () => {
  const desired: ManifestDataModel = {
    models: [
      ...current.models,
      {
        name: "User",
        fields: [{ name: "id", type: "string", required: true }],
      },
    ],
  };
  assert.equal(
    planSchemaMigration(current, desired).id,
    planSchemaMigration(current, desired).id,
  );
});

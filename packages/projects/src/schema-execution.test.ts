import assert from "node:assert/strict";
import test from "node:test";
import {
  executeLogicalSchemaMigration,
  inspectLogicalSchema,
  planSchemaMigration,
  validateLogicalRecords,
  type LogicalRecord,
} from "./index.ts";

const timestamp = "2026-08-12T00:00:00.000Z";
const records: LogicalRecord[] = [
  {
    collection: "Task",
    id: "task_1",
    data: { title: "Ship Fabric" },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];

test("required fields with defaults are backfilled and validated", () => {
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
            required: true,
            default: "todo",
            enum: ["todo", "done"],
          },
        ],
      },
    ],
  };
  const result = executeLogicalSchemaMigration(
    records,
    planSchemaMigration(current, desired),
    inspectLogicalSchema(desired),
  );
  assert.equal(result.ok, true);
  assert.equal(result.changedRecords, 1);
  assert.equal(result.records[0]?.data.status, "todo");
  assert.deepEqual(records[0]?.data, { title: "Ship Fabric" });
});

test("missing backfill values block mutation and preserve the backup", () => {
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
          { name: "owner", type: "string" as const, required: true },
        ],
      },
    ],
  };
  const result = executeLogicalSchemaMigration(
    records,
    planSchemaMigration(current, desired),
    inspectLogicalSchema(desired),
  );
  assert.equal(result.ok, false);
  assert.equal(result.issues[0]?.code, "backfill_value_required");
  assert.deepEqual(result.records, result.backup);
});

test("destructive removals produce restorable backups", () => {
  const current = {
    models: [
      {
        name: "Task",
        fields: [
          { name: "title", type: "string" as const, required: true },
          { name: "legacy", type: "string" as const },
        ],
      },
    ],
  };
  const desired = {
    models: [
      {
        name: "Task",
        fields: [{ name: "title", type: "string" as const, required: true }],
      },
    ],
  };
  const source = [
    {
      ...records[0]!,
      data: { ...records[0]!.data, legacy: "remove me" },
    },
  ];
  const result = executeLogicalSchemaMigration(
    source,
    planSchemaMigration(current, desired),
    inspectLogicalSchema(desired),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.records[0]?.data, { title: "Ship Fabric" });
  assert.equal(result.backup[0]?.data.legacy, "remove me");
});

test("unique indexes and references are validated before commit", () => {
  const schema = inspectLogicalSchema({
    models: [
      {
        name: "User",
        fields: [
          { name: "email", type: "string", required: true },
        ],
        indexes: [{ name: "unique_email", fields: ["email"], unique: true }],
      },
      {
        name: "Task",
        fields: [
          {
            name: "ownerId",
            type: "reference",
            references: { model: "User" },
          },
        ],
      },
    ],
  });
  const invalid: LogicalRecord[] = [
    {
      collection: "User",
      id: "u1",
      data: { email: "same@example.com" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      collection: "User",
      id: "u2",
      data: { email: "same@example.com" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      collection: "Task",
      id: "t1",
      data: { ownerId: "missing" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const issues = validateLogicalRecords(invalid, schema);
  assert.ok(issues.some((issue) => issue.code === "duplicate_unique_index"));
  assert.ok(issues.some((issue) => issue.code === "missing_reference"));
});

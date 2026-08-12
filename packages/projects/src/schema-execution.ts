import type {
  LogicalSchema,
  SchemaChange,
  SchemaMigrationPlan,
} from "./schema.ts";

export interface LogicalRecord {
  collection: string;
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaValidationIssue {
  code:
    | "missing_required_field"
    | "invalid_field_type"
    | "invalid_enum_value"
    | "duplicate_unique_index"
    | "missing_reference"
    | "backfill_value_required"
    | "transform_required";
  model: string;
  recordId?: string;
  field?: string;
  message: string;
}

export interface SchemaMigrationExecution {
  ok: boolean;
  records: LogicalRecord[];
  backup: LogicalRecord[];
  changedRecords: number;
  deletedRecords: number;
  issues: SchemaValidationIssue[];
}

/**
 * Applies a logical migration to an isolated record set. The caller commits the
 * returned records only when `ok` is true; the untouched backup supports rollback.
 */
export function executeLogicalSchemaMigration(
  records: LogicalRecord[],
  plan: SchemaMigrationPlan,
  desired: LogicalSchema,
): SchemaMigrationExecution {
  const backup = structuredClone(records);
  const working = structuredClone(records);
  const changed = new Set<string>();
  let deletedRecords = 0;
  const issues: SchemaValidationIssue[] = [];

  for (const change of plan.changes) {
    if (change.kind === "remove_model") {
      const model = pathPart(change, 1);
      for (let index = working.length - 1; index >= 0; index -= 1) {
        if (working[index]?.collection === model) {
          working.splice(index, 1);
          deletedRecords += 1;
        }
      }
      continue;
    }
    if (change.kind === "remove_field") {
      const model = pathPart(change, 1);
      const field = pathPart(change, 3);
      for (const record of working) {
        if (record.collection === model && field in record.data) {
          delete record.data[field];
          changed.add(recordKey(record));
        }
      }
      continue;
    }
    if (change.kind === "add_field" || change.kind === "change_field") {
      applyFieldChange(working, change, changed, issues);
    }
  }

  if (issues.length === 0) {
    issues.push(...validateLogicalRecords(working, desired));
  }
  return {
    ok: issues.length === 0,
    records: issues.length === 0 ? working : backup,
    backup,
    changedRecords: issues.length === 0 ? changed.size : 0,
    deletedRecords: issues.length === 0 ? deletedRecords : 0,
    issues,
  };
}

export function validateLogicalRecords(
  records: LogicalRecord[],
  schema: LogicalSchema,
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  const models = new Map(schema.models.map((model) => [model.name, model]));
  const recordsByModel = new Map<string, LogicalRecord[]>();
  for (const record of records) {
    const group = recordsByModel.get(record.collection) ?? [];
    group.push(record);
    recordsByModel.set(record.collection, group);
    const model = models.get(record.collection);
    if (!model) continue;
    for (const field of model.fields) {
      const value = record.data[field.name];
      if (field.required && (value === undefined || value === null)) {
        issues.push({
          code: "missing_required_field",
          model: model.name,
          recordId: record.id,
          field: field.name,
          message: `${model.name}/${record.id} is missing required field ${field.name}`,
        });
        continue;
      }
      if (value === undefined || value === null) continue;
      if (!matchesType(value, field.type)) {
        issues.push({
          code: "invalid_field_type",
          model: model.name,
          recordId: record.id,
          field: field.name,
          message: `${model.name}/${record.id}.${field.name} is not ${field.type}`,
        });
      }
      if (
        field.type === "enum" &&
        field.enum &&
        !field.enum.includes(String(value))
      ) {
        issues.push({
          code: "invalid_enum_value",
          model: model.name,
          recordId: record.id,
          field: field.name,
          message: `${model.name}/${record.id}.${field.name} is outside the declared enum`,
        });
      }
    }
  }

  for (const model of schema.models) {
    const modelRecords = recordsByModel.get(model.name) ?? [];
    for (const index of model.indexes?.filter((candidate) => candidate.unique) ?? []) {
      const seen = new Map<string, string>();
      for (const record of modelRecords) {
        const values = index.fields.map((field) => record.data[field]);
        if (values.some((value) => value === undefined || value === null)) continue;
        const key = JSON.stringify(values);
        const existing = seen.get(key);
        if (existing) {
          issues.push({
            code: "duplicate_unique_index",
            model: model.name,
            recordId: record.id,
            message: `${model.name} index ${index.name} conflicts with record ${existing}`,
          });
        } else {
          seen.set(key, record.id);
        }
      }
    }
    for (const field of model.fields.filter((candidate) => candidate.references)) {
      const target = field.references!;
      const targetRecords = recordsByModel.get(target.model) ?? [];
      const targetField = target.field ?? "id";
      const targetValues = new Set(
        targetRecords.map((record) =>
          targetField === "id" ? record.id : record.data[targetField],
        ),
      );
      for (const record of modelRecords) {
        const value = record.data[field.name];
        if (value === undefined || value === null) continue;
        if (!targetValues.has(value)) {
          issues.push({
            code: "missing_reference",
            model: model.name,
            recordId: record.id,
            field: field.name,
            message: `${model.name}/${record.id}.${field.name} references a missing ${target.model}`,
          });
        }
      }
    }
  }
  return issues;
}

function applyFieldChange(
  records: LogicalRecord[],
  change: SchemaChange,
  changed: Set<string>,
  issues: SchemaValidationIssue[],
): void {
  const model = pathPart(change, 1);
  const fieldName = pathPart(change, 3);
  const desired = change.after as
    | { type?: string; required?: boolean; default?: unknown }
    | undefined;
  const previous = change.before as { type?: string } | undefined;
  const needsTransform =
    change.kind === "change_field" &&
    previous?.type !== undefined &&
    desired?.type !== undefined &&
    previous.type !== desired.type &&
    !(
      (previous.type === "integer" && desired.type === "number") ||
      (previous.type === "string" && desired.type === "text")
    );
  if (needsTransform) {
    issues.push({
      code: "transform_required",
      model,
      field: fieldName,
      message: `${model}.${fieldName} requires an explicit data transform`,
    });
    return;
  }
  for (const record of records) {
    if (record.collection !== model) continue;
    const value = record.data[fieldName];
    if (
      desired?.required &&
      (value === undefined || value === null) &&
      desired.default === undefined
    ) {
      issues.push({
        code: "backfill_value_required",
        model,
        recordId: record.id,
        field: fieldName,
        message: `${model}/${record.id}.${fieldName} needs a declared default or transform`,
      });
    } else if (
      (value === undefined || value === null) &&
      desired?.default !== undefined
    ) {
      record.data[fieldName] = structuredClone(desired.default);
      changed.add(recordKey(record));
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
    case "text":
    case "date":
    case "datetime":
    case "enum":
    case "reference":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      return true;
    default:
      return false;
  }
}

function pathPart(change: SchemaChange, index: number): string {
  const value = change.path.split(".")[index];
  if (!value) throw new Error(`invalid schema change path: ${change.path}`);
  return value;
}

function recordKey(record: LogicalRecord): string {
  return `${record.collection}:${record.id}`;
}

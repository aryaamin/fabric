import { createHash } from "node:crypto";
import type {
  ManifestDataModel,
  ManifestField,
  ManifestModel,
  ManifestRelationship,
} from "./manifest.ts";

export type SchemaChangeClassification =
  | "safe"
  | "backfill_required"
  | "destructive";

export type SchemaChangeKind =
  | "add_model"
  | "remove_model"
  | "add_field"
  | "remove_field"
  | "change_field"
  | "add_index"
  | "remove_index"
  | "change_index"
  | "add_relationship"
  | "remove_relationship"
  | "change_relationship";

export interface LogicalSchema {
  version: string;
  models: ManifestModel[];
  relationships: ManifestRelationship[];
}

export interface SchemaChange {
  id: string;
  kind: SchemaChangeKind;
  path: string;
  classification: SchemaChangeClassification;
  summary: string;
  before?: unknown;
  after?: unknown;
}

export interface SchemaMigrationPlan {
  id: string;
  fromVersion: string;
  toVersion: string;
  classification: SchemaChangeClassification;
  changes: SchemaChange[];
  approvalRequired: boolean;
  backupRequired: boolean;
  backfillRequired: boolean;
  validations: string[];
}

const CLASSIFICATION_RANK: Record<SchemaChangeClassification, number> = {
  safe: 0,
  backfill_required: 1,
  destructive: 2,
};

/** Returns a canonical, credential-free view of an application's logical data schema. */
export function inspectLogicalSchema(data?: ManifestDataModel): LogicalSchema {
  const models = (data?.models ?? [])
    .map((model) => ({
      ...structuredClone(model),
      fields: [...model.fields].sort(byName),
      indexes: model.indexes
        ? [...model.indexes]
            .map((index) => ({ ...structuredClone(index), fields: [...index.fields] }))
            .sort(byName)
        : undefined,
    }))
    .sort(byName);
  const relationships = [...(data?.relationships ?? [])]
    .map((relationship) => structuredClone(relationship))
    .sort(byName);
  const canonical = { models, relationships };
  return {
    version: schemaVersion(canonical),
    ...canonical,
  };
}

/**
 * Produces a deterministic migration preview. It intentionally emits logical
 * operations rather than SQL or provider credentials.
 */
export function planSchemaMigration(
  currentData?: ManifestDataModel,
  desiredData?: ManifestDataModel,
): SchemaMigrationPlan {
  const current = inspectLogicalSchema(currentData);
  const desired = inspectLogicalSchema(desiredData);
  const changes = [
    ...diffModels(current.models, desired.models),
    ...diffRelationships(current.relationships, desired.relationships),
  ]
    .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind))
    .map((change, index) => ({ ...change, id: `change_${index + 1}` }));
  const classification = changes.reduce<SchemaChangeClassification>(
    (highest, change) =>
      CLASSIFICATION_RANK[change.classification] > CLASSIFICATION_RANK[highest]
        ? change.classification
        : highest,
    "safe",
  );
  const payload = {
    fromVersion: current.version,
    toVersion: desired.version,
    changes,
  };
  return {
    id: `mig_${digest(payload).slice(0, 24)}`,
    ...payload,
    classification,
    changes,
    approvalRequired: classification === "destructive",
    backupRequired: classification === "destructive",
    backfillRequired: changes.some(
      (change) => change.classification === "backfill_required",
    ),
    validations: [
      "validate_manifest",
      ...(changes.some((change) => change.classification === "backfill_required")
        ? ["validate_backfill"]
        : []),
      ...(classification === "destructive"
        ? ["verify_backup", "validate_record_counts"]
        : []),
      "validate_application_queries",
    ],
  };
}

function diffModels(current: ManifestModel[], desired: ManifestModel[]): Omit<SchemaChange, "id">[] {
  const changes: Omit<SchemaChange, "id">[] = [];
  const currentByName = new Map(current.map((model) => [model.name, model]));
  const desiredByName = new Map(desired.map((model) => [model.name, model]));
  for (const model of desired) {
    const previous = currentByName.get(model.name);
    if (!previous) {
      changes.push({
        kind: "add_model",
        path: `models.${model.name}`,
        classification: "safe",
        summary: `Add model ${model.name}`,
        after: model,
      });
      continue;
    }
    changes.push(...diffFields(previous, model), ...diffIndexes(previous, model));
  }
  for (const model of current) {
    if (!desiredByName.has(model.name)) {
      changes.push({
        kind: "remove_model",
        path: `models.${model.name}`,
        classification: "destructive",
        summary: `Remove model ${model.name} and its stored records`,
        before: model,
      });
    }
  }
  return changes;
}

function diffFields(current: ManifestModel, desired: ManifestModel): Omit<SchemaChange, "id">[] {
  const changes: Omit<SchemaChange, "id">[] = [];
  const currentByName = new Map(current.fields.map((field) => [field.name, field]));
  const desiredByName = new Map(desired.fields.map((field) => [field.name, field]));
  for (const field of desired.fields) {
    const previous = currentByName.get(field.name);
    const path = `models.${desired.name}.fields.${field.name}`;
    if (!previous) {
      const backfill = Boolean(field.required);
      changes.push({
        kind: "add_field",
        path,
        classification: backfill ? "backfill_required" : "safe",
        summary: backfill
          ? `Add required field ${desired.name}.${field.name} with a backfill`
          : `Add optional field ${desired.name}.${field.name}`,
        after: field,
      });
      continue;
    }
    if (!equal(previous, field)) {
      changes.push({
        kind: "change_field",
        path,
        classification: classifyFieldChange(previous, field),
        summary: `Change field ${desired.name}.${field.name}`,
        before: previous,
        after: field,
      });
    }
  }
  for (const field of current.fields) {
    if (!desiredByName.has(field.name)) {
      changes.push({
        kind: "remove_field",
        path: `models.${current.name}.fields.${field.name}`,
        classification: "destructive",
        summary: `Remove field ${current.name}.${field.name}`,
        before: field,
      });
    }
  }
  return changes;
}

function diffIndexes(current: ManifestModel, desired: ManifestModel): Omit<SchemaChange, "id">[] {
  const changes: Omit<SchemaChange, "id">[] = [];
  const currentIndexes = current.indexes ?? [];
  const desiredIndexes = desired.indexes ?? [];
  const currentByName = new Map(currentIndexes.map((index) => [index.name, index]));
  const desiredByName = new Map(desiredIndexes.map((index) => [index.name, index]));
  for (const index of desiredIndexes) {
    const previous = currentByName.get(index.name);
    const path = `models.${desired.name}.indexes.${index.name}`;
    if (!previous) {
      changes.push({
        kind: "add_index",
        path,
        classification: index.unique ? "backfill_required" : "safe",
        summary: `Add${index.unique ? " unique" : ""} index ${desired.name}.${index.name}`,
        after: index,
      });
    } else if (!equal(previous, index)) {
      changes.push({
        kind: "change_index",
        path,
        classification: index.unique ? "backfill_required" : "safe",
        summary: `Change index ${desired.name}.${index.name}`,
        before: previous,
        after: index,
      });
    }
  }
  for (const index of currentIndexes) {
    if (!desiredByName.has(index.name)) {
      changes.push({
        kind: "remove_index",
        path: `models.${current.name}.indexes.${index.name}`,
        classification: "safe",
        summary: `Remove index ${current.name}.${index.name}`,
        before: index,
      });
    }
  }
  return changes;
}

function diffRelationships(
  current: ManifestRelationship[],
  desired: ManifestRelationship[],
): Omit<SchemaChange, "id">[] {
  const changes: Omit<SchemaChange, "id">[] = [];
  const currentByName = new Map(current.map((relationship) => [relationship.name, relationship]));
  const desiredByName = new Map(desired.map((relationship) => [relationship.name, relationship]));
  for (const relationship of desired) {
    const previous = currentByName.get(relationship.name);
    const path = `relationships.${relationship.name}`;
    if (!previous) {
      changes.push({
        kind: "add_relationship",
        path,
        classification: "backfill_required",
        summary: `Add relationship ${relationship.name} and validate existing references`,
        after: relationship,
      });
    } else if (!equal(previous, relationship)) {
      changes.push({
        kind: "change_relationship",
        path,
        classification: "destructive",
        summary: `Change relationship ${relationship.name}`,
        before: previous,
        after: relationship,
      });
    }
  }
  for (const relationship of current) {
    if (!desiredByName.has(relationship.name)) {
      changes.push({
        kind: "remove_relationship",
        path: `relationships.${relationship.name}`,
        classification: "destructive",
        summary: `Remove relationship ${relationship.name}`,
        before: relationship,
      });
    }
  }
  return changes;
}

function classifyFieldChange(
  current: ManifestField,
  desired: ManifestField,
): SchemaChangeClassification {
  if (current.type !== desired.type) {
    if (
      (current.type === "integer" && desired.type === "number") ||
      (current.type === "string" && desired.type === "text")
    ) {
      return "safe";
    }
    return "destructive";
  }
  if (removedEnumValues(current, desired)) return "destructive";
  if (!current.required && desired.required) return "backfill_required";
  if (!equal(current.references, desired.references)) return "destructive";
  return "safe";
}

function removedEnumValues(current: ManifestField, desired: ManifestField): boolean {
  if (current.type !== "enum" || desired.type !== "enum") return false;
  const desiredValues = new Set(desired.enum ?? []);
  return (current.enum ?? []).some((value) => !desiredValues.has(value));
}

function schemaVersion(value: object): string {
  return `schema_${digest(value).slice(0, 24)}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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

function equal(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}

export const FABRIC_MANIFEST_PATH = "fabric.json";
export const FABRIC_MANIFEST_API_VERSION = "fabric.dev/v1alpha1";

export type ManifestRuntime = "auto" | "nodejs" | "python" | "go";
export type ManifestWorkloadKind =
  | "web"
  | "function"
  | "worker"
  | "cron"
  | "workflow";
export type ManifestResourceType =
  | "relational_database"
  | "object_storage"
  | "key_value"
  | "durable_queue"
  | "connector";
export type ManifestFieldType =
  | "string"
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "json"
  | "enum"
  | "reference";

export interface ApplicationManifest {
  apiVersion: typeof FABRIC_MANIFEST_API_VERSION;
  kind: "Application";
  metadata: {
    name: string;
    description?: string;
    labels?: Record<string, string>;
  };
  spec: {
    workloads: ManifestWorkload[];
    triggers?: ManifestTrigger[];
    resources?: ManifestResource[];
    data?: ManifestDataModel;
    secrets?: ManifestSecret[];
    permissions?: ManifestPermissions;
    policies?: ManifestPolicies;
  };
}

export interface ManifestWorkload {
  name: string;
  kind: ManifestWorkloadKind;
  runtime: ManifestRuntime;
  root: string;
  entry?: string;
  buildCommand?: string[];
  startCommand?: string[];
  healthCheckPath?: string;
}

export type ManifestTrigger =
  | {
      name: string;
      type: "http";
      workload: string;
      path?: string;
      methods?: string[];
    }
  | {
      name: string;
      type: "schedule";
      workload: string;
      cron: string;
      timezone?: string;
    }
  | {
      name: string;
      type: "webhook";
      workload: string;
      path: string;
      verificationSecret?: string;
    }
  | {
      name: string;
      type: "queue";
      workload: string;
      resource: string;
    }
  | {
      name: string;
      type: "event";
      workload: string;
      source: string;
      event: string;
    }
  | {
      name: string;
      type: "manual";
      workload: string;
    };

export interface ManifestResource {
  name: string;
  type: ManifestResourceType;
  description?: string;
  plan?: string;
  region?: string;
  configuration?: Record<string, unknown>;
}

export interface ManifestDataModel {
  models: ManifestModel[];
  relationships?: ManifestRelationship[];
}

export interface ManifestModel {
  name: string;
  description?: string;
  fields: ManifestField[];
  indexes?: { name: string; fields: string[]; unique?: boolean }[];
}

export interface ManifestField {
  name: string;
  type: ManifestFieldType;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  references?: { model: string; field?: string };
}

export interface ManifestRelationship {
  name: string;
  from: { model: string; field: string };
  to: { model: string; field: string };
  cardinality: "one_to_one" | "one_to_many" | "many_to_many";
  onDelete?: "restrict" | "cascade" | "set_null";
}

export interface ManifestSecret {
  name: string;
  description?: string;
  required?: boolean;
  workloads?: string[];
}

export interface ManifestPermissions {
  roles: { name: string; description?: string }[];
  default: "deny" | "allow";
  rules?: {
    effect: "allow" | "deny";
    roles: string[];
    actions: string[];
    resources: string[];
    condition?: Record<string, unknown>;
  }[];
}

export interface ManifestPolicies {
  runtime?: {
    maxDurationMs?: number;
    memoryMb?: number;
    maxConcurrency?: number;
    maxRequestsPerMinute?: number;
    maxRequestBytes?: number;
    maxResponseBytes?: number;
  };
  budget?: {
    maxBuildsPerHour?: number;
    maxDeploymentsPerHour?: number;
    maxMonthlySpendUsd?: number;
  };
  lifecycle?: {
    autoSuspendAfterMinutes?: number;
  };
}

export interface ManifestSource {
  manifest: ApplicationManifest;
  source: "declared" | "inferred";
  path?: typeof FABRIC_MANIFEST_PATH;
}

export interface ManifestProjectService {
  name: string;
  kind: "web" | "worker" | "cron";
  root: string;
  runtime: ManifestRuntime;
  buildCommand?: string[];
  startCommand?: string[];
  healthCheckPath?: string;
}

export const FABRIC_MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://fabric.dev/schemas/application-v1alpha1.json",
  title: "Fabric Application",
  type: "object",
  required: ["apiVersion", "kind", "metadata", "spec"],
  additionalProperties: false,
  properties: {
    apiVersion: { const: FABRIC_MANIFEST_API_VERSION },
    kind: { const: "Application" },
    metadata: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 2_000 },
        labels: {
          type: "object",
          additionalProperties: { type: "string", maxLength: 200 },
        },
      },
    },
    spec: {
      type: "object",
      required: ["workloads"],
      properties: {
        workloads: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "kind", "runtime", "root"],
            properties: {
              name: { type: "string" },
              kind: {
                enum: ["web", "function", "worker", "cron", "workflow"],
              },
              runtime: { enum: ["auto", "nodejs", "python", "go"] },
              root: { type: "string" },
              entry: { type: "string" },
              buildCommand: { type: "array", items: { type: "string" } },
              startCommand: { type: "array", items: { type: "string" } },
              healthCheckPath: { type: "string" },
            },
          },
        },
        triggers: { type: "array" },
        resources: { type: "array" },
        data: { type: "object" },
        secrets: { type: "array" },
        permissions: { type: "object" },
        policies: { type: "object" },
      },
    },
  },
} as const;

export function defineApplicationManifest(
  input: Omit<ApplicationManifest, "apiVersion" | "kind">,
): ApplicationManifest {
  return parseApplicationManifest({
    apiVersion: FABRIC_MANIFEST_API_VERSION,
    kind: "Application",
    ...input,
  });
}

export function parseApplicationManifest(input: string | unknown): ApplicationManifest {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new Error(
        `invalid ${FABRIC_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const root = record(value, FABRIC_MANIFEST_PATH);
  if (root.apiVersion !== FABRIC_MANIFEST_API_VERSION) {
    throw new Error(
      `${FABRIC_MANIFEST_PATH}.apiVersion must be "${FABRIC_MANIFEST_API_VERSION}"`,
    );
  }
  if (root.kind !== "Application") {
    throw new Error(`${FABRIC_MANIFEST_PATH}.kind must be "Application"`);
  }
  const metadata = record(root.metadata, `${FABRIC_MANIFEST_PATH}.metadata`);
  const applicationName = requiredString(
    metadata.name,
    `${FABRIC_MANIFEST_PATH}.metadata.name`,
  );
  if (applicationName.length > 120) {
    throw new Error(`${FABRIC_MANIFEST_PATH}.metadata.name must be at most 120 characters`);
  }
  optionalString(metadata.description, `${FABRIC_MANIFEST_PATH}.metadata.description`, 2_000);
  if (metadata.labels !== undefined) {
    const labels = record(metadata.labels, `${FABRIC_MANIFEST_PATH}.metadata.labels`);
    for (const [name, label] of Object.entries(labels)) {
      requiredName(name, `${FABRIC_MANIFEST_PATH}.metadata.labels key`);
      optionalString(label, `${FABRIC_MANIFEST_PATH}.metadata.labels.${name}`, 200);
    }
  }
  const spec = record(root.spec, `${FABRIC_MANIFEST_PATH}.spec`);
  const workloads = array(spec.workloads, `${FABRIC_MANIFEST_PATH}.spec.workloads`);
  if (workloads.length === 0) {
    throw new Error(`${FABRIC_MANIFEST_PATH}.spec.workloads must not be empty`);
  }
  const workloadNames = new Set<string>();
  for (const [index, candidate] of workloads.entries()) {
    validateWorkload(
      candidate,
      `${FABRIC_MANIFEST_PATH}.spec.workloads[${index}]`,
      workloadNames,
    );
  }
  const resources = optionalArray(spec.resources, `${FABRIC_MANIFEST_PATH}.spec.resources`);
  const resourceNames = validateResources(resources);
  validateTriggers(
    optionalArray(spec.triggers, `${FABRIC_MANIFEST_PATH}.spec.triggers`),
    workloadNames,
    resourceNames,
  );
  const modelNames = validateData(spec.data);
  validateSecrets(spec.secrets, workloadNames);
  validatePermissions(spec.permissions);
  validatePolicies(spec.policies);
  validateReferences(spec.data, modelNames);
  return structuredClone(value) as ApplicationManifest;
}

export function applicationManifestFromFiles(
  files: { path: string; content: string; encoding: "utf8" | "base64" }[],
  fallback: { name: string; services: ManifestProjectService[] },
): ManifestSource {
  const file = files.find((candidate) => candidate.path === FABRIC_MANIFEST_PATH);
  if (!file) {
    return {
      manifest: inferredApplicationManifest(fallback.name, fallback.services),
      source: "inferred",
    };
  }
  if (file.encoding !== "utf8") {
    throw new Error(`${FABRIC_MANIFEST_PATH} must be UTF-8 JSON`);
  }
  return {
    manifest: parseApplicationManifest(file.content),
    source: "declared",
    path: FABRIC_MANIFEST_PATH,
  };
}

export function inferredApplicationManifest(
  name: string,
  services: ManifestProjectService[],
): ApplicationManifest {
  return defineApplicationManifest({
    metadata: { name },
    spec: {
      workloads: services.map((service) => ({
        name: service.name,
        kind: service.kind,
        runtime: service.runtime,
        root: service.root,
        ...(service.buildCommand ? { buildCommand: service.buildCommand } : {}),
        ...(service.startCommand ? { startCommand: service.startCommand } : {}),
        ...(service.healthCheckPath
          ? { healthCheckPath: service.healthCheckPath }
          : {}),
      })),
      triggers: services.reduce<ManifestTrigger[]>((triggers, service) => {
        if (service.kind === "web") {
          triggers.push({
            name: `${service.name}-http`,
            type: "http",
            workload: service.name,
          });
        } else if (service.kind === "cron") {
          triggers.push({
            name: `${service.name}-manual`,
            type: "manual",
            workload: service.name,
          });
        }
        return triggers;
      }, []),
      permissions: { roles: [{ name: "owner" }], default: "deny" },
    },
  });
}

export function manifestProjectServices(
  manifest: ApplicationManifest,
): ManifestProjectService[] {
  return manifest.spec.workloads.map((workload) => ({
    name: workload.name,
    kind:
      workload.kind === "cron"
        ? "cron"
        : workload.kind === "worker" || workload.kind === "workflow"
          ? "worker"
          : "web",
    root: workload.root,
    runtime: workload.runtime,
    ...(workload.buildCommand ? { buildCommand: workload.buildCommand } : {}),
    ...(workload.startCommand ? { startCommand: workload.startCommand } : {}),
    ...(workload.healthCheckPath
      ? { healthCheckPath: workload.healthCheckPath }
      : {}),
  }));
}

export function serializeApplicationManifest(manifest: ApplicationManifest): string {
  return `${JSON.stringify(parseApplicationManifest(manifest), null, 2)}\n`;
}

function validateWorkload(
  value: unknown,
  path: string,
  names: Set<string>,
): void {
  const workload = record(value, path);
  const name = requiredName(workload.name, `${path}.name`);
  unique(names, name, `${path}.name`);
  oneOf(
    workload.kind,
    ["web", "function", "worker", "cron", "workflow"],
    `${path}.kind`,
  );
  oneOf(workload.runtime, ["auto", "nodejs", "python", "go"], `${path}.runtime`);
  safeRoot(workload.root, `${path}.root`);
  optionalPath(workload.entry, `${path}.entry`);
  optionalCommand(workload.buildCommand, `${path}.buildCommand`);
  optionalCommand(workload.startCommand, `${path}.startCommand`);
  if (workload.healthCheckPath !== undefined) {
    const health = requiredString(workload.healthCheckPath, `${path}.healthCheckPath`);
    if (!health.startsWith("/")) throw new Error(`${path}.healthCheckPath must start with "/"`);
  }
}

function validateResources(values: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const [index, value] of values.entries()) {
    const path = `${FABRIC_MANIFEST_PATH}.spec.resources[${index}]`;
    const resource = record(value, path);
    const name = requiredName(resource.name, `${path}.name`);
    unique(names, name, `${path}.name`);
    oneOf(
      resource.type,
      [
        "relational_database",
        "object_storage",
        "key_value",
        "durable_queue",
        "connector",
      ],
      `${path}.type`,
    );
    optionalString(resource.description, `${path}.description`, 2_000);
    optionalString(resource.plan, `${path}.plan`, 100);
    optionalString(resource.region, `${path}.region`, 100);
    if (resource.configuration !== undefined) {
      record(resource.configuration, `${path}.configuration`);
    }
  }
  return names;
}

function validateTriggers(
  values: unknown[],
  workloads: Set<string>,
  resources: Set<string>,
): void {
  const names = new Set<string>();
  for (const [index, value] of values.entries()) {
    const path = `${FABRIC_MANIFEST_PATH}.spec.triggers[${index}]`;
    const trigger = record(value, path);
    const name = requiredName(trigger.name, `${path}.name`);
    unique(names, name, `${path}.name`);
    const type = oneOf(
      trigger.type,
      ["http", "schedule", "webhook", "queue", "event", "manual"],
      `${path}.type`,
    );
    const workload = requiredName(trigger.workload, `${path}.workload`);
    if (!workloads.has(workload)) {
      throw new Error(`${path}.workload references unknown workload "${workload}"`);
    }
    if (type === "schedule") requiredString(trigger.cron, `${path}.cron`);
    if (type === "webhook") {
      const webhookPath = requiredString(trigger.path, `${path}.path`);
      if (!webhookPath.startsWith("/")) throw new Error(`${path}.path must start with "/"`);
    }
    if (type === "queue") {
      const resource = requiredName(trigger.resource, `${path}.resource`);
      if (!resources.has(resource)) {
        throw new Error(`${path}.resource references unknown resource "${resource}"`);
      }
    }
    if (type === "event") {
      requiredString(trigger.source, `${path}.source`);
      requiredString(trigger.event, `${path}.event`);
    }
    if (type === "http" && trigger.methods !== undefined) {
      const methods = array(trigger.methods, `${path}.methods`);
      for (const [methodIndex, method] of methods.entries()) {
        const normalized = requiredString(method, `${path}.methods[${methodIndex}]`).toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(normalized)) {
          throw new Error(`${path}.methods[${methodIndex}] is not an HTTP method`);
        }
      }
    }
  }
}

function validateData(value: unknown): Set<string> {
  const names = new Set<string>();
  if (value === undefined) return names;
  const data = record(value, `${FABRIC_MANIFEST_PATH}.spec.data`);
  const models = array(data.models, `${FABRIC_MANIFEST_PATH}.spec.data.models`);
  for (const [modelIndex, value] of models.entries()) {
    const path = `${FABRIC_MANIFEST_PATH}.spec.data.models[${modelIndex}]`;
    const model = record(value, path);
    const name = requiredName(model.name, `${path}.name`);
    unique(names, name, `${path}.name`);
    const fields = array(model.fields, `${path}.fields`);
    const fieldNames = new Set<string>();
    for (const [fieldIndex, candidate] of fields.entries()) {
      const fieldPath = `${path}.fields[${fieldIndex}]`;
      const field = record(candidate, fieldPath);
      const fieldName = requiredName(field.name, `${fieldPath}.name`);
      unique(fieldNames, fieldName, `${fieldPath}.name`);
      const type = oneOf(
        field.type,
        [
          "string",
          "text",
          "integer",
          "number",
          "boolean",
          "date",
          "datetime",
          "json",
          "enum",
          "reference",
        ],
        `${fieldPath}.type`,
      );
      if (type === "enum" && optionalArray(field.enum, `${fieldPath}.enum`).length === 0) {
        throw new Error(`${fieldPath}.enum must not be empty`);
      }
      if (type === "reference") {
        const reference = record(field.references, `${fieldPath}.references`);
        requiredName(reference.model, `${fieldPath}.references.model`);
      }
    }
    if (model.indexes !== undefined) {
      for (const [indexIndex, candidate] of array(model.indexes, `${path}.indexes`).entries()) {
        const indexPath = `${path}.indexes[${indexIndex}]`;
        const index = record(candidate, indexPath);
        requiredName(index.name, `${indexPath}.name`);
        for (const field of array(index.fields, `${indexPath}.fields`)) {
          const fieldName = requiredName(field, `${indexPath}.fields`);
          if (!fieldNames.has(fieldName)) {
            throw new Error(`${indexPath} references unknown field "${fieldName}"`);
          }
        }
      }
    }
  }
  return names;
}

function validateReferences(value: unknown, models: Set<string>): void {
  if (value === undefined) return;
  const data = record(value, `${FABRIC_MANIFEST_PATH}.spec.data`);
  for (const [modelIndex, value] of array(data.models, "models").entries()) {
    const model = record(value, "model");
    for (const [fieldIndex, candidate] of array(model.fields, "fields").entries()) {
      const field = record(candidate, "field");
      if (field.type !== "reference") continue;
      const reference = record(field.references, "references");
      if (!models.has(String(reference.model))) {
        throw new Error(
          `${FABRIC_MANIFEST_PATH}.spec.data.models[${modelIndex}].fields[${fieldIndex}] references unknown model "${reference.model}"`,
        );
      }
    }
  }
  const relationships = optionalArray(
    data.relationships,
    `${FABRIC_MANIFEST_PATH}.spec.data.relationships`,
  );
  const names = new Set<string>();
  for (const [index, candidate] of relationships.entries()) {
    const path = `${FABRIC_MANIFEST_PATH}.spec.data.relationships[${index}]`;
    const relationship = record(candidate, path);
    unique(names, requiredName(relationship.name, `${path}.name`), `${path}.name`);
    for (const side of ["from", "to"] as const) {
      const endpoint = record(relationship[side], `${path}.${side}`);
      const model = requiredName(endpoint.model, `${path}.${side}.model`);
      requiredName(endpoint.field, `${path}.${side}.field`);
      if (!models.has(model)) {
        throw new Error(`${path}.${side}.model references unknown model "${model}"`);
      }
    }
    oneOf(
      relationship.cardinality,
      ["one_to_one", "one_to_many", "many_to_many"],
      `${path}.cardinality`,
    );
    if (relationship.onDelete !== undefined) {
      oneOf(
        relationship.onDelete,
        ["restrict", "cascade", "set_null"],
        `${path}.onDelete`,
      );
    }
  }
}

function validateSecrets(value: unknown, workloads: Set<string>): void {
  const secrets = optionalArray(value, `${FABRIC_MANIFEST_PATH}.spec.secrets`);
  const names = new Set<string>();
  for (const [index, candidate] of secrets.entries()) {
    const path = `${FABRIC_MANIFEST_PATH}.spec.secrets[${index}]`;
    const secret = record(candidate, path);
    unique(names, requiredName(secret.name, `${path}.name`), `${path}.name`);
    for (const workload of optionalArray(secret.workloads, `${path}.workloads`)) {
      const name = requiredName(workload, `${path}.workloads`);
      if (!workloads.has(name)) {
        throw new Error(`${path}.workloads references unknown workload "${name}"`);
      }
    }
  }
}

function validatePermissions(value: unknown): void {
  if (value === undefined) return;
  const path = `${FABRIC_MANIFEST_PATH}.spec.permissions`;
  const permissions = record(value, path);
  oneOf(permissions.default, ["deny", "allow"], `${path}.default`);
  const roles = new Set<string>();
  for (const [index, candidate] of array(permissions.roles, `${path}.roles`).entries()) {
    const role = record(candidate, `${path}.roles[${index}]`);
    unique(
      roles,
      requiredName(role.name, `${path}.roles[${index}].name`),
      `${path}.roles[${index}].name`,
    );
  }
  for (const [index, candidate] of optionalArray(permissions.rules, `${path}.rules`).entries()) {
    const rulePath = `${path}.rules[${index}]`;
    const rule = record(candidate, rulePath);
    oneOf(rule.effect, ["allow", "deny"], `${rulePath}.effect`);
    for (const role of array(rule.roles, `${rulePath}.roles`)) {
      const name = requiredName(role, `${rulePath}.roles`);
      if (!roles.has(name)) throw new Error(`${rulePath} references unknown role "${name}"`);
    }
    stringArray(rule.actions, `${rulePath}.actions`);
    stringArray(rule.resources, `${rulePath}.resources`);
  }
}

function validatePolicies(value: unknown): void {
  if (value === undefined) return;
  const policies = record(value, `${FABRIC_MANIFEST_PATH}.spec.policies`);
  if (policies.runtime !== undefined) {
    const runtime = record(policies.runtime, "policies.runtime");
    bounded(runtime.maxDurationMs, "policies.runtime.maxDurationMs", 1_000, 300_000);
    bounded(runtime.memoryMb, "policies.runtime.memoryMb", 128, 4_096);
    bounded(runtime.maxConcurrency, "policies.runtime.maxConcurrency", 1, 1_000);
    bounded(
      runtime.maxRequestsPerMinute,
      "policies.runtime.maxRequestsPerMinute",
      1,
      100_000,
    );
    bounded(runtime.maxRequestBytes, "policies.runtime.maxRequestBytes", 1_024, 104_857_600);
    bounded(
      runtime.maxResponseBytes,
      "policies.runtime.maxResponseBytes",
      1_024,
      104_857_600,
    );
  }
  if (policies.budget !== undefined) {
    const budget = record(policies.budget, "policies.budget");
    bounded(budget.maxBuildsPerHour, "policies.budget.maxBuildsPerHour", 1, 10_000);
    bounded(
      budget.maxDeploymentsPerHour,
      "policies.budget.maxDeploymentsPerHour",
      1,
      10_000,
    );
    bounded(budget.maxMonthlySpendUsd, "policies.budget.maxMonthlySpendUsd", 0, 1_000_000);
  }
  if (policies.lifecycle !== undefined) {
    const lifecycle = record(policies.lifecycle, "policies.lifecycle");
    bounded(
      lifecycle.autoSuspendAfterMinutes,
      "policies.lifecycle.autoSuspendAfterMinutes",
      1,
      525_600,
    );
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function optionalArray(value: unknown, path: string): unknown[] {
  return value === undefined ? [] : array(value, path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requiredName(value: unknown, path: string): string {
  const name = requiredString(value, path);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/.test(name)) {
    throw new Error(`${path} must start with a letter and contain only letters, digits, _ or -`);
  }
  return name;
}

function optionalString(value: unknown, path: string, maximum: number): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${path} must be a string of at most ${maximum} characters`);
  }
}

function safeRoot(value: unknown, path: string): void {
  const root = requiredString(value, path);
  if (
    root.startsWith("/") ||
    root.includes("\\") ||
    root.split("/").some((part) => part === "..")
  ) {
    throw new Error(`${path} must be a safe project-relative path`);
  }
}

function optionalPath(value: unknown, path: string): void {
  if (value === undefined) return;
  safeRoot(value, path);
}

function optionalCommand(value: unknown, path: string): void {
  if (value === undefined) return;
  const command = stringArray(value, path);
  if (command.length === 0) throw new Error(`${path} must not be empty`);
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((candidate, index) =>
    requiredString(candidate, `${path}[${index}]`),
  );
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${path} must be one of ${choices.join(", ")}`);
  }
  return value;
}

function unique(values: Set<string>, value: string, path: string): void {
  if (values.has(value)) throw new Error(`${path} duplicates "${value}"`);
  values.add(value);
}

function bounded(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${path} must be between ${minimum} and ${maximum}`);
  }
}

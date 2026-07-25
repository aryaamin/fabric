import {
  BaseCapability,
  type Capability,
  type CapabilityContext,
  type CapabilityFactory,
  type CapabilityManifest,
  type FactoryEnv,
  type SchemaShape,
} from "@fabric/capabilities";

export interface OpenApiDocument {
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string }[];
  paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: {
    name: string;
    in: "path" | "query" | "header";
    required?: boolean;
    schema?: OpenApiSchema;
  }[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
}

interface OpenApiSchema {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
}

interface OperationPlan {
  name: string;
  method: string;
  path: string;
  operation: OpenApiOperation;
}

export interface OpenApiCapabilityOptions {
  name?: string;
  baseUrl?: string;
  /** Secret name containing a bearer token. */
  bearerTokenSecret?: string;
}

export function openApiCapabilityFactory(
  document: OpenApiDocument,
  options: OpenApiCapabilityOptions = {},
): CapabilityFactory {
  const plans = operationPlans(document);
  const name = options.name ?? slug(document.info?.title ?? "openapi");
  const manifest: CapabilityManifest = {
    name,
    version: document.info?.version ?? "0.0.0",
    description: document.info?.description ?? `Generated from ${document.info?.title ?? "OpenAPI"}`,
    methods: plans.map((plan) => ({
      name: plan.name,
      description: plan.operation.description ?? plan.operation.summary,
      input: inputSchema(plan),
      output: { type: "json" },
      mutates: plan.method !== "GET",
    })),
    config: { baseUrl: { type: "string" } },
    secrets: options.bearerTokenSecret ? [options.bearerTokenSecret] : [],
  };

  return {
    manifest,
    create(config, env) {
      const baseUrl = String(
        config.baseUrl ?? options.baseUrl ?? document.servers?.[0]?.url ?? "",
      ).replace(/\/$/, "");
      if (!baseUrl) throw new Error(`OpenAPI capability "${name}" needs a baseUrl`);
      return new OpenApiCapability(manifest, plans, baseUrl, env, options);
    },
  };
}

class OpenApiCapability extends BaseCapability {
  readonly manifest: CapabilityManifest;
  protected handlers: Record<
    string,
    (args: Record<string, unknown>, context: CapabilityContext) => Promise<unknown>
  >;

  constructor(
    manifest: CapabilityManifest,
    plans: OperationPlan[],
    baseUrl: string,
    env: FactoryEnv,
    options: OpenApiCapabilityOptions,
  ) {
    super();
    this.manifest = manifest;
    this.handlers = Object.fromEntries(
      plans.map((plan) => [
        plan.name,
        async (args: Record<string, unknown>, context: CapabilityContext) => {
          const url = new URL(interpolate(plan.path, args), `${baseUrl}/`);
          const headers = new Headers({ accept: "application/json" });
          const token = options.bearerTokenSecret
            ? env.secrets.get(options.bearerTokenSecret)
            : undefined;
          if (token) headers.set("authorization", `Bearer ${token}`);

          for (const parameter of plan.operation.parameters ?? []) {
            const value = args[parameter.name];
            if (value === undefined || parameter.in === "path") continue;
            if (parameter.in === "query") url.searchParams.set(parameter.name, String(value));
            if (parameter.in === "header") headers.set(parameter.name, String(value));
          }

          const init: RequestInit = { method: plan.method, headers, signal: context.signal };
          if (plan.operation.requestBody && args.body !== undefined) {
            headers.set("content-type", "application/json");
            init.body = JSON.stringify(args.body);
          }
          const response = await fetch(url, init);
          const responseType = response.headers.get("content-type") ?? "";
          const output = responseType.includes("json") ? await response.json() : await response.text();
          if (!response.ok) {
            throw new Error(`${plan.method} ${url.pathname} returned ${response.status}: ${JSON.stringify(output)}`);
          }
          return output;
        },
      ]),
    );
  }
}

function operationPlans(document: OpenApiDocument): OperationPlan[] {
  const out: OperationPlan[] = [];
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, value] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method) || !value) continue;
      const operation = value as OpenApiOperation;
      out.push({
        name: operation.operationId ?? slug(`${method}_${path}`),
        method: method.toUpperCase(),
        path,
        operation,
      });
    }
  }
  return out;
}

function inputSchema(plan: OperationPlan): Record<string, SchemaShape> {
  const input: Record<string, SchemaShape> = {};
  for (const parameter of plan.operation.parameters ?? []) {
    input[parameter.name] = {
      ...toFabricSchema(parameter.schema),
      required: parameter.required ?? parameter.in === "path",
    };
  }
  if (plan.operation.requestBody) {
    const schema = Object.values(plan.operation.requestBody.content ?? {})[0]?.schema;
    input.body = { ...toFabricSchema(schema), required: plan.operation.requestBody.required };
  }
  return input;
}

function toFabricSchema(schema?: OpenApiSchema): SchemaShape {
  const type = schema?.type;
  if (type === "integer" || type === "number") return { type: "number", description: schema?.description };
  if (type === "boolean") return { type: "boolean", description: schema?.description };
  if (type === "array") return { type: "array", items: toFabricSchema(schema?.items) };
  if (type === "object") {
    return {
      type: "object",
      fields: Object.fromEntries(
        Object.entries(schema?.properties ?? {}).map(([key, value]) => [
          key,
          { ...toFabricSchema(value), required: schema?.required?.includes(key) },
        ]),
      ),
    };
  }
  return {
    type: "string",
    description: schema?.description,
    enum: schema?.enum,
  };
}

function interpolate(path: string, args: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = args[key];
    if (value === undefined) throw new Error(`missing path parameter "${key}"`);
    return encodeURIComponent(String(value));
  });
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

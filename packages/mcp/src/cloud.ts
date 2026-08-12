import type {
  Build,
  BuildEvent,
  BuildPlan,
  Deployment,
  FabricExecutionPolicy,
  WorkspaceUsage,
} from "@fabric/cloud";
import type {
  CloudProject,
  CreateProjectInput,
  ApplicationManifest,
  ManifestSource,
  LogicalSchema,
  ProjectSnapshot,
  SchemaMigrationPlan,
  SourceFile,
  SourceFileInput,
} from "@fabric/projects";
import { FABRIC_MANIFEST_JSON_SCHEMA } from "@fabric/projects";
import type { Principal } from "@fabric/permissions";

export interface CloudMcpProject {
  project: CloudProject;
  role: "owner" | "editor" | "viewer";
  slug: string;
  editorUrl: string;
}

export interface CloudMcpDeployment {
  deploymentId: string;
  projectId: string;
  buildId?: string;
  state: Deployment["state"];
  createdAt: string;
  updatedAt: string;
  error?: string;
  editorUrl: string;
  appUrl?: string;
}

export interface CloudMcpProjectLinks {
  projectId: string;
  deploymentId: string;
  editorUrl: string;
  appUrl: string;
}

export interface CloudMcpSafetyStatus {
  policy: FabricExecutionPolicy;
  usage: WorkspaceUsage;
  suspended: boolean;
  suspensionReason?: string;
  projectSuspended: boolean;
  projectReason?: string;
}

/** Authenticated control-plane port shared by remote MCP and REST adapters. */
export interface CloudMcpApi {
  listProjects(principal: Principal): Promise<CloudMcpProject[]>;
  createProject(principal: Principal, input: CreateProjectInput): Promise<CloudMcpProject>;
  listFiles(principal: Principal, projectId: string): Promise<SourceFile[]>;
  writeFiles(
    principal: Principal,
    projectId: string,
    files: SourceFileInput[],
  ): Promise<SourceFile[]>;
  getApplicationManifest(
    principal: Principal,
    projectId: string,
    snapshotId?: string,
  ): Promise<ManifestSource & { snapshotId?: string }>;
  writeApplicationManifest(
    principal: Principal,
    projectId: string,
    manifest: ApplicationManifest,
  ): Promise<ManifestSource>;
  inspectApplicationSchema(
    principal: Principal,
    projectId: string,
    snapshotId?: string,
  ): Promise<{
    projectId: string;
    snapshotId?: string;
    source: ManifestSource["source"];
    schema: LogicalSchema;
  }>;
  previewSchemaMigration(
    principal: Principal,
    projectId: string,
    baselineSnapshotId?: string,
  ): Promise<{
    projectId: string;
    baselineSnapshotId?: string;
    current: LogicalSchema;
    desired: LogicalSchema;
    plan: SchemaMigrationPlan;
  }>;
  listSchemaMigrations(
    principal: Principal,
    projectId: string,
  ): Promise<{ reviews: unknown[]; runs: unknown[] }>;
  sealSnapshot(
    principal: Principal,
    projectId: string,
    input: { message?: string; expectedHeadId?: string | null },
  ): Promise<ProjectSnapshot>;
  inspectBuildPlans(
    principal: Principal,
    projectId: string,
    snapshotId?: string,
  ): Promise<BuildPlan[]>;
  requestBuild(
    principal: Principal,
    input: {
      projectId: string;
      snapshotId?: string;
      service?: string;
      idempotencyKey: string;
    },
  ): Promise<Build>;
  getBuild(principal: Principal, projectId: string, buildId: string): Promise<Build>;
  listBuildEvents(
    principal: Principal,
    projectId: string,
    buildId: string,
    after?: number,
    limit?: number,
  ): Promise<BuildEvent[]>;
  requestDeployment(
    principal: Principal,
    input: { projectId: string; buildId: string; idempotencyKey: string },
  ): Promise<CloudMcpDeployment>;
  getDeployment(
    principal: Principal,
    projectId: string,
    deploymentId: string,
  ): Promise<CloudMcpDeployment>;
  publishProject(
    principal: Principal,
    projectId: string,
    deploymentId: string,
  ): Promise<CloudMcpProjectLinks>;
  getCloudStatus(
    principal: Principal,
    projectId: string,
  ): Promise<CloudMcpSafetyStatus>;
  setProjectSuspended(
    principal: Principal,
    projectId: string,
    suspended: boolean,
    reason?: string,
  ): Promise<CloudMcpSafetyStatus>;
}

export interface CloudMcpServerOptions {
  api: CloudMcpApi;
  principal: Principal;
  name?: string;
  version?: string;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class FabricCloudMcpServer {
  private readonly api: CloudMcpApi;
  private readonly principal: Principal;
  private readonly name: string;
  private readonly version: string;

  constructor(options: CloudMcpServerOptions) {
    if (!options.principal.id) throw new Error("MCP principal is required");
    this.api = options.api;
    this.principal = options.principal;
    this.name = options.name ?? "fabric-cloud";
    this.version = options.version ?? "0.1.0";
  }

  async handle(request: RpcRequest): Promise<unknown> {
    if (request.jsonrpc !== "2.0") throw rpcError(-32600, "JSON-RPC 2.0 required");
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
          instructions:
            "Fabric is the user's cloud. Inspect fabric_get_application_manifest and fabric_inspect_schema before changing an existing project. After changing a logical data schema, call fabric_preview_schema_migration before sealing: never continue silently when the preview is destructive or requires approval. Use fabric_list_schema_migrations to report owner approvals, backups, validation failures, successful applies, and rollbacks; AI connections cannot approve, apply, or roll back migrations. For a new project, declare workloads, triggers, resources, data, secrets, permissions, and policies with fabric_put_application_manifest; then write code, seal a snapshot, build, deploy, publish, and return Fabric app/editor URLs. Never ask the user for cloud-provider accounts, tokens, databases, raw SQL, or infrastructure setup.",
        };
      case "ping":
      case "notifications/initialized":
      case "notifications/cancelled":
        return {};
      case "tools/list":
        return { tools: CLOUD_TOOLS };
      case "tools/call":
        return this.callTool(
          String(request.params?.name ?? ""),
          (request.params?.arguments ?? {}) as Record<string, unknown>,
        );
      default:
        throw rpcError(-32601, `method not found: ${request.method}`);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    try {
      switch (name) {
        case "fabric_list_projects":
          return result(await this.api.listProjects(this.principal));
        case "fabric_create_project":
          return result(
            await this.api.createProject(this.principal, {
              name: requiredString(args, "name"),
              slug: optionalString(args, "slug"),
              mode: "source",
            }),
          );
        case "fabric_list_files":
          return result(
            await this.api.listFiles(this.principal, requiredString(args, "projectId")),
          );
        case "fabric_write_files":
          return result(
            await this.api.writeFiles(
              this.principal,
              requiredString(args, "projectId"),
              requiredArray(args, "files") as SourceFileInput[],
            ),
          );
        case "fabric_get_application_manifest":
          return result(
            await this.api.getApplicationManifest(
              this.principal,
              requiredString(args, "projectId"),
              optionalString(args, "snapshotId"),
            ),
          );
        case "fabric_put_application_manifest":
          return result(
            await this.api.writeApplicationManifest(
              this.principal,
              requiredString(args, "projectId"),
              requiredObject(args, "manifest") as unknown as ApplicationManifest,
            ),
          );
        case "fabric_inspect_schema":
          return result(
            await this.api.inspectApplicationSchema(
              this.principal,
              requiredString(args, "projectId"),
              optionalString(args, "snapshotId"),
            ),
          );
        case "fabric_preview_schema_migration":
          return result(
            await this.api.previewSchemaMigration(
              this.principal,
              requiredString(args, "projectId"),
              optionalString(args, "baselineSnapshotId"),
            ),
          );
        case "fabric_list_schema_migrations":
          return result(
            await this.api.listSchemaMigrations(
              this.principal,
              requiredString(args, "projectId"),
            ),
          );
        case "fabric_seal_snapshot":
          return result(
            await this.api.sealSnapshot(
              this.principal,
              requiredString(args, "projectId"),
              {
                message: optionalString(args, "message"),
                expectedHeadId: optionalNullableString(args, "expectedHeadId"),
              },
            ),
          );
        case "fabric_inspect_build_plans":
          return result(
            await this.api.inspectBuildPlans(
              this.principal,
              requiredString(args, "projectId"),
              optionalString(args, "snapshotId"),
            ),
          );
        case "fabric_request_build":
          return result(
            await this.api.requestBuild(this.principal, {
              projectId: requiredString(args, "projectId"),
              snapshotId: optionalString(args, "snapshotId"),
              service: optionalString(args, "service"),
              idempotencyKey: requiredString(args, "idempotencyKey"),
            }),
          );
        case "fabric_get_build":
          return result(
            await this.api.getBuild(
              this.principal,
              requiredString(args, "projectId"),
              requiredString(args, "buildId"),
            ),
          );
        case "fabric_build_logs":
          return result(
            await this.api.listBuildEvents(
              this.principal,
              requiredString(args, "projectId"),
              requiredString(args, "buildId"),
              optionalNumber(args, "after"),
              optionalNumber(args, "limit"),
            ),
          );
        case "fabric_request_deployment":
          return result(
            await this.api.requestDeployment(this.principal, {
              projectId: requiredString(args, "projectId"),
              buildId: requiredString(args, "buildId"),
              idempotencyKey: requiredString(args, "idempotencyKey"),
            }),
          );
        case "fabric_get_deployment":
          return result(
            await this.api.getDeployment(
              this.principal,
              requiredString(args, "projectId"),
              requiredString(args, "deploymentId"),
            ),
          );
        case "fabric_publish_project":
          return result(
            await this.api.publishProject(
              this.principal,
              requiredString(args, "projectId"),
              requiredString(args, "deploymentId"),
            ),
          );
        case "fabric_get_cloud_status":
          return result(
            await this.api.getCloudStatus(
              this.principal,
              requiredString(args, "projectId"),
            ),
          );
        case "fabric_set_project_suspended":
          return result(
            await this.api.setProjectSuspended(
              this.principal,
              requiredString(args, "projectId"),
              requiredBoolean(args, "suspended"),
              optionalString(args, "reason"),
            ),
          );
        default:
          throw new Error(`unknown tool "${name}"`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }
}

const CLOUD_TOOLS: Record<string, unknown>[] = [
  tool("fabric_list_projects", "List cloud projects visible to the authenticated principal.", {}),
  tool(
    "fabric_create_project",
    "Create a provider-neutral source project.",
    {
      name: { type: "string" },
      slug: { type: "string" },
    },
    ["name"],
  ),
  tool(
    "fabric_list_files",
    "List the editable working files for a project.",
    { projectId: { type: "string" } },
    ["projectId"],
  ),
  tool(
    "fabric_write_files",
    "Create or replace project files. Paths are relative and content is UTF-8 by default.",
    {
      projectId: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            encoding: { enum: ["utf8", "base64"] },
            executable: { type: "boolean" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    ["projectId", "files"],
  ),
  tool(
    "fabric_get_application_manifest",
    "Read the canonical Fabric application model for an editable working tree or immutable snapshot. Always call this before changing an existing application.",
    {
      projectId: { type: "string" },
      snapshotId: { type: "string" },
    },
    ["projectId"],
  ),
  tool(
    "fabric_put_application_manifest",
    "Validate and save the canonical application model. Declare cloud intent here before writing implementation code.",
    {
      projectId: { type: "string" },
      manifest: FABRIC_MANIFEST_JSON_SCHEMA,
    },
    ["projectId", "manifest"],
  ),
  tool(
    "fabric_inspect_schema",
    "Inspect the canonical logical schema and deterministic version without database credentials or SQL access.",
    {
      projectId: { type: "string" },
      snapshotId: { type: "string" },
    },
    ["projectId"],
  ),
  tool(
    "fabric_preview_schema_migration",
    "Compare the working logical schema with a sealed baseline. Returns safe, backfill-required, or destructive changes plus approval, backup, and validation requirements. Call before sealing schema changes.",
    {
      projectId: { type: "string" },
      baselineSnapshotId: { type: "string" },
    },
    ["projectId"],
  ),
  tool(
    "fabric_list_schema_migrations",
    "List schema approvals, backup-backed migration runs, validation failures, successful applies, and rollbacks. This tool is read-only.",
    { projectId: { type: "string" } },
    ["projectId"],
  ),
  tool(
    "fabric_seal_snapshot",
    "Seal the working tree as an immutable snapshot and atomically move project head.",
    {
      projectId: { type: "string" },
      message: { type: "string" },
      expectedHeadId: { type: ["string", "null"] },
    },
    ["projectId"],
  ),
  tool(
    "fabric_inspect_build_plans",
    "Inspect deterministic runtime/build plans without executing them.",
    {
      projectId: { type: "string" },
      snapshotId: { type: "string" },
    },
    ["projectId"],
  ),
  tool(
    "fabric_request_build",
    "Request an idempotent build for a sealed snapshot.",
    {
      projectId: { type: "string" },
      snapshotId: { type: "string" },
      service: { type: "string" },
      idempotencyKey: { type: "string" },
    },
    ["projectId", "idempotencyKey"],
  ),
  tool(
    "fabric_get_build",
    "Check whether a Fabric build is queued, running, successful, or failed.",
    {
      projectId: { type: "string" },
      buildId: { type: "string" },
    },
    ["projectId", "buildId"],
  ),
  tool(
    "fabric_build_logs",
    "Read ordered build logs using a numeric cursor.",
    {
      projectId: { type: "string" },
      buildId: { type: "string" },
      after: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    ["projectId", "buildId"],
  ),
  tool(
    "fabric_request_deployment",
    "Deploy a successful build through Fabric's provider-neutral deployment adapter.",
    {
      projectId: { type: "string" },
      buildId: { type: "string" },
      idempotencyKey: { type: "string" },
    },
    ["projectId", "buildId", "idempotencyKey"],
  ),
  tool(
    "fabric_get_deployment",
    "Get and refresh Fabric deployment state. Provider details remain private.",
    {
      projectId: { type: "string" },
      deploymentId: { type: "string" },
    },
    ["projectId", "deploymentId"],
  ),
  tool(
    "fabric_publish_project",
    "Publish a ready deployment and return Fabric-branded application and editor URLs. Call this after fabric_get_deployment reports READY.",
    {
      projectId: { type: "string" },
      deploymentId: { type: "string" },
    },
    ["projectId", "deploymentId"],
  ),
  tool(
    "fabric_get_cloud_status",
    "Inspect Fabric-enforced runtime limits, build/deployment quotas, usage, and suspension state.",
    {
      projectId: { type: "string" },
    },
    ["projectId"],
  ),
  tool(
    "fabric_set_project_suspended",
    "Owner-only emergency switch. Suspend to block application traffic, builds, and deployments; resume to allow them again. Only call when the user explicitly asks.",
    {
      projectId: { type: "string" },
      suspended: { type: "boolean" },
      reason: { type: "string", maxLength: 500 },
    },
    ["projectId", "suspended"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    name,
    description,
    securitySchemes: [{ type: "oauth2", scopes: ["fabric:projects"] }],
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalNullableString(
  args: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
  return value;
}

function requiredArray(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function requiredObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  return value;
}

function requiredBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function result(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

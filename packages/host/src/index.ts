import type { AppDocument } from "@fabric/ir";
import type { Principal } from "@fabric/permissions";
import { Runtime } from "@fabric/runtime";

export interface FabricHostOptions {
  runtime: Runtime;
  workspaceId?: string;
  authenticate?: (request: Request) => Principal | Promise<Principal>;
}

export interface InstallRequest {
  document: AppDocument;
  secrets?: Record<string, string>;
  message?: string;
}

export class FabricHost {
  readonly runtime: Runtime;
  readonly workspaceId: string;
  private authenticate: NonNullable<FabricHostOptions["authenticate"]>;

  constructor(options: FabricHostOptions) {
    this.runtime = options.runtime;
    this.workspaceId = options.workspaceId ?? "default";
    this.authenticate = options.authenticate ?? principalFromHeaders;
  }

  install(input: InstallRequest, principal: Principal): AppDocument {
    this.runtime.install(input.document, {
      workspaceId: this.workspaceId,
      secrets: input.secrets,
      author: principal.id,
      message: input.message,
    });
    return input.document;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    try {
      if (request.method === "GET" && parts[0] === "health") {
        return json({ ok: true, workspaceId: this.workspaceId });
      }

      const principal = await this.authenticate(request);
      if (request.method === "GET" && parts.length === 1 && parts[0] === "apps") {
        return json({
          apps: this.runtime.installedDocs(this.workspaceId).map(summarizeApp),
        });
      }

      if (request.method === "POST" && parts.length === 1 && parts[0] === "apps") {
        requireOwner(principal);
        const input = await body<InstallRequest>(request);
        return json({ ok: true, app: summarizeApp(this.install(input, principal)) }, 201);
      }

      if (parts[0] !== "apps" || !parts[1]) return problem(404, "route not found");
      const appId = parts[1];
      const doc = this.runtime.installed(appId);
      if (!doc) return problem(404, `app "${appId}" is not installed`);

      if (request.method === "GET" && parts.length === 2) {
        return json({ app: doc });
      }

      if (request.method === "GET" && parts[2] === "views" && parts[3]) {
        const view = await this.runtime.renderView(appId, parts[3], principal);
        return json({ appId, view: parts[3], tree: view });
      }

      if (request.method === "POST" && parts[2] === "actions" && parts[3]) {
        const input = await body<Record<string, unknown>>(request);
        const result = await this.runtime.invokeAction(appId, parts[3], input, principal);
        return json({ ok: true, result });
      }

      if (request.method === "POST" && parts[2] === "submit") {
        const input = await body<{
          view: string;
          action: string;
          fields: Record<string, unknown>;
        }>(request);
        const result = await this.runtime.submit(
          appId,
          input.view,
          input.action,
          input.fields ?? {},
          principal,
        );
        return json({ ok: true, ...result });
      }

      if (request.method === "GET" && parts[2] === "versions") {
        const head = this.runtime.versions.head(appId);
        return json({
          versions: this.runtime.versions.all(appId).map((version) => ({
            id: version.id,
            parent: version.parent,
            createdAt: version.createdAt,
            author: version.author,
            message: version.message,
            isHead: version.id === head?.id,
          })),
        });
      }

      return problem(404, "route not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /permission|owner|access/i.test(message) ? 403 : 400;
      return problem(status, message);
    }
  }
}

export function principalFromHeaders(request: Request): Principal {
  const id = request.headers.get("x-fabric-user") ?? "anonymous";
  const roles = (request.headers.get("x-fabric-roles") ?? "viewer")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return { id, roles };
}

function requireOwner(principal: Principal): void {
  if (!principal.roles.includes("owner")) throw new Error("owner role required");
}

function summarizeApp(doc: AppDocument) {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    views: doc.views.map((view) => view.name),
    actions: doc.actions.map((action) => action.name),
  };
}

async function body<T>(request: Request): Promise<T> {
  const value = await request.json();
  if (!value || typeof value !== "object") throw new Error("JSON object body required");
  return value as T;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function problem(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}

import type { AppDocument, FieldType } from "@fabric/ir";
import type { Principal } from "@fabric/permissions";
import type { FabricHost } from "@fabric/host";

export interface McpServerOptions {
  host: FabricHost;
  principal?: Principal;
  name?: string;
  version?: string;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export class FabricMcpServer {
  private host: FabricHost;
  private principal: Principal;
  private name: string;
  private version: string;

  constructor(options: McpServerOptions) {
    this.host = options.host;
    this.principal = options.principal ?? { id: "mcp", roles: ["owner"] };
    this.name = options.name ?? "fabric";
    this.version = options.version ?? "0.1.0";
  }

  async handle(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
          serverInfo: { name: this.name, version: this.version },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.tools() };
      case "tools/call":
        return this.callTool(
          String(request.params?.name ?? ""),
          (request.params?.arguments ?? {}) as Record<string, unknown>,
        );
      case "resources/list":
        return { resources: this.resources() };
      case "resources/read":
        return this.readResource(String(request.params?.uri ?? ""));
      case "notifications/initialized":
      case "notifications/cancelled":
        return {};
      default:
        throw rpcError(-32601, `method not found: ${request.method}`);
    }
  }

  async serveStdio(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    let buffer = "";
    input.setEncoding("utf8");
    for await (const chunk of input) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) await this.writeMessage(line, output);
        newline = buffer.indexOf("\n");
      }
    }
  }

  private async writeMessage(line: string, output: NodeJS.WritableStream): Promise<void> {
    let request: RpcRequest | undefined;
    try {
      request = JSON.parse(line) as RpcRequest;
      const result = await this.handle(request);
      if (request.id !== undefined) {
        output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      }
    } catch (error) {
      if (request?.id === undefined) return;
      const e = error as Error & { code?: number };
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: e.code ?? -32603, message: e.message },
        })}\n`,
      );
    }
  }

  private tools(): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [
      {
        name: "fabric_list_apps",
        description: "List applications installed in this Fabric workspace.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "fabric_install_app",
        description: "Install or update a validated Fabric application document.",
        inputSchema: {
          type: "object",
          properties: { document: { type: "object" }, message: { type: "string" } },
          required: ["document"],
          additionalProperties: false,
        },
      },
      {
        name: "fabric_version_history",
        description: "List immutable versions of a Fabric application.",
        inputSchema: {
          type: "object",
          properties: { appId: { type: "string" } },
          required: ["appId"],
          additionalProperties: false,
        },
      },
    ];

    for (const app of this.host.runtime.installedDocs(this.host.workspaceId)) {
      for (const action of app.actions) {
        tools.push({
          name: toolName(app.id, action.name),
          description: `Run ${app.name}.${action.name}.`,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              action.params.map((param) => [param.name, schemaForField(param.type)]),
            ),
            required: action.params.filter((param) => param.required).map((param) => param.name),
            additionalProperties: false,
          },
        });
      }
    }
    return tools;
  }

  private async callTool(name: string, args: Record<string, unknown>) {
    try {
      if (name === "fabric_list_apps") {
        return text(this.host.runtime.installedDocs(this.host.workspaceId).map(appSummary));
      }
      if (name === "fabric_install_app") {
        if (!this.principal.roles.includes("owner")) throw new Error("owner role required");
        const document = args.document as AppDocument;
        this.host.install({ document, message: String(args.message ?? "installed through MCP") }, this.principal);
        return text({ ok: true, app: appSummary(document) });
      }
      if (name === "fabric_version_history") {
        const appId = String(args.appId ?? "");
        const head = this.host.runtime.versions.head(appId);
        return text(
          this.host.runtime.versions.all(appId).map((version) => ({
            id: version.id,
            parent: version.parent,
            message: version.message,
            createdAt: version.createdAt,
            isHead: version.id === head?.id,
          })),
        );
      }

      const found = this.findActionTool(name);
      if (!found) throw new Error(`unknown tool "${name}"`);
      const result = await this.host.runtime.invokeAction(
        found.app.id,
        found.action.name,
        args,
        this.principal,
      );
      return text(result);
    } catch (error) {
      return {
        content: [{ type: "text", text: (error as Error).message }],
        isError: true,
      };
    }
  }

  private resources(): Record<string, unknown>[] {
    return this.host.runtime.installedDocs(this.host.workspaceId).flatMap((app) => [
      {
        uri: `fabric://apps/${encodeURIComponent(app.id)}`,
        name: app.name,
        description: app.description ?? "Fabric application document",
        mimeType: "application/json",
      },
      ...app.views.map((view) => ({
        uri: `fabric://apps/${encodeURIComponent(app.id)}/views/${encodeURIComponent(view.name)}`,
        name: `${app.name} / ${view.name}`,
        description: "Current renderer-neutral view tree",
        mimeType: "application/json",
      })),
    ]);
  }

  private async readResource(uri: string) {
    const url = new URL(uri);
    if (url.protocol !== "fabric:") throw new Error(`unsupported resource URI: ${uri}`);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const appId = url.hostname === "apps" ? parts[0] : undefined;
    if (!appId) throw new Error(`invalid Fabric resource URI: ${uri}`);
    const app = this.host.runtime.installed(appId);
    if (!app) throw new Error(`app "${appId}" is not installed`);
    let value: unknown = app;
    if (parts[1] === "views" && parts[2]) {
      value = await this.host.runtime.renderView(appId, parts[2], this.principal);
    }
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
    };
  }

  private findActionTool(name: string) {
    for (const app of this.host.runtime.installedDocs(this.host.workspaceId)) {
      for (const action of app.actions) {
        if (toolName(app.id, action.name) === name) return { app, action };
      }
    }
    return undefined;
  }
}

function toolName(appId: string, action: string): string {
  return `fabric_${appId}_${action}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function schemaForField(type: FieldType): Record<string, unknown> {
  if (type === "number") return { type: "number" };
  if (type === "boolean") return { type: "boolean" };
  if (type === "json") return {};
  return { type: "string" };
}

function appSummary(app: AppDocument) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    actions: app.actions.map((action) => action.name),
    views: app.views.map((view) => view.name),
  };
}

function text(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

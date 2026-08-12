import {
  FabricCloudMcpServer,
  type CloudMcpApi,
  type CloudMcpDeployment,
  type CloudMcpProject,
} from "@fabric/mcp";
import type { Deployment } from "@fabric/cloud";
import type { Principal } from "@fabric/permissions";
import {
  ALL_AGENT_SCOPES,
  authenticateAgentToken,
  requireAgentScope,
  type AgentCredential,
  type AgentScope,
} from "../../../lib/agent-auth";
import { currentIdentity, type StudioIdentity } from "../../../lib/auth";
import { StudioControlPlane } from "../../../lib/control-plane";
import {
  authenticateMcpOAuthToken,
  MCP_OAUTH_SCOPE,
  type McpOAuthCredential,
} from "../../../lib/mcp-oauth";

type McpCredential = AgentCredential | McpOAuthCredential;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestId = request.headers.get("x-vercel-id");
  try {
    const projectAgent = await authenticateAgentToken(request);
    const oauthAgent = projectAgent ? null : await authenticateMcpOAuthToken(request);
    const credential: McpCredential | null = projectAgent ?? oauthAgent;
    const session = credential ? null : await currentIdentity().catch(() => null);
    if (!credential && !session) {
      const challenge = oauthChallenge(request);
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Connect ChatGPT to Fabric to continue",
            data: { _meta: { "mcp/www_authenticate": [challenge] } },
          },
          id: null,
        },
        { status: 401, headers: { "WWW-Authenticate": challenge } },
      );
    }
    const identity: StudioIdentity = credential
      ? { id: credential.principalId, workspaceId: credential.workspaceId }
      : session!;
    const principal: Principal = {
      id: identity.id,
      roles: projectAgent
        ? projectAgent.scopes
        : oauthAgent
          ? ALL_AGENT_SCOPES
          : ["owner"],
    };
    const server = new FabricCloudMcpServer({
      api: mcpApi(
        new StudioControlPlane(identity),
        credential,
        new URL(request.url).origin,
      ),
      principal,
    });
    const rpc = (await request.json()) as {
      jsonrpc: "2.0";
      id?: string | number | null;
      method: string;
      params?: Record<string, unknown>;
    };
    const result = await server.handle(rpc);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    return Response.json(
      { jsonrpc: "2.0", id: rpc.id, result },
      { headers: { "MCP-Protocol-Version": "2025-06-18" } },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Fabric MCP request failed",
        requestId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      }),
    );
    const rpcError = error as Error & { code?: number };
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: rpcError.code ?? -32603, message: rpcError.message },
      },
      { status: 400 },
    );
  }
}

function mcpApi(
  controlPlane: StudioControlPlane,
  credential: McpCredential | null,
  origin: string,
): CloudMcpApi {
  const requireScope = (projectId: string, scope: AgentScope) => {
    if (credential && "projectId" in credential) {
      requireAgentScope(credential, projectId, scope);
    }
  };
  const project = (value: Awaited<ReturnType<StudioControlPlane["getProject"]>>): CloudMcpProject => ({
    project: value.project,
    role: value.role,
    slug: value.object.slug,
    editorUrl: `${origin}/projects/${value.project.id}`,
  });
  const deployment = async (value: Deployment): Promise<CloudMcpDeployment> => {
    const current = await controlPlane.getProject(value.projectId);
    const appUrl =
      current.project.activeDeploymentId === value.id && current.object.linkRole
        ? `${origin}/run/${value.projectId}?k=${encodeURIComponent(current.object.shareToken)}`
        : undefined;
    return {
      deploymentId: value.id,
      projectId: value.projectId,
      ...(value.buildId ? { buildId: value.buildId } : {}),
      state: value.state,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(value.error ? { error: value.error } : {}),
      editorUrl: `${origin}/projects/${value.projectId}`,
      ...(appUrl ? { appUrl } : {}),
    };
  };
  return {
    async listProjects() {
      const projects = (await controlPlane.listProjects()).map(project);
      if (!credential || !("projectId" in credential)) return projects;
      requireScope(credential.projectId, "project:read");
      return projects.filter((item) => item.project.id === credential.projectId);
    },
    async createProject(_principal, input) {
      if (credential && "projectId" in credential) {
        throw new Error("project-scoped credentials cannot create projects");
      }
      return project(await controlPlane.createProject(input));
    },
    async listFiles(_principal, projectId) {
      requireScope(projectId, "project:read");
      return controlPlane.listFiles(projectId);
    },
    async writeFiles(_principal, projectId, files) {
      requireScope(projectId, "files:write");
      return controlPlane.writeFiles(projectId, files);
    },
    async sealSnapshot(_principal, projectId, input) {
      requireScope(projectId, "snapshot:write");
      return controlPlane.sealSnapshot(projectId, input);
    },
    async inspectBuildPlans(_principal, projectId, snapshotId) {
      requireScope(projectId, "project:read");
      return controlPlane.inspectBuildPlans(projectId, snapshotId);
    },
    async requestBuild(_principal, input) {
      requireScope(input.projectId, "build:create");
      return controlPlane.requestBuild(input);
    },
    async getBuild(_principal, projectId, buildId) {
      requireScope(projectId, "project:read");
      return controlPlane.getBuild(projectId, buildId);
    },
    async listBuildEvents(_principal, projectId, buildId, after, limit) {
      requireScope(projectId, "logs:read");
      return controlPlane.listBuildEvents(projectId, buildId, after, limit);
    },
    async requestDeployment(_principal, input) {
      requireScope(input.projectId, "deployment:create");
      return deployment(await controlPlane.requestDeployment(input));
    },
    async getDeployment(_principal, projectId, deploymentId) {
      requireScope(projectId, "project:read");
      return deployment(await controlPlane.getDeployment(projectId, deploymentId));
    },
    async publishProject(_principal, projectId, deploymentId) {
      requireScope(projectId, "deployment:create");
      const published = await controlPlane.publishProject(projectId, deploymentId);
      return {
        projectId,
        deploymentId,
        editorUrl: `${origin}/projects/${projectId}`,
        appUrl: `${origin}/run/${projectId}?k=${encodeURIComponent(published.shareToken)}`,
      };
    },
  };
}

function oauthChallenge(request: Request): string {
  const origin = new URL(request.url).origin;
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${MCP_OAUTH_SCOPE}", error="invalid_token", error_description="Connect ChatGPT to Fabric"`;
}

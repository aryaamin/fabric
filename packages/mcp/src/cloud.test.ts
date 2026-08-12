import assert from "node:assert/strict";
import test from "node:test";
import type { CloudMcpApi } from "./cloud.ts";
import { FabricCloudMcpServer } from "./cloud.ts";

test("cloud MCP requires a principal and exposes control-plane tools", async () => {
  assert.throws(
    () =>
      new FabricCloudMcpServer({
        api: fakeApi(),
        principal: { id: "", roles: [] },
      }),
    /principal is required/,
  );
  const server = new FabricCloudMcpServer({
    api: fakeApi(),
    principal: { id: "agent_1", roles: ["project:read"] },
  });
  const listed = (await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })) as { tools: { name: string; securitySchemes?: unknown[] }[] };
  assert(listed.tools.some((tool) => tool.name === "fabric_write_files"));
  assert(listed.tools.some((tool) => tool.name === "fabric_request_build"));
  assert(listed.tools.some((tool) => tool.name === "fabric_request_deployment"));
  assert(listed.tools.some((tool) => tool.name === "fabric_publish_project"));
  assert(listed.tools.every((tool) => (tool.securitySchemes?.length ?? 0) > 0));
});

test("cloud MCP forwards the authenticated principal", async () => {
  let principalId = "";
  const api = fakeApi();
  api.listProjects = async (principal) => {
    principalId = principal.id;
    return [];
  };
  const server = new FabricCloudMcpServer({
    api,
    principal: { id: "agent_1", roles: ["project:read"] },
  });
  const response = (await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "fabric_list_projects", arguments: {} },
  })) as { structuredContent: unknown[] };

  assert.equal(principalId, "agent_1");
  assert.deepEqual(response.structuredContent, []);
});

test("cloud MCP forwards idempotent deployment requests", async () => {
  let received: unknown;
  const api = fakeApi();
  api.requestDeployment = async (_principal, input) => {
    received = input;
    throw new Error("captured");
  };
  const server = new FabricCloudMcpServer({
    api,
    principal: { id: "agent_1", roles: ["deployment:create"] },
  });
  const response = (await server.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "fabric_request_deployment",
      arguments: {
        projectId: "prj_1",
        buildId: "bld_1",
        idempotencyKey: "deploy-1",
      },
    },
  })) as { isError: boolean };

  assert.deepEqual(received, {
    projectId: "prj_1",
    buildId: "bld_1",
    idempotencyKey: "deploy-1",
  });
  assert.equal(response.isError, true);
});

function fakeApi(): CloudMcpApi {
  return {
    async listProjects() {
      return [];
    },
    async createProject() {
      throw new Error("not used");
    },
    async listFiles() {
      return [];
    },
    async writeFiles() {
      return [];
    },
    async sealSnapshot() {
      throw new Error("not used");
    },
    async inspectBuildPlans() {
      return [];
    },
    async requestBuild() {
      throw new Error("not used");
    },
    async getBuild() {
      throw new Error("not used");
    },
    async listBuildEvents() {
      return [];
    },
    async requestDeployment() {
      throw new Error("not used");
    },
    async getDeployment() {
      throw new Error("not used");
    },
    async publishProject() {
      throw new Error("not used");
    },
  };
}

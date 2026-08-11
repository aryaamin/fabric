import assert from "node:assert/strict";
import test from "node:test";
import type {
  CapabilityContext,
  FactoryEnv,
  Logger,
} from "@fabric/capabilities";
import { openApiCapabilityFactory } from "./openapi.ts";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("OpenAPI capability invokes an operation with scoped secrets", async () => {
  let request:
    | { url: string; method: string; authorization: string | null }
    | undefined;
  const factory = openApiCapabilityFactory(
    {
      info: { title: "Inventory", version: "1.0.0" },
      paths: {
        "/widgets/{id}": {
          get: {
            operationId: "getWidget",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "expand", in: "query", schema: { type: "boolean" } },
            ],
          },
        },
      },
    },
    {
      baseUrl: "https://inventory.example",
      bearerTokenSecret: "INVENTORY_TOKEN",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        request = {
          url: String(input),
          method: init?.method ?? "GET",
          authorization: headers.get("authorization"),
        };
        return Response.json({ id: "w_1" });
      },
    },
  );
  const env: FactoryEnv = {
    namespace: "workspace/app",
    logger,
    secrets: { get: (name) => (name === "INVENTORY_TOKEN" ? "secret" : undefined) },
  };
  const context: CapabilityContext = {
    app: { id: "app", instanceId: "instance", workspaceId: "workspace", version: "v1" },
    user: { id: "user", roles: ["owner"] },
    logger,
    secrets: env.secrets,
    emit() {},
  };

  const result = await factory
    .create({}, env)
    .invoke("getWidget", { id: "w_1", expand: true }, context);

  assert.deepEqual(result, { id: "w_1" });
  assert.deepEqual(request, {
    url: "https://inventory.example/widgets/w_1?expand=true",
    method: "GET",
    authorization: "Bearer secret",
  });
});

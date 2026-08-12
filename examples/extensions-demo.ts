import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppDocument } from "@fabric/ir";
import { LocalCodeUnitRunner } from "@fabric/code-units";
import { FabricHost } from "@fabric/host";
import { FabricMcpServer } from "@fabric/mcp";
import { Runtime } from "@fabric/runtime";
import {
  openApiCapabilityFactory,
  readGitProposal,
  writeGitMirror,
} from "@fabric/integrations";

const here = dirname(fileURLToPath(import.meta.url));
const codeRoot = resolve(here, "portable-app");
const document = JSON.parse(
  await readFile(resolve(codeRoot, "app.fabric.json"), "utf8"),
) as AppDocument;

const runtime = new Runtime({ codeUnitRunner: new LocalCodeUnitRunner(), codeRoot });
const host = new FabricHost({ runtime, workspaceId: "demo" });
host.install({ document }, { id: "demo", roles: ["owner"] });

const score = await runtime.invokeAction(
  "risk-scoring",
  "score",
  { amount: 8200, country: "IN" },
  { id: "demo", roles: ["owner"] },
);
assert((score as { band: string }).band === "high", "Python code unit did not run");

const response = await host.fetch(
  new Request("http://fabric.local/apps/risk-scoring/views/main", {
    headers: { "x-fabric-user": "demo", "x-fabric-roles": "owner" },
  }),
);
assert(response.ok, "portable host did not render the view");

const mcp = new FabricMcpServer({
  host,
  principal: { id: "demo", roles: ["owner"] },
});
const tools = (await mcp.handle({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
})) as { tools: { name: string }[] };
assert(tools.tools.some((tool) => tool.name.includes("risk-scoring_score")), "MCP action tool missing");

const openApi = openApiCapabilityFactory(
  {
    info: { title: "Billing API", version: "1.0.0" },
    servers: [{ url: "https://api.example.test" }],
    paths: {
      "/invoices/{id}": {
        get: {
          operationId: "getInvoice",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        },
      },
    },
  },
);
assert(openApi.manifest.methods[0]?.name === "getInvoice", "OpenAPI manifest generation failed");

const mirrorRoot = await mkdtemp(resolve(tmpdir(), "fabric-mirror-"));
const mirror = await writeGitMirror(mirrorRoot, [{ document, version: runtime.versions.head(document.id)!.id }]);
const proposal = await readGitProposal(resolve(mirrorRoot, mirror.apps[0]!.path));
assert(proposal.id === document.id, "Git proposal round trip failed");
await rm(mirrorRoot, { recursive: true, force: true });

console.log("✓ standalone host renders outside Studio");
console.log(`✓ pinned Python unit returned ${JSON.stringify(score)}`);
console.log(`✓ MCP exposes ${tools.tools.length} tools`);
console.log(`✓ OpenAPI generated capability "${openApi.manifest.name}"`);
console.log("✓ Git mirror round-trips through validation");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

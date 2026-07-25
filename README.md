# ▚ Fabric

**The runtime for AI-generated software.** Applications become first-class
workspace objects — created by conversation, shared like a Google Doc,
connected like Lego, versioned like a document, and never deployed.

> Software should be as easy to create, edit, share, and compose as a Google
> Doc. Today documents are first-class objects. Tomorrow, applications are too.

This repository is the **foundation** — not a prototype. The model runs today
on Node's built-in TypeScript support. Fabric apps are portable: the Studio is
an editor, not the only place they can run.

## The idea in one picture

```
prompt ──► Orchestrator ──► IR (the source of truth) ──► Validator ──► Interpreter ──► running app
                                     ▲                                      │
                                     └───────── edit = new version ─────────┘
apps call abstract CAPABILITIES (storage, notifications, ai, …); the RUNTIME owns all real infrastructure.
```

An application is not code and not a database — it is a declarative document
(the **IR**). The AI edits it, versioning snapshots it, an **interpreter** runs
it, and a **runtime** gives it storage, permissions, events, connections,
scheduling, secrets, and logging with zero configuration. Apps never name
infrastructure; they name **capabilities**, which arrive as plugins in a
**registry** — so the platform grows without ever editing its core.

## Quickstart (no install, no network)

```bash
npm run link:local     # symlink @fabric/* packages (pure local, no deps)
npm run demo           # full end-to-end walkthrough

# more runnable demos (same zero-setup):
node --experimental-strip-types --no-warnings examples/conversation.ts   # AI-style live editing
node --experimental-strip-types --no-warnings examples/leave-demo.ts     # a 2nd app: if / forEach / let steps
node --experimental-strip-types --no-warnings examples/sharing-demo.ts   # Google-Docs-style share links
```

`npm run demo` boots a runtime, files two apps as workspace objects, installs
them, submits and approves an expense, shows a **denied** permission, watches a
second app react to an event **with no API**, demonstrates **row-level
permissions**, edits an app live via an **IR patch**, and shows **version
history, diff, restore, sharing, and embedding** — all on the interpreter.

Install once, then run the Studio:

```bash
npm install
npm run link:local
npm run studio
```

## Run an app without Studio

An app is a `.fabric.json` document. `@fabric/host` is a reusable Fetch-style
HTTP host and `fabric run` wraps it in a local Node server:

```bash
npm run fabric -- run examples/portable-app/app.fabric.json \
  --code-root examples/portable-app \
  --port 7777

curl -H 'x-fabric-user: me' -H 'x-fabric-roles: owner' \
  http://localhost:7777/apps

curl -X POST -H 'content-type: application/json' \
  -H 'x-fabric-user: me' -H 'x-fabric-roles: owner' \
  -d '{"amount":8200,"country":"IN"}' \
  http://localhost:7777/apps/risk-scoring/actions/score
```

The same host can be embedded in a main Node application:

```typescript
import { FabricHost } from "@fabric/host";

const fabric = new FabricHost({ runtime, workspaceId: "my-product" });
// Mount `fabric.fetch(request)` under any route in your framework.
```

The current header principal resolver is a development default. A production
host must pass `authenticate(request)` and map its existing sessions/OAuth
tokens to Fabric principals.

## Give an AI access through MCP

Every installed action becomes an MCP tool, every app document becomes a
resource, and every view becomes a live renderer-neutral resource. Calls still
go through the same runtime permission checks as clicks in the UI.

```bash
npm run fabric -- mcp examples/portable-app/app.fabric.json \
  --code-root examples/portable-app
```

Example stdio MCP configuration:

```json
{
  "mcpServers": {
    "fabric": {
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/to/Fabric",
        "run",
        "fabric",
        "--",
        "mcp",
        "examples/portable-app/app.fabric.json",
        "--code-root",
        "examples/portable-app"
      ]
    }
  }
}
```

The server exposes workspace tools (`fabric_list_apps`,
`fabric_install_app`, version history), dynamic action tools, app documents,
and live view resources over standard newline-delimited JSON-RPC stdio.

## JSON for orchestration, real code for computation

Fabric JSON is an AST for app shape: models, views, policies, actions, and
wiring. It is intentionally not a replacement for Python or TypeScript.
Complex computation lives in a **code unit**:

```json
{
  "name": "scoreRisk",
  "runtime": "python",
  "entry": "risk_score.py",
  "digest": "sha256:62d14a0..."
}
```

An action uses `{ "kind": "code", "unit": "scoreRisk", ... }`. The runtime
checks the pinned digest before invocation, evaluates the unit's inputs from
the IR, and makes its output available to later steps. Generate a pin with:

```bash
npm run fabric -- digest examples/portable-app/risk_score.py
npm run demo:extensions
```

`LocalCodeUnitRunner` supports trusted local Node and Python development. It
is deliberately labelled non-sandboxed. Production hosts inject a
`CodeUnitRunner` backed by an isolated worker or microVM; code units receive
only JSON input and app/workspace identity, never ambient runtime secrets.

## Connect an existing codebase

Do not import a monolith into the IR. Expose its typed boundary as a
capability. OpenAPI services can be converted directly into capability
manifests and implementations:

```typescript
import { openApiCapabilityFactory } from "@fabric/integrations";

runtime.registry.register(
  openApiCapabilityFactory(openApiDocument, {
    name: "billing",
    baseUrl: "https://billing.internal",
    bearerTokenSecret: "BILLING_TOKEN"
  })
);
```

Inspect the generated manifest with:

```bash
npm run fabric -- openapi-inspect ./openapi.json
```

## GitHub and code review

Fabric remains authoritative at runtime; Git is a reviewable mirror and a
source of proposals. This avoids two independent live heads.

```bash
npm run fabric -- git-export /path/to/repo \
  examples/portable-app/app.fabric.json
```

This writes `fabric/apps/<id>/app.fabric.json` plus `fabric/mirror.json`.
`readGitProposal()` validates a changed document before installation,
`commitGitMirror()` can create a normal commit, and
`githubValidationWorkflow()` returns a starter PR validation workflow.

## What's here

| Package | Role |
|---------|------|
| [`packages/ir`](packages/ir) | IR types, the expression AST, patches |
| [`packages/validator`](packages/validator) | the correctness gate |
| [`packages/capabilities`](packages/capabilities) | the Capability contract (the seam that hides infra) |
| [`packages/registry`](packages/registry) | capability plugin registry |
| [`packages/storage`](packages/storage) | storage capability + swappable `DataStore` |
| [`packages/events`](packages/events) · [`connections`](packages/connections) | composition backbone |
| [`packages/permissions`](packages/permissions) | pure authorization decisions |
| [`packages/interpreter`](packages/interpreter) | runs the IR (evaluate / actions / views) |
| [`packages/versioning`](packages/versioning) | content-addressed version DAG |
| [`packages/workspace`](packages/workspace) | apps as shareable, embeddable objects |
| [`packages/runtime`](packages/runtime) | the host & single trust boundary |
| [`packages/orchestrator`](packages/orchestrator) | prompt → IR patches → validate |
| [`packages/host`](packages/host) · [`cli`](packages/cli) | portable HTTP host and `fabric` command |
| [`packages/mcp`](packages/mcp) | apps/actions/views exposed to AI clients |
| [`packages/code-units`](packages/code-units) | pinned Node/Python computation boundary |
| [`packages/integrations`](packages/integrations) | Git mirror and OpenAPI capability import |
| [`apps/studio`](apps/studio) | create/edit by conversation (Next.js) |
| [`apps/server`](apps/server) | zero-dep preview/runtime HTTP host (URLs, embeds) |

## The design, in full

The complete architecture — every one of the original 25 deliverables plus
portability, MCP, code units, Git, and OpenAPI integration — lives in
[`docs/`](docs/README.md). Start there.

## Why it runs with zero dependencies

The core is deliberately dependency-free: validation, hashing, and the
expression evaluator are small and hand-rolled. That keeps the platform's spine
auditable, portable, and immune to ecosystem churn — and it means the demos
prove the architecture in a single command, with nothing to install.

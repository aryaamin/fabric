# ▚ Fabric

**A shared workspace for small software.** People and connected AIs work on the
same real projects. Through MCP, an AI can edit provider-neutral source files,
seal immutable snapshots, run isolated builds, deploy applications, inspect
logs, and return shareable URLs.

> Software should be as easy to create, edit, share, and compose as a Google
> Doc. Today documents are first-class objects. Tomorrow, applications are too.

Fabric abstracts projects, files, runtimes, credentials, builds, deployments,
permissions, and providers. Vercel Sandbox and Vercel Deployments are the first
replaceable adapters; Node.js, Python, and Go are supported by deterministic
runtime detection. The original App IR remains available as an instant
execution mode for document-shaped internal tools.

End users interact only with Fabric. Provider accounts, deployment projects,
database credentials, build images, and infrastructure configuration remain
private implementation details controlled by the Fabric operator.

## The idea in one picture

```
AI / Studio ──► REST or MCP ──► fabric.json + working files
                                        │
                              immutable snapshot
                                        │
                         workload-aware build plans
                                        │
                         isolated build ──► Fabric URL
```

Agents operate on Fabric concepts rather than VMs, containers, IAM, build
servers, or provider APIs. Source projects and Fabric IR applications coexist:
source mode supports ordinary frameworks and languages; IR mode keeps the
sub-millisecond edit/run path for apps that fit Fabric's deterministic runtime.

## Connect ChatGPT

Deploy Fabric once, then open `/connect`. Add the displayed remote MCP URL in
ChatGPT Plugins. ChatGPT discovers Fabric's OAuth metadata, opens a Fabric
sign-in and consent screen, and receives short-lived PKCE-bound access with a
rotating refresh token.

After connecting, ask:

> Create a Python calculator, deploy it on Fabric, and give me the application
> and editor links.

ChatGPT can create files, seal a snapshot, poll the isolated build, deploy,
publish, and return Fabric-branded URLs. It never receives provider tokens,
database credentials, or raw provider deployment metadata.

## The application manifest

Every source project has a validated `fabric.json` document. It is the
provider-neutral description of the whole application: web apps and headless
workers, HTTP/schedule/event/queue triggers, managed resources, logical data
models and relationships, secret requirements, permissions, and safety
policies.

AI clients inspect this manifest before changing an existing application and
update it before implementation code. Fabric validates all references when a
snapshot is sealed, derives build workloads from it, and applies application
limits only when they are stricter than the operator-owned platform limits.
Older projects without `fabric.json` receive an inferred manifest until their
next AI edit.

Fabric also derives a deterministic version for every logical data schema.
Before sealing a schema change, Studio and MCP preview the migration as safe,
backfill-required, or destructive. Destructive changes are blocked until a
workspace owner reviews the exact plan; the approval is bound to that plan and
cannot be reused after the schema changes. AI clients receive logical diffs and
validation requirements, never database credentials or unrestricted SQL.
After sealing, an owner can apply the migration in Studio. Fabric snapshots the
logical records, runs declared-default backfills in isolation, validates types,
required fields, enums, references, and unique indexes, then atomically commits
the result. Failed validation leaves live records untouched. Successful runs
retain a checksum-verified backup for owner-initiated rollback, and deployment
is blocked until the sealed migration succeeds. AI clients can inspect this
ledger through MCP but cannot approve, apply, or roll back a migration.

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

## Run Fabric end to end

Install the Vercel CLI (`npm i -g vercel`), link the Studio to a Vercel project,
and pull its environment. For local execution, copy
`apps/studio/.env.example` to `apps/studio/.env.local` and configure
`VERCEL_TOKEN` and `FABRIC_CLOUD_EXECUTION_MODE=inline`. Fabric reads
`VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` from `.vercel/project.json` after
`vercel link` (explicit environment values override it). This linked project is
the Fabric control plane used for Sandbox execution; Fabric creates a separate
target project for each deployed application.

For durable production state, also configure `DATABASE_URL`, deploy Fabric with
Vercel Queues enabled, and run the migrations.

```bash
npm run db:migrate
npm run studio -- --port 3210

# In another terminal: project → snapshot → build → deploy → publish → HTTP check
npm run smoke:cloud
```

Open `http://localhost:3210/projects` to use the same flow in Studio. Project
owners can generate a scoped remote MCP configuration from the project page;
the raw token is shown once and only its SHA-256 digest is stored.

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

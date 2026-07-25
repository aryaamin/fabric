# 18, 19, 20, 21, 23. Structure, Tech, Roadmap, MVP & Scaling

## 18. Folder structure

A monorepo. **Interfaces first, dependency injection everywhere, replaceable
implementations.** Dependencies point strictly downward (see
[system architecture](02-system-architecture.md)).

```
fabric/
├── packages/                     # the platform — zero runtime deps, pure TS
│   ├── ir/                       # IR types, expression AST, patches   (8)
│   ├── validator/                # correctness gate                    (—)
│   ├── capabilities/             # the Capability contract             (6)
│   ├── registry/                 # capability plugin registry          (7)
│   ├── storage/                  # storage capability + DataStore port (13)
│   ├── events/                   # event bus                           (11)
│   ├── connections/              # subscription → action wiring        (12)
│   ├── permissions/              # pure authorization decisions        (14)
│   ├── interpreter/              # evaluate / runAction / resolveView  (9)
│   ├── versioning/               # content-addressed version DAG       (10)
│   ├── workspace/                # objects, sharing, URLs, embeds       (5)
│   ├── runtime/                  # the host & trust boundary           (4)
│   │   └── std/                  # built-in capabilities (notifications, ai)
│   ├── orchestrator/             # prompt → patches → validate         (15)
│   ├── host/                     # portable Fetch/HTTP runtime surface
│   ├── cli/                      # run, MCP, validate, digest, Git export
│   ├── mcp/                      # app tools and resources for AI clients
│   ├── code-units/               # pinned Node/Python computation
│   └── integrations/             # OpenAPI capabilities + Git mirror
│
├── apps/
│   ├── studio/                   # Next.js — create/edit by conversation (16,17)
│   ├── server/                   # demo HTML renderer over the runtime   (5)
│   └── preview/                  # (reserved) public/embed edge renderer
│
├── examples/                     # runnable proofs
│   ├── apps/                     # example apps authored as IR
│   ├── portable-app/             # JSON app + pinned Python code unit
│   ├── demo.ts                   # full end-to-end walkthrough
│   ├── extensions-demo.ts        # host + MCP + Python + OpenAPI proof
│   └── conversation.ts           # AI-style live editing
│
├── docs/                         # this documentation set
└── scripts/link-workspaces.mjs   # zero-network local linker
```

**Why a package per concern.** Each package has a single reason to change and a
contract others depend on. This is what lets us claim any layer is replaceable
without a cascade — and it is enforced by the dependency graph, not by
convention. The core packages have **no external runtime dependencies** on
purpose: the platform's spine should not rot when a fashionable library does,
and it should be auditable in an afternoon.

## 19. Technology choices

| Choice | Decision | Why |
|--------|----------|-----|
| Language | **TypeScript everywhere** | One language across IR types, runtime, and studio; structural typing mirrors the IR; the ecosystem the AI knows best. |
| Core deps | **Zero external runtime deps** | The spine must be stable, auditable, portable, and immune to churn. Validation, hashing, and evaluation are hand-rolled and small. |
| IR format | **Plain JSON** | Diffable, hashable, model-friendly, portable. The whole versioning/patch/compose story depends on it. |
| Runtime host | **Fluid Compute (Node.js)** on Vercel | Instance reuse kills cold starts for many tiny apps; `waitUntil`/`after` for post-response event delivery; full Node for capabilities. Not Edge — capabilities need Node APIs and DB drivers. |
| Studio | **Next.js 16 (App Router, RSC)** | Server Components stream the workspace with minimal client JS; Server Actions/route handlers host the runtime; first-class on the deploy target. |
| AI | **Vercel AI SDK v6 + AI Gateway** | Provider-agnostic model strings, failover, cost tracking, OIDC (no keys in app); structured output for patch generation; tools for a self-checking planner. |
| Storage (prod) | **Neon Postgres** behind the storage capability | Serverless, branchable, cheap-at-rest for many small apps; row-level security matches per-tenant isolation. Swappable — apps never see it. |
| Cache / KV (prod) | **Upstash Redis** behind a `cache` capability | Serverless, same billing, per-region. |
| Events (prod) | **Vercel Queues** behind the event bus | Durable, at-least-once — the composition guarantee. |
| Files (prod) | **Vercel Blob** behind a `files` capability | Public/private object storage up to 5 TB. |
| Monorepo | **pnpm/npm workspaces + Turborepo** | Task caching and affected-only CI as the package count grows. |
| Local run | **Node type-stripping** (`--experimental-strip-types`) | The core runs with no build and no install — the demos prove the architecture in one command. |

Every "prod" row is an *adapter behind a capability*, never a thing an app
names. Swapping any of them is a factory change, not an app change.

## 20. Development roadmap

- **Phase 0 — Foundation (this repo).** IR + interpreter + runtime + capability
  registry + validator + versioning + events/connections + permissions +
  workspace; storage/notifications/ai capabilities; end-to-end demo. *Proves
  the model runs.*
- **Phase 1 — MVP (see §21).** Studio with real AI planner (AI SDK + Gateway),
  Neon-backed storage, durable events, auth, public/embed rendering, live
  editing round-trip. *One person can create, edit, share, and embed a real
  app by conversation.*
- **Phase 2 — Composition & collaboration.** Cross-app connection UX, event
  activity feeds, multiplayer editing (CRDT over IR patches), a growing
  capability catalog (`slack`, `stripe`, `calendar`, `search`, `files`,
  `scheduler`).
- **Phase 3 — Platform.** Third-party capability publishing (signed plugins),
  an app template gallery, org-level governance and audit, data-residency
  zones.
- **Phase 4 — Performance.** The [compiler](04-ir-and-interpreter.md#22-future-compiler-architecture)
  for hot apps; edge rendering of public/embedded apps from immutable version
  snapshots.

## 21. MVP scope

**In.** The smallest thing that delivers the promise end-to-end for one user:

- IR + interpreter + runtime (Phase 0) — done.
- Studio: conversational create/edit with the real AI planner; live canvas.
- Capabilities: `storage` (Neon), `notifications` (email/Slack), `ai`
  (Gateway), `auth`.
- Versioning UX: history, restore, fork, duplicate, compare.
- Sharing: owner/editor/viewer/public; URLs; `<iframe>` embeds.
- Composition: at least one working cross-app connection authored by sentence.
- Permissions: roles + action/model policies + row rules.

**Out (deferred, and why it's safe to defer).** Multiplayer editing (additive —
patch-native already); the compiler (performance, not capability); marketplace
of third-party capabilities (governance, not mechanism); mobile-native
renderers (renderer, not core). None of these change the architecture; each
slots into an existing seam.

**The MVP acceptance test** is the HR walkthrough in
[UX](09-workspace-and-ux.md#the-non-programmer-walkthrough-the-acceptance-test-for-the-whole-product):
four sentences produce a shared, connected, permissioned, embeddable app, with
zero mention of a computer.

## 23. Scaling strategy

Fabric optimizes for **many tiny apps**, not few huge ones. That inverts the
usual scaling playbook, and the inversion is deliberate.

- **Apps are cheap objects, not services.** Installing an app is a row + a
  version snapshot, not a container or a deployment. Millions of apps are
  millions of rows, not millions of running processes.
- **Cold start is the real enemy, not throughput.** An app with three users is
  idle most of the time. Fluid Compute's instance reuse means an incoming
  request reuses a warm runtime; the per-app marginal cost at rest is
  storage-only.
- **Isolation is logical, not physical.** Per-installation storage namespaces
  (a Postgres schema / row-security scope) give isolation without a database
  per app. Scale-out is **sharding workspaces** across storage clusters, a
  boring and well-understood axis.
- **Public/embedded apps scale like static content.** A public app's view is a
  pure function of an immutable version snapshot, so it caches at the edge with
  tag-based invalidation on new versions. Read-heavy embeds cost almost
  nothing.
- **Events scale by partitioning on workspace.** The bus is workspace-scoped;
  a durable queue partitioned by workspace fans out within a tenant without
  cross-tenant contention.

We explicitly do **not** invest early in horizontal app-server autoscaling for a
single hot app, because a single hot "small software" app is, by definition,
outside our target. If one appears and matters, the
[compiler](04-ir-and-interpreter.md#22-future-compiler-architecture) turns that
specific app's hot paths into optimized code — a targeted escalation, not a
platform-wide re-architecture. Choosing the right thing to *not* scale is as
much a strategy as choosing what to scale.

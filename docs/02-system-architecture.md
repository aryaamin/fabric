# 3–4. System & Runtime Architecture

## 3. System architecture

Fabric is a small number of layers with strictly one-directional dependencies.
The arrow means "depends on"; nothing points back up.

```
                ┌──────────────────────────────────────────────┐
   PEOPLE ──►   │  Studio (create/edit by conversation)         │  apps/studio
                │  Preview/Runtime server (URLs, embeds)        │  apps/server
                └───────────────┬──────────────────────────────┘
                                │
                ┌───────────────▼──────────────────────────────┐
  AUTHORING ──► │  Orchestrator  (prompt → IR patches)          │  packages/orchestrator
                │  Validator     (hard correctness gate)        │  packages/validator
                └───────────────┬──────────────────────────────┘
                                │
                ┌───────────────▼──────────────────────────────┐
   EXECUTION ─► │  Runtime  (the trust boundary & host)         │  packages/runtime
                │   ├─ Interpreter  (runs the IR)               │  packages/interpreter
                │   ├─ Permissions  (authorizes every call)     │  packages/permissions
                │   ├─ Events       (composition backbone)      │  packages/events
                │   ├─ Connections  (cross-app wiring)          │  packages/connections
                │   ├─ Versioning   (immutable history)         │  packages/versioning
                │   └─ Registry     (installed capabilities)    │  packages/registry
                └───────────────┬──────────────────────────────┘
                                │
                ┌───────────────▼──────────────────────────────┐
 CAPABILITIES ► │  Capability contract + implementations        │  packages/capabilities
                │   storage · notifications · ai · (plugins…)   │  packages/storage, runtime/std
                └───────────────┬──────────────────────────────┘
                                │
                ┌───────────────▼──────────────────────────────┐
       DATA ──► │  IR  (the source of truth for every app)      │  packages/ir
                └──────────────────────────────────────────────┘
```

**Why this layering.** Each layer is replaceable because it depends only on the
contract of the layer below, never on a sibling. The interpreter knows nothing
about capabilities (it talks to an injected `ExecutionHost`). Permissions know
nothing about storage backends. This is what makes the ten-year bet
survivable: any single layer can be rewritten without a cascade.

**The IR sits at the bottom on purpose.** Everything above is a function of the
document. That is the architectural expression of philosophy axiom #1.

## 4. Runtime architecture

The Runtime ([`packages/runtime/src/runtime.ts`](../packages/runtime/src/runtime.ts))
is the operating system for applications. It is the only component that holds
real resources, and it is the single trust boundary.

### Responsibilities

- **Install** an app: validate → snapshot a version → instantiate the
  capabilities the app declares → wire its event subscriptions → register its
  schedules. After `install`, the app has storage, permissions, events,
  connections, secrets, and logging with **zero configuration**.
- **Serve** an app: build a fresh, per-call `ExecutionHost` and
  `CapabilityContext` for the interpreter, authorize every action invocation
  and data access, and route emitted events onto the bus.
- **Own** infrastructure: the secret vault, the log sink, the capability
  registry, the event bus, and the version store all live here.

### The install pipeline (what "no deployment" actually means)

```
install(doc, {workspaceId, secrets}):
  1. validate(doc, installed-capability-manifests)   → reject if not coherent
  2. versions.commit(doc)                             → immutable snapshot + parent link
  3. for each declared capability:
        factory = registry.resolve(name, version)
        instance = factory.create(config, {namespace, logger, secrets})
  4. connections.connect(workspace, doc)              → wire subscriptions to the bus
  5. app is live at its URL
```

There is no build step, no container, no artifact upload. "Deploying" a new
version is step 2 plus re-running the interpreter. This is why an edit appears
instantly (see [live editing](07-ai-and-live-editing.md#16-live-editing-architecture)).

### The trust boundary (why a bad app is still a safe app)

Every effect an application can have flows through exactly one method:
`ExecutionHost.call(alias, method, args)`. The runtime's implementation of that
method (`Runtime.host`) does three things before delegating to a capability:

1. resolves the capability alias to a concrete instance scoped to this app
   installation (so app A can never touch app B's data);
2. for the `storage` capability, maps the method to a CRUD operation and asks
   the [permission engine](06-permissions-and-security.md) whether this
   principal may perform it on this model — throwing before any I/O;
3. logs the call for the audit/activity feed.

Because there is no other path to a side effect — no ambient `fetch`, no
filesystem, no `process.env` reachable from the IR — an application is
**confined by construction**. A hallucinated or malicious IR can only do what
its declared capabilities and its permissions allow. This is the single most
important property of the runtime.

### Execution context

For each call the runtime builds a `CapabilityContext` containing the current
`app` identity (id, instance, workspace, version), the `user` identity
(id + roles), a scoped `logger`, a `secrets` reader bound to this installation,
and an `emit` function. Capabilities never reach for globals; everything they
may use is handed to them, freshly scoped, per call. This makes the runtime
safe to run multi-tenant: two apps served in the same process share no state
they were not explicitly given.

### Where it runs in production

The runtime is plain TypeScript with no assumption of a long-lived process. It
is designed to be instantiated per request on **Fluid Compute** (Node.js,
instance reuse, `waitUntil` for post-response event delivery). The in-memory
stores in the reference implementation are swapped for durable adapters (Neon,
a durable queue) via capability factories — no runtime code changes. See
[technology choices](10-tech-structure-roadmap.md#19-technology-choices).

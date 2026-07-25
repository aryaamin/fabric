# 6, 7, 13, 25. Capabilities, Registry, Storage & Extensibility

## 6. The capability system

A **capability** is the only way an application touches the world. The contract
([`packages/capabilities/src/index.ts`](../packages/capabilities/src/index.ts))
has two halves:

- a **manifest** — self-describing metadata: methods (with input/output
  schemas, the abstract permission each needs, the events each may emit),
  emitted events, a config schema, and the names of secrets it may read;
- an **invoke** function — `invoke(method, args, context)` returning a promise.

```ts
interface Capability {
  readonly manifest: CapabilityManifest;
  invoke(method: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<unknown>;
}
```

### Why capabilities are self-describing

The manifest is not documentation — it is machine-consumed by three different
subsystems, which is why it must be data:

1. **The AI** reads all manifests to learn what applications are *possible*. It
   cannot propose "charge a card" unless a `payments` capability advertises a
   `charge` method. The manifest is the AI's entire menu, and it is the reason
   the AI cannot hallucinate infrastructure — infrastructure is simply absent
   from its vocabulary.
2. **The validator** checks every `call` in an app against method names and
   signatures *without executing anything*.
3. **The permission layer** reads the `permission` field on each method to
   decide authorization at the single `invoke` chokepoint.

### Why "capability," not "service" or "SDK"

A service or SDK leaks its provider (`stripe.charges.create`). A capability is
an *intent* (`payments.charge`) whose provider is chosen by the runtime. The
app is written against the intent, so the provider can change — Stripe today,
something else tomorrow — with no app edit. This is philosophy axiom #2 made
concrete, and it is the whole reason infrastructure can stay invisible.

### The abstract-capability catalog (target set)

`storage`, `files`, `workflow`, `notifications`, `connections`, `permissions`,
`scheduler`, `cache`, `search`, `ai`, `auth`, plus integration capabilities
(`github`, `slack`, `stripe`, `calendar`, `email`). The reference
implementation ships `storage`, `notifications`, and `ai`; the rest are the
roadmap, and crucially **none of them require a core change to add** — see §25.

## 7. The capability registry

The registry ([`packages/registry/src/index.ts`](../packages/registry/src/index.ts))
maps `name@version → factory`. It supports multiple versions of a capability
simultaneously (apps pin a version; the registry resolves caret ranges), and it
exposes `manifests()` — the catalog the AI reads.

**Why a registry rather than an import list.** The platform's power is defined
by its capability set, and that set must grow *without editing the runtime*. A
registry makes capabilities plugins: register a factory, and every app and the
AI can immediately use it. There is exactly one extension point for the entire
platform, and this is it.

**Why factories, not singletons.** A capability instance is scoped to an app
installation (it gets a `namespace`, a scoped logger, and a secret reader).
Storing factories lets the runtime create isolated instances lazily and tear
them down independently. A shared singleton would leak state across tenants —
precisely the failure mode a multi-tenant "small software" host must avoid.

## 13. The storage abstraction

Storage is a capability like any other, but it deserves special attention
because it is the one every app uses. Its design
([`packages/storage`](../packages/storage)) is a **port + adapter**:

- The capability (`storage.create/get/update/delete/list/count`) is the stable
  surface apps and the AI program against.
- The `DataStore` interface is the swappable backend port.
- `InMemoryDataStore` is the reference adapter used by preview.

```
App IR ──calls──► storage capability ──uses──► DataStore port ──impl──► InMemory | SQLite | Neon
   (never changes)        (never changes)         (stable)              (free to change)
```

**Why apps never see a query language.** A model in the IR (`Expense` with
typed fields) is enough for the runtime to provision a collection
automatically. Queries are expressed as a small structured `Query` (model,
where, sort, limit), never as SQL. This keeps three promises at once: the AI
can author queries reliably (small grammar), the backend can be swapped
(no SQL dialect leaks into apps), and row-level permission rules can be
enforced uniformly (the runtime post-filters query results against the
[permission](06-permissions-and-security.md) predicate).

**Why per-installation namespaces.** Each app installation gets a namespace
(`workspace:app:instance`). Data isolation is therefore structural, not a
`WHERE tenant_id = ?` convention an app could forget. In production the
namespace maps to a Postgres schema or a row-security scope; in the reference
adapter it is a separate in-memory store.

## 25. The extensibility model

Everything about Fabric is designed so it can be *extended without being
edited*. The extension points, in order of importance:

1. **Capabilities (the primary axis).** New powers — `stripe`, `calendar`,
   `search`, a company's internal API — are new registry entries. Adding one
   makes it instantly available to every app and to the AI. Nothing in the
   runtime, interpreter, or IR changes. A capability is a self-contained plugin
   with a manifest and an `invoke`.

2. **Storage/infra adapters.** Behind the storage (and every) capability, the
   backend is an adapter chosen by the factory. New database, new region, new
   compliance zone → new adapter, zero app changes.

3. **Renderers.** The interpreter emits a renderer-agnostic `RenderNode` tree.
   React (studio) and HTML (server) renderers already consume the same tree;
   native or web-component renderers are additive. New component *types* in the
   IR are handled by teaching renderers, not by changing the interpreter.

4. **IR spec evolution.** The IR carries a `spec` version. New fields are
   additive; breaking changes ship with a migration that upgrades older
   documents on read. The validator warns on version drift.

5. **Planners.** The AI planner is an injected interface
   ([`Planner`](../packages/orchestrator/src/index.ts)). A better model, a
   fine-tuned model, or a deterministic rule engine are drop-in replacements.

The test we hold ourselves to: **"could a third party add this without a PR to
the core?"** For capabilities, adapters, and renderers, the answer is yes by
construction. That is the definition of a platform rather than a product.

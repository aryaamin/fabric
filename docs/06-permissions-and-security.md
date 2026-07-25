# 14, 24. Permission System & Security Model

## 14. The permission system

Permissions ([`packages/permissions/src/index.ts`](../packages/permissions/src/index.ts))
answer one question — *"is this principal allowed to do this?"* — as a **pure
decision function**. The runtime *enforces* the decision by refusing to call
capabilities; the engine itself has no side effects and no dependencies beyond
IR types, so it is testable in isolation and reusable at every layer.

### The model (deliberately simple)

An app's `PermissionsSpec` declares:

- **roles** — e.g. `owner`, `manager`, `employee`, `finance`;
- **action policies** — `actionName → allowed roles`;
- **model policies** — per-model CRUD, each either a role list or a **rule**
  (`allow` roles + an optional row-level `where` predicate expression);
- a **default** (`deny` recommended).

`owner` is always allowed (the escape valve for the app's creator). Everything
else is explicit.

**Why so minimal.** The primary author is a non-programmer speaking intent:
"only managers approve," "finance can only view," "employees see just their
own." Each phrase must map to exactly one obvious construct. A richer policy
language (ABAC trees, policy inheritance) would be more expressive and far
harder for the AI to generate correctly and for a human to understand when
shown back to them. Elegance is the tight fit between *sentences people say*
and *rules the engine holds*.

### Row-level rules, the one piece of real power

The demo's Expense Tracker read policy is the whole of "employees see only
their own expenses, managers and finance see all":

```jsonc
"read": {
  "allow": ["manager", "finance", "employee"],
  "where": { "$op": "or", "args": [
    { "$op": "has", "args": [ {"$":"user.roles"}, "manager" ] },
    { "$op": "has", "args": [ {"$":"user.roles"}, "finance" ] },
    { "$op": "==",  "args": [ {"$":"row.submittedBy"}, {"$":"user.id"} ] }
  ]}
}
```

The engine returns this `where` expression; the runtime evaluates it per row
against `{user, row}` while serving a query and drops rows that fail. The demo
shows the effect directly: manager sees 3, finance sees 3, **employee sees only
their own 2 of 3** ([`examples/demo.ts` step 7](../examples/demo.ts)). Note the
rule is expressed in the *same* expression AST as app logic — one language for
the whole platform.

### Two orthogonal permission planes (a common conflation we avoid)

There are two different questions, and mixing them is the classic mistake:

1. **Can you open the object?** — document-style sharing
   (`owner`/`editor`/`viewer`/`public`) on the [workspace object](09-workspace-and-ux.md).
   This is "do you have the link / were you shared in."
2. **What authority do you have inside the app?** — the app's internal roles
   (`manager`, `finance`). This is "can you approve."

Fabric keeps these separate: `@fabric/workspace` owns (1), `@fabric/permissions`
owns (2). A finance analyst might be a *viewer* of the object (can open it) and
hold the *finance* role inside it (can see all rows, approve nothing). Treating
these as one scale would make correct policies impossible to express.

## 24. The security model

Security in Fabric is **structural**, not disciplinary. It does not depend on
apps being well-behaved, because apps are AI-generated and cannot be trusted to
be.

### The confinement guarantee

- **One path to any effect.** Every side effect goes through
  `ExecutionHost.call`. There is no ambient `fetch`, no filesystem, no
  `process.env`, no network reachable from the IR or the expression evaluator.
  An app can do *only* what its declared capabilities expose.
- **Every path is authorized.** Action invocation is gated by action policy;
  data access is gated by model policy and row rules — both checked *before*
  any I/O, at the runtime boundary.
- **The evaluator is sandboxed by design.** The expression language is total
  and pure (no loops, no `eval`, no host access beyond a fixed function
  allow-list). A malicious expression cannot exfiltrate, spin, or crash the
  host.
- **Tenant isolation is namespaced.** Each app installation's storage lives in
  its own namespace (`workspace:app:instance`); apps cannot address each
  other's data. Isolation is a property of the address space, not a `WHERE`
  clause an app might omit.

### The secret vault

Secrets live in the runtime's `SecretVault`
([`packages/runtime/src/secrets.ts`](../packages/runtime/src/secrets.ts)),
keyed by app installation, injected only into capability *config* and never
exposed to app logic or the client. The IR names secrets; it never holds them.
This is why an app can be shared or forked freely: there is no secret in the
document to leak. Capabilities that need credentials (Slack, Stripe) read them
from the vault via the scoped `SecretReader` — the app never sees the token.

### Threat model, briefly

| Threat | Mitigation |
|--------|------------|
| Hallucinated/malicious IR | Confinement + validation gate; worst case is a wrong app, not a breach. |
| Cross-tenant data access | Per-installation storage namespaces; no shared address space. |
| Secret leakage via sharing/forking | Secrets never in IR; vault keyed by installation. |
| Privilege escalation via connections | Connections run under defined authority; target app's own permissions still apply. |
| Runaway/abusive logic | Total evaluator; per-call context; production adds execution budgets on Fluid Compute. |
| Injection through data | Structured `Query` (no SQL from apps); expressions are data, not parsed strings. |

### What v1 explicitly defers

Signed capability plugins (supply-chain trust for third-party capabilities),
per-capability rate limits and quotas, and formal data-residency zones. Each is
additive and none changes the confinement model — they harden a boundary that
already exists. See [roadmap](10-tech-structure-roadmap.md).

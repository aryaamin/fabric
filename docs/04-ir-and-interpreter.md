# 8, 9, 22. IR Specification, Interpreter & Future Compiler

## 8. The IR specification

The IR ([`packages/ir/src/document.ts`](../packages/ir/src/document.ts)) is the
source of truth. An application *is* an `AppDocument`. Nothing about an app
exists outside it.

### Top-level shape

```ts
interface AppDocument {
  spec: string;                 // IR version — enables migration
  id: string; name: string; icon?: string; description?: string;
  capabilities: CapabilityRef[];// abstract powers required (never infra)
  models:  Model[];             // data shapes → storage provisioned automatically
  actions: Action[];            // logic, as declarative steps
  events:  EventDef[];          // this app's public "outputs"
  subscriptions: Subscription[];// reactions to events (composition)
  views:   View[];              // UI, as an abstract component tree
  permissions: PermissionsSpec; // roles + rules, enforced by the runtime
  schedules?: Schedule[];       // cron-driven actions
  secrets?: SecretRef[];        // names only; values live in the runtime vault
}
```

### Design decisions, and why

- **One document, not many files.** A whole app is one JSON value. That is what
  makes it a "workspace object" you can hash, diff, fork, and hand to a model
  whole. Splitting into files would reintroduce the project-management burden
  we are trying to abolish.

- **Data schema is declared, not migrated.** `models` describe shapes; the
  runtime provisions storage. There are no migration scripts because there is
  no database the user manages. Adding a field is an IR edit
  ([shown in the demo](../examples/demo.ts)), and the store adapts.

- **Orchestration is data.** An `Action` is a list of `Step`s
  (`call`, `code`, `emit`, `let`, `if`, `forEach`, `return`) over a scope. This is the
  most consequential and least obvious decision, so it gets its own section
  below.

- **UI is an abstract tree.** `views` are `Node`s (`Page`, `Table`, `Form`, …)
  with `props`, a data `bind`, `children`, and event `on` handlers. The IR says
  *what* the UI is; a renderer decides *how*. This decouples apps from any UI
  framework and makes embedding trivial.

- **Composition is first-class.** `events` and `subscriptions` are top-level,
  not bolted on. Connecting apps is therefore a native operation, not an
  integration feature. See
  [events & connections](05-composition-events-connections.md).

- **Secrets are named, never valued.** The IR may reference `{$:"secrets.X"}`
  but never contains `X`. Because documents are shared and forked, a valued
  secret would leak instantly. This is enforced by the runtime's
  [secret vault](06-permissions-and-security.md#the-secret-vault).

### The expression model — logic without code

The single hardest requirement: the AI must express logic, but "logic" must not
mean "code," or we lose diffability, validation, sandboxing, and portability
all at once. The answer
([`packages/ir/src/expr.ts`](../packages/ir/src/expr.ts)) is a tiny JSON AST:

```
literal            42 · "hi" · true                     (plain JSON)
reference          {$: "input.amount"}                  (read from scope)
operator           {$op: "+", args: [a, b]}             (pure operators)
function           {$fn: "now", args: []}               (fixed built-ins)
conditional        {$if: [cond, then, else]}            (total)
object literal     { key: <expr>, ... }                 (recursively evaluated)
```

The **only** magic is reserved `$`-prefixed keys; a plain string is always a
literal string, never re-parsed. Why this specific design:

- **Total & pure.** The evaluator
  ([`packages/interpreter/src/evaluate.ts`](../packages/interpreter/src/evaluate.ts))
  cannot loop forever (recursion is over a finite tree only), cannot reach
  outside its scope, and has no `eval`. An adversarial or hallucinated
  expression is at worst wrong, never dangerous.
- **AI-writable.** The grammar is small enough that a model emits it reliably,
  and unambiguous enough that the validator can check it structurally.
- **Diffable.** Two expressions differ as JSON differs — which is exactly what
  the [version diff](08-versioning.md) shows the user.
- **Portable.** The same AST can be *evaluated* by the interpreter today and
  *compiled* to TypeScript/SQL later (§22) with identical semantics.

We deliberately did **not** adopt a general expression language (JS subset,
Lua, JSONata). Each would be more powerful and far harder to validate, secure,
diff, and compile. Elegance here means *less* language, not more.

## 9. The interpreter

The interpreter ([`packages/interpreter`](../packages/interpreter)) runs the IR
directly. It has three pure parts and one injected dependency:

- **`evaluate(expr, scope)`** — the expression evaluator above.
- **`runAction(action, invocation, host)`** — walks an action's steps over a
  scope (`input`, `steps`, `let`, ambient `user`/`app`/`now`/`event`), calling
  capabilities through the host and collecting emitted events.
- **`resolveView(view, host, ambient)`** — turns a `Node` tree into a
  renderer-agnostic `RenderNode` tree, evaluating props and executing data
  bindings through the host.
- **`ExecutionHost`** — the injected port the runtime implements. The
  interpreter knows nothing about capabilities, permissions, or storage; it
  asks the host to `call`, run a pinned `code` unit, `emit`, and `query`. This inversion is what keeps
  the interpreter a pure function of (IR, host) and trivially testable.

**Why an interpreter and not a code generator (the central bet).**

| | Interpreter | Code generator |
|---|---|---|
| Live edit | re-run over new IR — instant | regenerate + rebuild + redeploy |
| Fork / duplicate | copy a JSON value | copy + reconcile a codebase |
| Time travel | point at an old snapshot | check out + rebuild |
| Safety | confined evaluator | must sandbox arbitrary code |
| Debuggability | inspect data at each step | read generated code |

For "small software" edited by conversation, the interpreter wins on every axis
that matters. The only axis a code generator wins is raw performance at scale —
which is explicitly not our optimization target, and which we can reclaim later
without a rewrite (§22).

## 22. Future compiler architecture

The interpreter is the *reference semantics*. A compiler is a later,
*optional*, *semantics-preserving* optimization — never a replacement.

- **What it compiles.** Hot paths: an action that runs thousands of times, a
  `query` that would be far faster as native SQL, a view rendered on every
  request. The IR is already an AST, so compilation is a straightforward
  lowering: expression AST → TypeScript expressions; `Query` → SQL; a `Model` →
  a typed table; a `View` → a prebuilt component module.
- **Why it is safe to add later.** Because the IR is the source of truth and
  the interpreter defines meaning, the compiler is validated by a single
  property: *for all inputs, compiled output equals interpreted output.* We can
  compile one construct at a time and fall back to the interpreter for anything
  not yet compiled. There is never a "big rewrite" moment.
- **Why not now.** Compilation trades flexibility for speed. During the years
  when the product is about creation velocity and live editing, flexibility is
  the asset. We buy speed only once specific apps prove they need it, and only
  for those apps. Premature compilation would be the classic mistake of
  optimizing the thing that is not the bottleneck.

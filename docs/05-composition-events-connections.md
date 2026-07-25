# 11, 12. Event System & Connection System

Composition is the feature that turns a collection of small apps into a
platform. The design goal: **connecting two apps should feel like connecting
Lego bricks — and require zero code, zero APIs, and zero knowledge of the other
app's internals.**

## 11. The event system

Every app declares `events` (its public outputs) and emits them from action
steps. Events flow onto a workspace-scoped bus
([`packages/events/src/index.ts`](../packages/events/src/index.ts)).

```ts
interface FabricEvent<T> {
  id: string;
  source: string;      // "<appId>" or "cap:<capability>"
  name: string;        // e.g. "expenseApproved"
  payload: T;
  workspaceId: string;
  at: string;
  causationId?: string;// trace a causal chain across apps
}
```

**Why events are the composition primitive** (rather than function imports or
REST calls between apps):

- **Late binding.** The emitter does not know who listens. Accounting can start
  listening to the Expense Tracker years after the Expense Tracker was built,
  with no change to the Expense Tracker.
- **Fan-out.** One `expenseApproved` can drive accounting, notifications, and
  an audit log simultaneously. Direct calls would hard-wire one consumer.
- **Decoupling in time.** An event is a durable fact. In production the bus is
  backed by an at-least-once durable queue (Vercel Queues), so a consumer that
  is momentarily down still receives the event. Synchronous calls couple
  liveness.
- **It matches how non-programmers think.** People describe automations as
  "*when* X happens, do Y." An event *is* "X happened"; a subscription *is*
  "do Y." The mental model and the mechanism are the same thing.

The reference bus is in-process and delivers sequentially so causal chains are
deterministic in development. The interface is identical to the durable
production bus, so no app or connection changes when the backing store does.

Capabilities also emit events (`storage` emits `created`/`updated`/`deleted`).
This means an app — or another app — can react to *data changes* it did not
explicitly announce, which is a powerful, uniform hook.

## 12. The connection system

A **connection** is the runtime realization of a `Subscription` declared in an
app's IR ([`packages/connections/src/index.ts`](../packages/connections/src/index.ts)):

```jsonc
// in the Accounting app's IR:
{
  "on":  "expense-tracker.expenseApproved",   // another app's event
  "run": "recordEntry",                        // this app's action
  "map": { "amount": {"$":"event.amount"},     // event payload → action params
           "memo":   {"$":"event.description"} }
}
```

The `ConnectionManager` subscribes to the bus for each subscription's pattern.
On a matching event it evaluates the `map` (with `$event` in scope) to produce
the target action's params, then invokes that action through the runtime. That
is the entire mechanism — and it is why the demo's Accounting ledger fills in
automatically the instant a manager approves an expense, with no API between
the two apps ([`examples/demo.ts` step 6](../examples/demo.ts)).

### Why this is safe and not chaos

- **Connections run under a defined authority.** In the reference runtime a
  connection invokes the target action as the app's *system principal* (owner
  authority within that app). The target app's own
  [permissions](06-permissions-and-security.md) still apply — a connection can
  never do something the target app itself forbids.
- **The source app is never trusted with the target's internals.** It only
  emitted a fact. The target app decided what to do with it. Neither imported
  the other.
- **Loops are observable.** Every event carries a `causationId`; the runtime
  can detect and break cycles, and the activity feed shows the causal chain.

### The non-programmer story, end to end

> HR: "When a leave request is approved, post it to Slack."

The AI adds a `slack` capability to the Leave app (if not present), and a
subscription `{ on: "leave.requestApproved", run: "postToSlack", map: {...} }`.
No integration project, no webhook plumbing, no OAuth dance surfaced to the
user — the `slack` capability owns the credentials in the
[vault](06-permissions-and-security.md#the-secret-vault). The user said a
sentence; a connection now exists.

### Why not a visual node graph (the obvious alternative)

A drag-the-wires canvas (à la Zapier/n8n) makes the connection the *primary*
artifact the user maintains. We instead keep connections as **declarations
inside the apps that own them**, produced from sentences. The graph can still
be *rendered* for visualization, but it is a derived view of the IR, not the
thing the user edits. This keeps a single source of truth (the IR) and keeps
authorship conversational.

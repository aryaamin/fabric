# 15, 16. AI Orchestration & Live Editing

## 15. AI orchestration

The AI does **not** generate code and does **not** return a whole application.
For each turn of conversation it returns a small list of **IR patches**. The
orchestrator ([`packages/orchestrator/src/index.ts`](../packages/orchestrator/src/index.ts))
is the deterministic spine wrapped around the fallible model:

```
prompt + current IR + capability manifests
        │        (Planner: an LLM, or a deterministic mock)
        ▼
     Patch[]  ──►  apply  ──►  validate  ──►  accept (new version)  or  reject
```

### Why patches, not whole documents or code

- **Patches are the changelog.** The AI's edit *is* the version-history entry,
  for free — no separate summarization step, no drift between "what changed"
  and "what the AI said it changed."
- **Small and fast.** "Add a comments field" is a one-line patch, not a
  regeneration of the app. Conversational editing must be cheap.
- **Validated before they can hurt anyone.** A patch is applied to a copy, then
  the result is run through the [validator](../packages/validator). A patch
  that references a non-existent capability or dangles a reference is
  *rejected* — it never reaches the user's running app. The model is allowed to
  be wrong; the pipeline is not.
- **Precise.** Editing a whole document invites the model to "helpfully" change
  unrelated things. A patch touches exactly what was asked.

### The planner is injected

`Planner` is an interface. This matters because it lets the identical pipeline
run with:

- **`MockPlanner`** — a deterministic, offline stub that recognizes a few
  phrasings, used in tests and the
  [`examples/conversation.ts`](../examples/conversation.ts) demo (no network,
  no model);
- **`createAiPlanner`** ([`apps/studio/lib/ai-planner.ts`](../apps/studio/lib/ai-planner.ts))
  — the production planner using the **Vercel AI SDK** with structured output,
  routed through the **AI Gateway** (model strings like
  `anthropic/claude-sonnet-4.6`, OIDC auth, no provider keys in the app).

No code path diverges between demo and production; only the planner instance
differs.

### What the model is given (and why it can't hallucinate infra)

The planner prompt contains exactly three things: the current IR, the
**capability manifests** (its entire menu of possible powers), and the IR
grammar. Infrastructure is not in the prompt because infrastructure is not a
capability. The model literally has no token for "Postgres." It can only
compose the capabilities that exist — which is the same guarantee the
[runtime](02-system-architecture.md) enforces, now pushed up into generation.

In production the planner is best expressed as an **AI SDK agent with tools**
(`listCapabilities`, `getIR`, `proposePatches`, `validate`) so the model can
check its own work before returning — the validate tool closes the loop, and
the orchestrator's post-validation remains the hard gate.

## 16. Live editing architecture

Because an application *is* its interpreted IR, "editing" and "deploying" are
the same cheap operation: change the IR, re-run the interpreter.

```
user types a request
      │
      ▼
orchestrator.edit → Patch[] → validate → new AppDocument
      │
      ▼
runtime.install(next)     ← validate + snapshot version + rewire connections
      │
      ▼
runtime.renderView(...)   ← interpreter produces a fresh RenderNode tree
      │
      ▼
canvas swaps               ← no rebuild, no redeploy, no reload
```

This is realized in the studio: [`app/api/edit/route.ts`](../apps/studio/app/api/edit/route.ts)
runs the orchestrator and returns the freshly rendered view;
[`AppEditor.tsx`](../apps/studio/app/w/[slug]/AppEditor.tsx) swaps the canvas.
The whole round trip is "run a function," because that is all a "deployment"
is here.

**Why this is only possible with an interpreter.** A code-generation product
must, on every edit, regenerate a codebase, install dependencies, build, and
redeploy — seconds to minutes, and a new class of build failures. Interpreting
the IR makes the edit latency the latency of the model call plus a JSON parse.
Live editing is not a feature we added; it is a *consequence* of interpreting
the source of truth. (See the
[interpreter rationale](04-ir-and-interpreter.md#9-the-interpreter).)

**Concurrency & collaboration (roadmap).** Because edits are patches over a
shared JSON document, real-time multiplayer editing is the same problem Google
Docs solved: apply patches through a CRDT/OT layer keyed on the IR. The
architecture is already patch-native, so collaboration is additive rather than
a redesign.

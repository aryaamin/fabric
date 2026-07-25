# Fabric — Demo Script & Positioning

A six-minute demo. The goal is not to show that AI can build an app — everyone shows that
now. The goal is to show what becomes possible **once an application stops being a codebase**.

---

## The one-sentence framing

> Every other AI app builder generates a codebase and deploys it. Fabric generates a
> **document** and interprets it. Everything that feels slow or impossible on the first
> model is instant on the second.

Codegen platforms (v0, Lovable, Bolt, Emergent) share one architecture:

```
prompt → generate source code → install dependencies → build → deploy → URL
```

Fabric's architecture:

```
prompt → IR patch → validate → swap document → interpret → already live
```

There is no build step to be fast at, because there is no build step.

---

## Demo flow

### 1. Create (0:00 – 1:00)
From the workspace home — apps sitting alongside docs and dashboards as first-class
objects — type: *"Track team expenses with approvals."*

Fabric writes an IR document. The app is live and has a URL before the sentence finishes
rendering. **Nothing was built or deployed.**

### 2. Use it — as a non-technical person (1:00 – 2:00)
Fill in the form. Submit. A row appears. This matters: the demo is not a mockup, a
non-technical user is entering real data into real storage, and no one chose a database.

Handler arguments are evaluated **server-side from the IR** with a `$form` scope — the
browser sends only raw field values, so a user cannot forge action arguments.

### 3. Edit by conversation (2:00 – 3:00)
*"Add a category field and only let managers approve."*

The chat panel shows the **IR patch as a semantic diff** — `+ field category on Expense`,
`~ permission approve → role:manager` — and the applied latency in milliseconds. Compare
this to reviewing a wall of regenerated source code and waiting for a redeploy.

The canvas updates in place. No rebuild. No redeploy. No lost state.

### 4. Time travel (3:00 – 4:00) — the moment
Drag the version scrubber backwards. The app re-renders at every past version as you drag,
instantly, because restoring a version is pointing a pointer at a different document.

On a codegen platform this is a git revert plus a rebuild plus a redeploy, per step. It is
not something you can *scrub*.

Then fork it. Instant — forking is copying a JSON value, not cloning a repo and
reinstalling a dependency tree.

### 5. Compose (4:00 – 5:00)
*"When an expense is approved, record it in accounting."*

Two independently-created apps wire together through an event, with no API, no SDK, no
webhook, no credentials. The connection graph shows the wire, and pulses when the event
actually flows. Cross-app composition is a property of the runtime, not code someone wrote.

### 6. Share (5:00 – 5:30)
One link, three surfaces, decided by the viewer's access: full studio for editors,
run-only for viewers, chromeless for embeds. Exactly the Google Docs mental model, applied
to software.

### 7. Prove it (5:30 – 6:00)
Open the benchmark panel and run it live.

---

## The measurable claim

Run `npm run benchmark` (or the in-studio panel). Fabric's numbers are **measured on the
spot**; the comparison column is a **clearly-labeled typical range for a
regenerate-build-deploy cycle**, not a measured benchmark of any named competitor.

| Operation | Fabric (measured) | Codegen + redeploy (typical reference) |
| --- | --- | --- |
| Apply an edit | _filled by benchmark_ | seconds to minutes (rebuild + redeploy) |
| Fork an app | _filled by benchmark_ | repo clone + dependency install + deploy |
| Restore a version | _filled by benchmark_ | git revert + rebuild + redeploy |
| Generated code files per app | 0 | thousands |
| Dependencies installed per app | 0 | hundreds |
| App footprint | kilobytes of IR | hundreds of megabytes |

The headline number is the **edit-apply latency multiplier** — but the structural wins are
the more durable argument:

- **Instant fork / duplicate** — copying a document, not a repository.
- **Scrubbable time travel** — versions are content-addressed snapshots, not commits to rebuild.
- **Zero build artifacts** — nothing to compile, cache, or invalidate.
- **Cross-app connection without APIs** — apps declare events; the runtime binds them.
- **Permissions and multi-tenancy for free** — enforced by the runtime, not written per app.
- **Semantic diffs, not code diffs** — AI edits are validated patches, so they can be
  checked, rejected, and explained before they run.

A codegen platform can get its build faster. It cannot make an app stop being a codebase.

---

## Honesty guardrails (keep these in any deck)

- Fabric's numbers are measured; state the hardware and that they are in-process.
- The comparison column is a typical range for the build-and-deploy model, and is labeled
  as such. Do not attribute specific numbers to a named competitor.
- Fabric optimizes for **Small Software** — personal tools, internal apps, dashboards,
  automations. It is not competing on hyperscale, and saying so makes the rest credible.

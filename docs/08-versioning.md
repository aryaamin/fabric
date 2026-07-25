# 10. Versioning System

Every prompt creates a new version. The user gets restore, fork, duplicate, and
compare — all the ergonomics of Git, and none of its concepts exposed.

## The design: a content-addressed DAG

([`packages/versioning/src/index.ts`](../packages/versioning/src/index.ts))

Because the IR is plain JSON, a version is just a **hashed document plus a
parent pointer**:

```ts
interface Version {
  id: string;        // content hash of the IR (stable across runs)
  parent?: string;   // previous version → forms a DAG
  appId: string;
  author: string;    // "ai" | "system" | userId
  message: string;   // the prompt, or a human summary
  doc: AppDocument;  // the full snapshot
}
```

From this one structure everything the product needs falls out:

| Product feature | Mechanism |
|-----------------|-----------|
| **New version on each edit** | `commit(doc, parent)` — snapshot + link |
| **Restore** | move the app's `head` pointer to an older version |
| **History** | walk `parent` links from `head` to root |
| **Fork** | create a new app whose root parent is another app's version |
| **Duplicate** | a fork within the same workspace |
| **Compare** | structural `diff(a, b)` of two IR documents |

The demo exercises the full set: it edits the Expense Tracker (adds a `notes`
field via a patch), commits a new version, prints history, diffs v1→v2, then
restores v1 ([`examples/demo.ts` steps 9–11](../examples/demo.ts)).

## Why content-addressing

- **Free deduplication and integrity.** Identical documents hash to the same
  id; a version id *is* a checksum of the app's exact state.
- **Deterministic diffs.** Two versions differ iff their canonical JSON
  differs, and the [diff](../packages/versioning/src/index.ts) is computed over
  that JSON — human-legible as "added `models.0.fields.5`," not as a code
  patch.
- **Cheap forking.** Fork = copy a JSON value + set a parent. There is no
  branch to reconcile, no working tree, no merge machinery to expose.

## Why hide Git rather than use Git

Git is the right *model* (immutable snapshots, parent links, content hashing)
and the wrong *interface* for this user. "Commit," "branch," "rebase,"
"detached HEAD" are concepts a non-programmer neither has nor should acquire.
Fabric keeps the model and replaces the vocabulary with **History, Restore,
Fork, Duplicate, Compare** — words that already mean something in a documents
app. Reusing Git the tool would also drag in a filesystem and a CLI, both of
which contradict "no files, no infrastructure."

## Diffs the user actually understands

Because edits arrive as [patches](04-ir-and-interpreter.md) and versions are
JSON, the "compare" view can render changes semantically: *"Added a Notes field
to Expense," "Employees can now edit," "Connected to Slack."* The raw
structural diff is the substrate; a small humanizer (the AI, or a rules table)
turns paths like `models.name(Expense).fields[+]` into that sentence. The user
sees meaning, not JSON — but the JSON is always there underneath for
determinism.

## Production notes

The reference store is in-memory. In production, versions are rows keyed by
content hash (the `doc` blob compressed), `head` is a pointer per app, and
history is a parent walk — none of which changes the interface above. Because
snapshots are immutable and content-addressed, they are trivially cacheable and
safe to serve from the edge for public/embedded apps.

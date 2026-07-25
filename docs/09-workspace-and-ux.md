# 5, 17. Workspace Architecture & UX

## 5. Workspace architecture

A workspace ([`packages/workspace/src/index.ts`](../packages/workspace/src/index.ts))
is a collection of **objects**. An app is one kind of object, sitting beside
documents and folders — that adjacency is the entire product metaphor.

```ts
interface WorkspaceObject {
  id: string;
  kind: "app" | "document" | "folder";
  name: string; icon?: string; parentId?: string;
  appId?: string;          // app objects point at the runtime-installed app
  slug: string;            // stable, URL-safe, used for links and embeds
  grants: Grant[];         // owner / editor / viewer
  public: boolean;
  createdAt: string; updatedAt: string;
}
```

**Why the workspace is a separate layer from the runtime.** The runtime knows
how to *run* an app; the workspace knows an app is an *object a person owns,
names, files, shares, and embeds.* Keeping them apart means the object model
(sharing, folders, URLs) evolves independently of execution, and the same
runtime can back objects that live in very different surfaces (a Fabric
workspace, an embed inside Notion, a public link).

**Sharing is document-style and orthogonal to app roles.** `owner`/`editor`/
`viewer`/`public` decide *access to the object*; the app's internal roles
(`manager`, `finance`) decide *authority inside it*. These are two different
questions and are kept in two different layers — see
[permissions](06-permissions-and-security.md#two-orthogonal-permission-planes-a-common-conflation-we-avoid).

**URLs and embedding are intrinsic, not a feature.** Every object has a `slug`,
so it has a URL (`/w/:ws/:slug`) and an embed URL (`/embed/:ws/:slug`) the
moment it exists — proven by the [preview server](../apps/server/src/server.ts)
and `embedSnippet()`. An app is embeddable anywhere an `<iframe>` is allowed:
inside another Fabric app, inside Notion, inside Confluence. Applications become
reusable UI blocks, which is the deepest form of composition — an app is not
just connectable by events, it is *placeable* inside another app's view.

### How sharing actually works (the Google-Docs model, implemented)

Sharing has exactly three modes, mirroring Google Docs, and one decision
function resolves them ([`resolveAccess`](../packages/workspace/src/index.ts)):

1. **Restricted** (default) — only people in `grants` (invited by id, like
   typing an email) can open it.
2. **Anyone with the link** — `createShareLink(base, ws, obj, "viewer"|"editor")`
   sets `linkRole` and returns a URL carrying an unguessable `shareToken`
   (`…/w/:ws/:slug?k=<token>`). Whoever holds the link gets that role. The link
   *is* the capability; there is nothing else to check.
3. **Published to the web** — `setPublic(obj, true)` makes it viewable by
   anyone with no token at all.

Precedence is Google's: an explicit grant wins, else a valid link token, else
public, else no access. **Revoking** is `disableShareLink(obj, rotate=true)` —
it clears `linkRole` and rotates the token, so every previously-shared link
dies at once. All of this is demonstrated end-to-end in
[`examples/sharing-demo.ts`](../examples/sharing-demo.ts) and *enforced* by the
[preview server](../apps/server/src/server.ts): a request with no grant and no
token gets a `403`, a request with `?k=<token>` renders the app.

**Why a capability token in the URL rather than per-request auth.** Link
sharing must work for someone who has no account and clicks a link in an email —
exactly the Google-Docs experience. The token is a bearer capability: holding
it is the authorization. For higher-sensitivity apps the owner keeps the object
*Restricted* (grants only) or *published* read-only; the same `resolveAccess`
handles all three without special cases. Object access (this section) remains
orthogonal to in-app authority (roles like `manager`) — the token lets you
*open* the app; your role still decides what you can *do* inside it.

## 17. Workspace UX

The UX has exactly two primary surfaces, mirroring the two verbs "make" and
"use."

### Creating & editing — the studio

A split view ([`apps/studio`](../apps/studio)): the **live app on the left**,
the **conversation on the right**. This is the whole thesis rendered as a
layout — the app and the sentences that shape it sit side by side, and every
message re-renders the canvas instantly because it only re-runs the
interpreter.

```
┌───────────────────────────────┬──────────────────────────┐
│                               │  🧾 Expense Tracker       │
│   [ live app canvas ]         │  ───────────────────────  │
│                               │  you: only managers approve│
│   Expenses                    │  ai:  Applied 1 change.    │
│   ┌───────────────────────┐   │  you: connect to Slack     │
│   │ desc   amount  status │   │  ai:  Applied 2 changes.   │
│   └───────────────────────┘   │  ┌──────────────────────┐  │
│                               │  │ Describe a change…   │  │
└───────────────────────────────┴──┴──────────────────────┴──┘
```

Design defaults follow a modern product bar: dark by default (developer/internal
surface), neutral zinc palette with one accent, `shadcn/ui` + Geist in
production. The canvas renders the interpreter's `RenderNode` tree via the React
[`Renderer`](../apps/studio/components/Renderer.tsx) — the *same tree* the
server renders to HTML, proving views are renderer-agnostic.

### The non-programmer walkthrough (the acceptance test for the whole product)

> HR: "I need a leave approval system." → an app appears, with a URL.
> "Now connect Slack." → a `slack` capability + subscription are added.
> "Only managers approve." → an action policy is written.
> "Finance can only view." → a `viewer` share + a `finance` read role.

No coding, no deployment, no infrastructure — each sentence is one IR edit,
validated and live. If any of these four sentences requires the user to think
about a computer, the design has failed. Everything in these documents exists
to keep that from happening.

### Using — URLs & embeds

Opening the app's URL renders it read/write per the viewer's access and roles.
Embedding drops the same app into any page via an `<iframe>`. The consumer of
an embed never knows there is a runtime, an IR, or an interpreter behind the
frame — exactly as they do not know what renders a Google Doc.

### One link, three surfaces

A single URL points at a single workspace object, and *the object's access
decides the UI*. There is no separate "edit link" and "view link" — the link
carries a capability, [`resolveAccess`](../packages/workspace/src/index.ts)
turns it into a role, and one pure function,
[`surfaceForAccess(role, {embed})`](../packages/workspace/src/index.ts), maps
that role onto exactly one of three surfaces:

| Access resolved | Surface | What the visitor gets |
| --- | --- | --- |
| editor / owner | **studio** | the make surface — canvas + AI chat + toolbar (Run/Modify/Version/Share/Connect/Embed) |
| viewer / public | **run** | the running app only, read-only, plus a "Fork a copy" affordance |
| (embed route) | **run** | the chromeless running app, regardless of role |
| none | **denied** | a `403` / lock screen |

**Why it is one function, imported twice.** The [preview server](../apps/server/src/server.ts)
and the [studio page](../apps/studio/app/w/[slug]/page.tsx) both branch on
`surfaceForAccess`, so the two can never disagree about who edits, who runs, and
who is locked out. Adding a surface or changing a rule is a one-line change in
`@fabric/workspace`, not a hunt across renderers.

**Why the rules are what they are.**
- *No role → denied.* Access is decided *before* the surface; a link you cannot
  open shows a lock screen, never an app.
- *embed → always run.* An `<iframe>` is a *placement* of an app, never an
  editor — even an owner embedding their own app wants the chromeless running
  app inside the frame, so the embed route forces `run`.
- *editor/owner → studio, viewer → run.* This is the product's two verbs —
  *make* (studio) and *use* (run) — expressed as routing. The preview server is
  not the editor, so an editor/owner who lands there sees an "Open in Studio to
  edit" banner rather than an editing UI the server does not host.

The decision is exercised end-to-end (no HTTP needed) in
[`examples/access-routing-demo.ts`](../examples/access-routing-demo.ts), which
prints the surface every visitor archetype lands on as sharing changes from
Restricted → link-viewer → link-editor → published.

### Feedback the user can trust

Because every edit is a [version](08-versioning.md) and every capability call is
a [log line](../packages/runtime/src/logger.ts), the studio can always show
"here's what changed" and "here's what your app just did." For a non-technical
owner who cannot read a stack trace, this legibility is not a nicety — it is the
difference between trust and abandonment.

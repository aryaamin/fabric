# 1–2. Vision & Product Philosophy

## The vision

Software should be as easy to create, edit, share, compose, and collaborate on
as a Google Doc.

Today a document is a first-class object: you make one in a second, it has a
URL, you share it by typing an email address, you see its history, you can copy
it, comment on it, and embed it — and you never think about servers, files on
disk, or where it "runs." **Applications should become exactly that kind of
object.**

A workspace should look like this, where the app icons are as ordinary as the
document icons:

```
Acme Inc
 📄 Business Plan
 📊 Revenue Dashboard      ← an application
 🧾 Expense Tracker        ← an application
 🏖 Leave Requests         ← an application
 🤖 Customer Support Bot   ← an application
```

Every one of those apps has, automatically and without configuration: a URL, a
Share button, permissions, version history, an AI editor, events, an API,
connections, and storage. You create one by describing it. You change it by
talking to it. You never deploy it.

## Who it is for

**"Small Software."** Personal tools, internal company apps, dashboards,
automations, AI assistants, prototypes, one-off utilities, workflows. Apps with
one to ten users. This is not a hyperscale platform and pretending otherwise
would corrupt every design decision. We optimize for **creation velocity and
usability**, explicitly not for peak throughput. (See
[scaling strategy](10-tech-structure-roadmap.md#23-scaling-strategy) for why
that constraint is a feature, not a limitation.)

## What it is not, and why the difference matters

| Not… | Because… |
|------|----------|
| **Cursor / an IDE** | The artifact is not code a human maintains. It is an IR the AI maintains. There is no file tree to open. |
| **Lovable / v0** | Those generate a codebase you then own and deploy. We generate a document that runs on a shared runtime — nothing to own or deploy. |
| **Retool / Bubble** | No-code builders expose a canvas of widgets and a config surface. We expose a conversation. The unit of authorship is a sentence, not a drag. |
| **AWS / Azure / K8s** | Those *are* the infrastructure. We make infrastructure invisible; an app literally has no vocabulary for a database or a container. |

The through-line: **the user never operates a computer.** They describe intent;
the platform is responsible for everything underneath.

## Product philosophy (the axioms every decision is checked against)

1. **The document is the program.** If something cannot be represented as data
   in the IR, it does not exist in an application. This is what makes apps
   diffable, forkable, shareable, and AI-editable. *Consequence:* no escape
   hatch to raw code in v1 — an escape hatch would break versioning, safety,
   and portability all at once.

2. **Infrastructure is a private implementation detail.** Applications name
   *capabilities*, never technologies. "I need to remember things" → `storage`.
   The app cannot tell, and must never be able to tell, whether that is
   Postgres or a JSON file. *Consequence:* we can change the entire backend
   under a million apps without touching one of them.

3. **Interpret before you compile.** A running interpreter over a data
   structure is infinitely more malleable than generated code. Live editing,
   time-travel, and instant forking are trivial for an interpreter and painful
   for a codegen pipeline. We earn flexibility now and buy performance later
   (the [compiler](04-ir-and-interpreter.md#22-future-compiler-architecture) is
   an optimization, never a rewrite).

4. **Composition over integration.** Apps connect by publishing and reacting to
   *events*, not by calling each other's APIs. "When an expense is approved,
   record it in accounting" is a subscription, not an integration project.
   *Consequence:* connecting two apps is a sentence, and neither app has to
   know the other exists.

5. **Authorization lives at the boundary, not in the app.** Because every side
   effect goes through a capability, and every capability call is authorized by
   the runtime, an app *physically cannot* exceed its declared powers — even a
   buggy or AI-hallucinated one. Safety is structural, not disciplined.

6. **Every action a user can take is reversible and inspectable.** Every edit
   is a version. Every capability call is a log line. Nothing is a black box,
   because the target user is not an engineer and cannot debug one.

7. **The non-programmer is the primary user, and the AI is their compiler.**
   The measure of the platform is whether "only managers can approve, finance
   can view" becomes true by *saying it*. Everything that follows — the IR
   shape, the permission model, the capability manifests — is designed so a
   language model can reliably translate intent into that document.

## The bet

If applications become documents, the total addressable creation of software
expands by orders of magnitude, because the population that can "make software"
grows from millions of programmers to everyone who can describe what they want.
Fabric is the runtime that makes that document executable. The rest of these
documents describe how.

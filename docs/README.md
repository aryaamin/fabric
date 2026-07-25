# Fabric — Design Documentation

> The runtime for AI-generated software. Applications become first-class
> workspace objects: created by conversation, shared like a Google Doc,
> connected like Lego, and never deployed.

This is the founding architecture. It is written to survive a decade, so every document leads with **why**, challenges the obvious approach, and points at the
running code that proves the idea (the whole thing executes today — see
`[../examples/demo.ts](../examples/demo.ts)`).

## The one-paragraph thesis

An application is not code and not a database. It is a **declarative document**
(the IR). The IR is the single source of truth: the AI edits it, versioning
snapshots it, the **interpreter** runs it directly, and a future **compiler**
optimizes it. Applications never touch infrastructure; they call abstract
**capabilities** (`storage`, `notifications`, `ai`, …) resolved by a
**runtime** that owns all the real machinery. New powers arrive as plugins in a
**capability registry**, so the platform grows without ever editing its core.

## Deliverables → where they live


| #   | Deliverable                  | Document                                                                  | Code                                                |
| --- | ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Vision document              | [01-vision-and-philosophy](01-vision-and-philosophy.md)                   | —                                                   |
| 2   | Product philosophy           | [01-vision-and-philosophy](01-vision-and-philosophy.md)                   | —                                                   |
| 3   | System architecture          | [02-system-architecture](02-system-architecture.md)                       | —                                                   |
| 4   | Runtime architecture         | [02-system-architecture](02-system-architecture.md)                       | `[packages/runtime](../packages/runtime)`           |
| 5   | Workspace architecture       | [09-workspace-and-ux](09-workspace-and-ux.md)                             | `[packages/workspace](../packages/workspace)`       |
| 6   | Capability system            | [03-capabilities-and-registry](03-capabilities-and-registry.md)           | `[packages/capabilities](../packages/capabilities)` |
| 7   | Capability registry          | [03-capabilities-and-registry](03-capabilities-and-registry.md)           | `[packages/registry](../packages/registry)`         |
| 8   | IR specification             | [04-ir-and-interpreter](04-ir-and-interpreter.md)                         | `[packages/ir](../packages/ir)`                     |
| 9   | Interpreter design           | [04-ir-and-interpreter](04-ir-and-interpreter.md)                         | `[packages/interpreter](../packages/interpreter)`   |
| 10  | Versioning system            | [08-versioning](08-versioning.md)                                         | `[packages/versioning](../packages/versioning)`     |
| 11  | Event system                 | [05-composition-events-connections](05-composition-events-connections.md) | `[packages/events](../packages/events)`             |
| 12  | Connection system            | [05-composition-events-connections](05-composition-events-connections.md) | `[packages/connections](../packages/connections)`   |
| 13  | Storage abstraction          | [03-capabilities-and-registry](03-capabilities-and-registry.md)           | `[packages/storage](../packages/storage)`           |
| 14  | Permission system            | [06-permissions-and-security](06-permissions-and-security.md)             | `[packages/permissions](../packages/permissions)`   |
| 15  | AI orchestration             | [07-ai-and-live-editing](07-ai-and-live-editing.md)                       | `[packages/orchestrator](../packages/orchestrator)` |
| 16  | Live editing architecture    | [07-ai-and-live-editing](07-ai-and-live-editing.md)                       | `[apps/studio](../apps/studio)`                     |
| 17  | Workspace UX                 | [09-workspace-and-ux](09-workspace-and-ux.md)                             | `[apps/studio](../apps/studio)`                     |
| 18  | Folder structure             | [10-tech-structure-roadmap](10-tech-structure-roadmap.md)                 | (this repo)                                         |
| 19  | Technology choices           | [10-tech-structure-roadmap](10-tech-structure-roadmap.md)                 | —                                                   |
| 20  | Development roadmap          | [10-tech-structure-roadmap](10-tech-structure-roadmap.md)                 | —                                                   |
| 21  | MVP scope                    | [10-tech-structure-roadmap](10-tech-structure-roadmap.md)                 | —                                                   |
| 22  | Future compiler architecture | [04-ir-and-interpreter](04-ir-and-interpreter.md)                         | —                                                   |
| 23  | Scaling strategy             | [10-tech-structure-roadmap](10-tech-structure-roadmap.md)                 | —                                                   |
| 24  | Security model               | [06-permissions-and-security](06-permissions-and-security.md)             | —                                                   |
| 25  | Extensibility model          | [03-capabilities-and-registry](03-capabilities-and-registry.md)           | —                                                   |

## New execution and integration surfaces

- [Portability, MCP, Git, and real code](11-portability-mcp-and-code.md)
  explains how apps run outside Studio, how AI clients use them, why the IR
  remains JSON, and where Python/TypeScript and existing services fit.




## Run it

```bash
npm run link:local     # symlink @fabric/* (no network, no external deps)
npm run demo           # end-to-end: install, run, connect, permission, version
node --experimental-strip-types --no-warnings examples/conversation.ts   # AI-style editing
```

The core packages have **zero runtime dependencies** and run on Node's built-in
type stripping. The studio (`apps/studio`) is a Next.js app and needs
`npm install`.
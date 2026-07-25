# Portability, MCP, Git, and Real Code

## The Studio is a client, not the runtime

The Studio is where people create and edit applications. It is not an
execution requirement. `@fabric/host` wraps the same `Runtime` in a Fetch-style
HTTP boundary, while `@fabric/cli` loads `.fabric.json` documents into that
host. A main application may mount the host under its own router, run it as a
sidecar, or call `Runtime` directly.

The portable contract is:

- install a validated `AppDocument`;
- render a named view;
- invoke a named action as a principal;
- submit raw form fields through the document's handler;
- inspect immutable version history.

Authentication is injected. The host's header resolver exists only for local
development; production maps the main application's session or OAuth token to
the existing `Principal` type.

## MCP is another surface over the same trust boundary

`@fabric/mcp` does not create a privileged automation API. It projects:

- each action into a tool whose JSON Schema derives from action parameters;
- each app document into a resource;
- each current view into a live resource;
- workspace install/list/history operations into explicit tools.

Tool execution calls `Runtime.invokeAction`, so action and model policies are
identical for agents and humans. The stdio server uses newline-delimited
JSON-RPC and can be launched with `fabric mcp`.

Production remote MCP adds OAuth at the transport boundary and constructs the
server with the resulting principal. View-only credentials must never be
upgraded to the default owner principal.

## Why JSON stops at orchestration

Fabric's JSON is a serialized AST, not an attempt to replace general-purpose
languages. It is optimized for properties a live-editable app needs:

- structural patches and semantic diffs;
- validation before activation;
- deterministic interpretation;
- explicit capability and permission boundaries;
- content-addressed versions.

Python libraries, algorithms, parsers, ML inference, and existing business
logic belong in normal source files. A `CodeUnitRef` gives the IR a typed
boundary to that code: runtime, relative entry path, timeout, and mandatory
SHA-256 digest. A `code` action step evaluates JSON inputs, invokes the runner,
and binds the JSON output into `$steps`.

The content pin is essential. Restoring an old app version must restore the
exact computation it referenced; silently running today's Python against
yesterday's document would make history dishonest.

`LocalCodeUnitRunner` is a trusted-development adapter. It constrains paths and
checks digests, but dynamic Node imports and local Python processes are not
security isolation. A production `CodeUnitRunner` must use a worker, container,
or microVM, enforce time/memory/network limits, and pass credentials only
through declared capabilities.

## Existing applications integrate as capabilities

Fabric should not ingest an existing monolith. The monolith keeps ownership of
its domain and publishes a contract. `openApiCapabilityFactory()` turns OpenAPI
operations into capability methods:

- path, query, and header parameters become typed inputs;
- request bodies become the `body` input;
- `operationId` becomes the stable method name;
- mutating HTTP methods are marked as mutations;
- bearer credentials come from a named runtime secret.

The app references the generated capability by name, while the runtime owns
the real URL and credentials. Replacing the backend does not edit the app.

## GitHub is a mirror and proposal channel

Runtime versions and Git branches cannot both be authoritative without
creating two heads and ambiguous conflict resolution. Fabric therefore owns
the live head. `writeGitMirror()` exports deterministic files at
`fabric/apps/<id>/app.fabric.json` and records the corresponding version in
`fabric/mirror.json`.

A pull request changes those files. CI validates them with the same validator
used at install time. After merge, `readGitProposal()` validates again before
the host installs the proposal as a new Fabric version. Git remains useful for
review, policy, audit, and code-unit source; Fabric remains useful for
millisecond activation, live state, and document-native history.

## Current production boundaries

The implementation proves the contracts locally. Before Internet-facing use:

1. replace in-memory storage/version adapters with durable stores;
2. inject real session/OAuth authentication into `FabricHost`;
3. run code units in an isolated production runner;
4. add remote MCP transport with OAuth and per-request principals;
5. sign capability packages and restrict outbound OpenAPI destinations;
6. make Git proposal installation an explicit reviewed workflow.

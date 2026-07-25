import type { Expr } from "./expr.ts";

/**
 * The Fabric IR — the single source of truth for an application.
 *
 * WHY: An application is not code and not a database row. It is a declarative
 * document. The document is what the AI edits, what versioning snapshots, what
 * the interpreter renders, and what the (future) compiler compiles. Everything
 * else in the platform is a function of this document + runtime state.
 */

export const IR_SPEC_VERSION = "0.1";

export interface AppDocument {
  /** IR spec version this document targets. Enables forward migration. */
  spec: string;
  id: string;
  name: string;
  icon?: string;
  description?: string;

  /** Abstract capabilities the app requires. The app never names infra. */
  capabilities: CapabilityRef[];

  /** Data shapes. The runtime provisions storage for these automatically. */
  models: Model[];

  /** Named units of logic, expressed as declarative steps. */
  actions: Action[];

  /** Events this app can emit — its public "output" surface. */
  events: EventDef[];

  /** Reactions to events (local or from other apps) — composition. */
  subscriptions: Subscription[];

  /** UI, as an abstract component tree bound to data and actions. */
  views: View[];

  /** Roles + rules. Enforced by the runtime at every boundary. */
  permissions: PermissionsSpec;

  /** Scheduled action invocations. */
  schedules?: Schedule[];

  /** Named secrets the app needs; values live in the runtime vault only. */
  secrets?: SecretRef[];

  /**
   * Real-code escape hatches used by actions.
   *
   * The declarative document owns the contract and pins the exact code digest;
   * the implementation remains a normal Node/Python file in a repository.
   */
  codeUnits?: CodeUnitRef[];
}

export type CodeRuntime = "node" | "python";

export interface CodeUnitRef {
  /** Stable name referenced by CodeStep.unit. */
  name: string;
  runtime: CodeRuntime;
  /** Path relative to the host's configured code root. */
  entry: string;
  /** Required content pin: "sha256:<hex>". */
  digest: string;
  description?: string;
  timeoutMs?: number;
  /** JSON contract available to validators, agents, and generated tooling. */
  input?: Param[];
  output?: FieldType;
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

export interface CapabilityRef {
  /** Registry name, e.g. "storage", "email", "slack". */
  capability: string;
  /** Local alias used in `call` targets. Defaults to `capability`. */
  as?: string;
  /** Semver range the app was authored against. */
  version?: string;
  /** Non-secret configuration; may reference secrets via {$:"secrets.X"}. */
  config?: Record<string, Expr>;
}

/* ------------------------------------------------------------------ */
/* Data model                                                          */
/* ------------------------------------------------------------------ */

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "datetime"
  | "json"
  | "ref"
  | "enum";

export interface Field {
  name: string;
  type: FieldType;
  label?: string;
  required?: boolean;
  default?: Expr;
  /** target model name when type === "ref". */
  ref?: string;
  /** allowed values when type === "enum". */
  enum?: string[];
}

export interface Model {
  name: string;
  fields: Field[];
}

/* ------------------------------------------------------------------ */
/* Actions & steps                                                     */
/* ------------------------------------------------------------------ */

export interface Param {
  name: string;
  type: FieldType;
  required?: boolean;
}

export interface Action {
  name: string;
  params: Param[];
  /** permission key required to invoke (mapped in PermissionsSpec.actions). */
  permission?: string;
  steps: Step[];
  /** value returned to the caller. */
  returns?: Expr;
}

export type Step = CallStep | CodeStep | EmitStep | LetStep | IfStep | ForEachStep | ReturnStep;

/** Invoke a capability method. `call` is "<alias>.<method>". */
export interface CallStep {
  kind: "call";
  /** binds the result into scope as $steps.<id>. */
  id?: string;
  call: string;
  args?: Record<string, Expr>;
}

/** Execute a pinned real-code unit through the runtime's isolated runner. */
export interface CodeStep {
  kind: "code";
  /** binds the result into scope as $steps.<id>. */
  id?: string;
  unit: string;
  input?: Record<string, Expr>;
}

/** Emit one of this app's declared events. */
export interface EmitStep {
  kind: "emit";
  event: string;
  payload?: Record<string, Expr>;
}

/** Bind a computed value into scope as $let.<id>. */
export interface LetStep {
  kind: "let";
  id: string;
  value: Expr;
}

export interface IfStep {
  kind: "if";
  cond: Expr;
  then: Step[];
  else?: Step[];
}

export interface ForEachStep {
  kind: "forEach";
  id: string;
  in: Expr;
  do: Step[];
}

export interface ReturnStep {
  kind: "return";
  value: Expr;
}

/* ------------------------------------------------------------------ */
/* Events, subscriptions (composition)                                 */
/* ------------------------------------------------------------------ */

export interface EventDef {
  name: string;
  payload?: Field[];
}

export interface Subscription {
  /** "<appId>.<event>" for cross-app, or "<event>" for local. */
  on: string;
  /** local action to run. */
  run: string;
  /** map event payload ($event.*) to action params. */
  map?: Record<string, Expr>;
}

/* ------------------------------------------------------------------ */
/* Views (UI)                                                          */
/* ------------------------------------------------------------------ */

export interface View {
  name: string;
  route?: string;
  title?: string;
  root: Node;
}

export interface Node {
  /** Abstract component name resolved by a renderer, e.g. "Page","Table". */
  type: string;
  props?: Record<string, Expr>;
  /** data binding available to this node's subtree. */
  bind?: Binding;
  children?: Node[];
  /** event handlers, e.g. { submit: { action, args } }. */
  on?: Record<string, Handler>;
}

export interface Binding {
  query: Query;
  /** scope name the query result is bound to for children. */
  as: string;
}

export interface Query {
  model: string;
  where?: Expr;
  sort?: { field: string; dir: "asc" | "desc" }[];
  limit?: number;
}

export interface Handler {
  action: string;
  args?: Record<string, Expr>;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

export interface PermissionsSpec {
  roles: string[];
  /** actionName -> roles allowed to invoke it. */
  actions?: Record<string, string[]>;
  /** model -> CRUD policy. */
  models?: Record<string, ModelPolicy>;
  /** fallback when no rule matches. */
  default?: "deny" | "allow";
}

export interface ModelPolicy {
  read?: string[] | Rule;
  create?: string[] | Rule;
  update?: string[] | Rule;
  delete?: string[] | Rule;
}

export interface Rule {
  allow: string[];
  /** row-level predicate; $user and $row are in scope. */
  where?: Expr;
}

/* ------------------------------------------------------------------ */
/* Scheduling & secrets                                                */
/* ------------------------------------------------------------------ */

export interface Schedule {
  name: string;
  cron: string;
  run: string;
  args?: Record<string, Expr>;
}

export interface SecretRef {
  name: string;
  description?: string;
}

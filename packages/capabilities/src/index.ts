/**
 * The Capability contract.
 *
 * A capability is the ONLY way an application touches the outside world.
 * Applications call abstract methods ("storage.create", "email.send"); the
 * capability decides how that maps to Postgres, S3, Resend, etc. Swapping the
 * implementation must never require touching a single app.
 *
 * WHY a uniform, self-describing contract:
 *  - The AI discovers what it can build by reading manifests, not docs.
 *  - The validator checks calls against manifests without running anything.
 *  - The permission layer sits on the single `invoke` chokepoint.
 *  - New powers are added by registering a plugin, never by editing the core.
 */

/* ------------------------------------------------------------------ */
/* Lightweight schema (self-describing, AI-friendly, zero-dep)         */
/* ------------------------------------------------------------------ */

export type SchemaType =
  | "string"
  | "number"
  | "boolean"
  | "datetime"
  | "json"
  | "object"
  | "array";

export interface SchemaShape {
  type: SchemaType;
  description?: string;
  required?: boolean;
  /** for type "object". */
  fields?: Record<string, SchemaShape>;
  /** for type "array". */
  items?: SchemaShape;
  /** allowed string values. */
  enum?: string[];
}

/* ------------------------------------------------------------------ */
/* Manifest — what a capability advertises                             */
/* ------------------------------------------------------------------ */

export interface MethodSpec {
  name: string;
  description?: string;
  input?: Record<string, SchemaShape>;
  output?: SchemaShape;
  /** abstract permission required, e.g. "storage.write". */
  permission?: string;
  /** events this method may emit. */
  emits?: string[];
  /** true when the method mutates state (informs caching/audit). */
  mutates?: boolean;
}

export interface CapabilityEventSpec {
  name: string;
  description?: string;
  payload?: Record<string, SchemaShape>;
}

export interface CapabilityManifest {
  name: string;
  version: string;
  description?: string;
  methods: MethodSpec[];
  events?: CapabilityEventSpec[];
  /** configuration schema (non-secret). */
  config?: Record<string, SchemaShape>;
  /** names of secrets this capability may read. */
  secrets?: string[];
}

/* ------------------------------------------------------------------ */
/* Runtime-provided context (implemented by @fabric/runtime)           */
/* ------------------------------------------------------------------ */

export interface UserIdentity {
  id: string;
  roles: string[];
  email?: string;
  displayName?: string;
}

export interface AppIdentity {
  /** app id. */
  id: string;
  /** immutable per-installation instance id (data isolation boundary). */
  instanceId: string;
  workspaceId: string;
  version: string;
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface SecretReader {
  get(name: string): string | undefined;
}

/**
 * Everything a capability may use while serving one call. The runtime builds a
 * fresh, scoped context per invocation — capabilities never reach for globals.
 */
export interface CapabilityContext {
  app: AppIdentity;
  user: UserIdentity;
  logger: Logger;
  secrets: SecretReader;
  /** emit a capability-level event onto the runtime bus. */
  emit(event: string, payload: unknown): void | Promise<void>;
  /** cooperative cancellation. */
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ */
/* The capability itself                                               */
/* ------------------------------------------------------------------ */

export interface Capability {
  readonly manifest: CapabilityManifest;
  invoke(method: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<unknown>;
  /** optional lifecycle for pooled resources. */
  dispose?(): Promise<void>;
}

/**
 * A factory produces per-instance capability objects from resolved config.
 * The registry stores factories; the runtime creates instances lazily and
 * scopes them to an app installation.
 */
export interface CapabilityFactory {
  readonly manifest: CapabilityManifest;
  create(config: Record<string, unknown>, env: FactoryEnv): Capability;
}

/** Infra handles a factory may need (provided by the runtime host). */
export interface FactoryEnv {
  /** stable namespace for this app installation's data. */
  namespace: string;
  logger: Logger;
  secrets: SecretReader;
}

/** Helper base for building capabilities with a method map. */
export abstract class BaseCapability implements Capability {
  abstract readonly manifest: CapabilityManifest;
  protected abstract handlers: Record<
    string,
    (args: any, ctx: CapabilityContext) => Promise<unknown>
  >;

  async invoke(method: string, args: Record<string, unknown>, ctx: CapabilityContext) {
    const h = this.handlers[method];
    if (!h) throw new CapabilityError("method_not_found", `${this.manifest.name}.${method} not found`);
    return h(args, ctx);
  }
}

export class CapabilityError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CapabilityError";
  }
}

import type {
  AppDocument,
  CapabilityRef,
  Query,
  Expr,
} from "@fabric/ir";
import type {
  Capability,
  CapabilityContext,
  UserIdentity,
} from "@fabric/capabilities";
import { CapabilityError } from "@fabric/capabilities";
import { CapabilityRegistry } from "@fabric/registry";
import { EventBus } from "@fabric/events";
import { PermissionEngine, type Principal, type Operation } from "@fabric/permissions";
import { ConnectionManager } from "@fabric/connections";
import { VersionStore } from "@fabric/versioning";
import { validateApp, validateWorkspace, type Diagnostic } from "@fabric/validator";
import {
  runAction,
  resolveView,
  evaluate,
  findSubmitSite,
  collectFields,
  coerceFormValues,
  resolveSubmitArgs,
  type ExecutionHost,
  type RenderNode,
} from "@fabric/interpreter";
import type { CodeUnitRunner } from "@fabric/code-units";
import { SecretVault } from "./secrets.ts";
import { LogSink } from "./logger.ts";

/**
 * The Runtime — the operating system for AI-generated software.
 *
 * It owns every piece of infrastructure so that applications never do. An
 * application is installed as an IR document; from that moment it has storage,
 * permissions, events, connections, scheduling, secrets, and logging with zero
 * configuration. The Runtime is the trust boundary: every capability call and
 * data access is authorized here, so an app physically cannot exceed its
 * declared powers.
 */

export interface InstallOptions {
  workspaceId: string;
  /** Stable host-provided installation identity for durable storage namespaces. */
  instanceId?: string;
  secrets?: Record<string, string>;
  author?: string;
  message?: string;
}

interface Installed {
  doc: AppDocument;
  workspaceId: string;
  instanceId: string;
  version: string;
  capabilities: Map<string, Capability>; // alias -> instance
  aliasToCap: Map<string, string>; // alias -> capability name
  permissions: PermissionEngine;
}

export interface RuntimeOptions {
  echoLogs?: boolean;
  connectEvents?: boolean;
  codeUnitRunner?: CodeUnitRunner;
  codeRoot?: string;
}

let instanceSeq = 0;

export class Runtime {
  readonly registry = new CapabilityRegistry();
  readonly bus = new EventBus();
  readonly versions = new VersionStore();
  readonly logs: LogSink;
  private secrets = new SecretVault();
  private apps = new Map<string, Installed>();
  private connections: ConnectionManager;
  private codeUnitRunner?: CodeUnitRunner;
  private codeRoot: string;
  private connectEvents: boolean;

  constructor(opts: RuntimeOptions = {}) {
    this.logs = new LogSink(opts.echoLogs ?? false);
    this.connectEvents = opts.connectEvents ?? true;
    this.connections = new ConnectionManager(this.bus, (appId, action, params) =>
      // Connections run as the app's system principal (owner authority).
      this.invokeAction(appId, action, params, { id: "system", roles: ["owner"] }),
    );
    this.codeUnitRunner = opts.codeUnitRunner;
    this.codeRoot = opts.codeRoot ?? process.cwd();
  }

  /** Install (or upgrade) an app. Validates, versions, wires everything. */
  install(doc: AppDocument, opts: InstallOptions): Installed {
    const manifests = this.registry.manifests().map((m) => ({
      name: m.name,
      methods: m.methods.map((x) => ({ name: x.name, ...(x.permission ? { permission: x.permission } : {}) })),
    }));
    const result = validateApp(doc, { capabilities: manifests });
    if (!result.ok) {
      const errs = result.diagnostics.filter((d) => d.level === "error");
      throw new Error(`app "${doc.id}" failed validation:\n` + errs.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"));
    }

    const prev = this.apps.get(doc.id);
    const instanceId = prev?.instanceId ?? opts.instanceId ?? `inst_${++instanceSeq}`;
    for (const [name, value] of Object.entries(opts.secrets ?? {})) this.secrets.set(instanceId, name, value);

    const version = this.versions.commit({
      appId: doc.id,
      doc,
      ...(prev ? { parent: prev.version } : {}),
      author: opts.author ?? "ai",
      message: opts.message ?? (prev ? "edit" : "created"),
    });

    const capabilities = new Map<string, Capability>();
    const aliasToCap = new Map<string, string>();
    const secretScope = { secrets: this.secrets.asScope(instanceId) };
    for (const ref of doc.capabilities) {
      const alias = ref.as ?? ref.capability;
      aliasToCap.set(alias, ref.capability);
      const factory = this.registry.resolve(ref.capability, ref.version);
      const config = evalConfig(ref, secretScope);
      const cap = factory.create(config, {
        namespace: `${opts.workspaceId}:${doc.id}:${instanceId}`,
        logger: this.logs.scoped(`${doc.id}/${ref.capability}`),
        secrets: this.secrets.reader(instanceId),
      });
      capabilities.set(alias, cap);
    }

    const installed: Installed = {
      doc,
      workspaceId: opts.workspaceId,
      instanceId,
      version: version.id,
      capabilities,
      aliasToCap,
      permissions: new PermissionEngine(doc.permissions),
    };
    this.apps.set(doc.id, installed);

    // Rewire connections for the whole workspace (idempotent for the demo).
    if (this.connectEvents) {
      this.connections.disconnectAll();
      for (const a of this.apps.values()) this.connections.connect(a.workspaceId, a.doc);
    }

    this.logs.scoped(doc.id).info(`installed ${doc.name} @ ${version.id}`);

    // Cross-app connections are checked AFTER install and never block it: the
    // apps of a workspace are edited one at a time, so a subscription may point
    // at an event whose source app has not been (re)installed yet. A dangling
    // or mis-mapped connection is a warning the user should see, not a reason to
    // refuse a valid document.
    for (const diag of this.workspaceDiagnostics(opts.workspaceId)) {
      this.logs.scoped(doc.id).warn(`[${diag.code}] ${diag.path}: ${diag.message}`);
    }
    return installed;
  }

  private require(appId: string): Installed {
    const a = this.apps.get(appId);
    if (!a) throw new Error(`app "${appId}" is not installed`);
    return a;
  }

  private userIdentity(app: Installed, p: Principal): UserIdentity {
    return { id: p.id, roles: p.roles };
  }

  private context(app: Installed, user: UserIdentity): CapabilityContext {
    return {
      app: { id: app.doc.id, instanceId: app.instanceId, workspaceId: app.workspaceId, version: app.version },
      user,
      logger: this.logs.scoped(app.doc.id),
      secrets: this.secrets.reader(app.instanceId),
      emit: (event, payload) =>
        void this.bus.publish({ source: `cap:${app.doc.id}`, name: event, payload, workspaceId: app.workspaceId }),
    };
  }

  /** Build the interpreter's host, enforcing permissions on every call. */
  private host(app: Installed, principal: Principal): ExecutionHost {
    const user = this.userIdentity(app, principal);
    const ctx = this.context(app, user);

    const enforceStorage = (method: string, args: Record<string, unknown>) => {
      const op = STORAGE_OP[method];
      if (!op) return;
      const model = String(args.model);
      const decision = app.permissions.canAccessModel(model, op, principal);
      if (!decision.allowed) {
        throw new CapabilityError("permission_denied", `${principal.id} cannot ${op} ${model}: ${decision.reason}`);
      }
    };

    return {
      call: async (alias, method, args) => {
        const cap = app.capabilities.get(alias);
        if (!cap) throw new CapabilityError("no_capability", `capability alias "${alias}" not found`);
        if (app.aliasToCap.get(alias) === "storage") enforceStorage(method, args);
        this.logs.scoped(app.doc.id).debug(`call ${alias}.${method}`, args);
        return cap.invoke(method, args, ctx);
      },
      code: async (name, input) => {
        const unit = app.doc.codeUnits?.find((candidate) => candidate.name === name);
        if (!unit) throw new Error(`code unit "${name}" is not declared by "${app.doc.id}"`);
        if (!this.codeUnitRunner) {
          throw new Error(`runtime has no code-unit runner; cannot execute "${name}"`);
        }
        this.logs.scoped(app.doc.id).info(`code ${name}`, { runtime: unit.runtime });
        return this.codeUnitRunner.run({
          unit,
          input,
          appId: app.doc.id,
          workspaceId: app.workspaceId,
          codeRoot: this.codeRoot,
        });
      },
      emit: async (event, payload) => {
        await this.bus.publish({ source: app.doc.id, name: event, payload, workspaceId: app.workspaceId });
      },
      query: async (q: Query) => this.runQuery(app, principal, q),
    };
  }

  /** Data read for view bindings: enforces read perms + row-level rules. */
  private async runQuery(app: Installed, principal: Principal, q: Query): Promise<Record<string, unknown>[]> {
    const decision = app.permissions.canAccessModel(q.model, "read", principal);
    if (!decision.allowed) throw new CapabilityError("permission_denied", `cannot read ${q.model}: ${decision.reason}`);
    const storageAlias = [...app.aliasToCap.entries()].find(([, c]) => c === "storage")?.[0];
    if (!storageAlias) throw new Error(`app "${app.doc.id}" has no storage capability`);
    const cap = app.capabilities.get(storageAlias)!;
    const user = this.userIdentity(app, principal);
    const rows = (await cap.invoke(
      "list",
      { model: q.model, where: q.where, sort: q.sort, limit: q.limit },
      this.context(app, user),
    )) as Record<string, unknown>[];
    if (!decision.where) return rows;
    // Row-level rule: keep rows for which the predicate holds.
    return rows.filter((row) => truthy(evaluate(decision.where as Expr, { user, row })));
  }

  /** Invoke an app action on behalf of a principal. The main entry point. */
  async invokeAction(
    appId: string,
    actionName: string,
    params: Record<string, unknown>,
    principal: Principal,
  ): Promise<unknown> {
    const app = this.require(appId);
    const action = app.doc.actions.find((a) => a.name === actionName);
    if (!action) throw new Error(`action "${actionName}" not found in "${appId}"`);

    const decision = app.permissions.canInvokeAction(actionName, principal, action.permission);
    if (!decision.allowed) {
      throw new CapabilityError("permission_denied", `${principal.id} cannot run ${actionName}: ${decision.reason}`);
    }

    const user = this.userIdentity(app, principal);
    const ambient = {
      user,
      app: { id: app.doc.id, name: app.doc.name },
      now: new Date().toISOString(),
    };
    this.logs.scoped(appId).info(`action ${actionName}`, params);
    const result = await runAction(action, { input: params, ambient }, this.host(app, principal));
    return result.returned;
  }

  /** Resolve a view into a renderer-agnostic tree (read-only render pass). */
  async renderView(appId: string, viewName: string, principal: Principal): Promise<RenderNode> {
    const app = this.require(appId);
    const view = app.doc.views.find((v) => v.name === viewName);
    if (!view) throw new Error(`view "${viewName}" not found in "${appId}"`);
    const user = this.userIdentity(app, principal);
    return resolveView(view, this.host(app, principal), { user, app: { id: appId, name: app.doc.name } });
  }

  /**
   * Render a view from an ARBITRARY document, without installing it.
   *
   * This is what makes time travel scrubbable. Restoring a version is already
   * cheap, but restoring commits: dragging a slider across forty versions would
   * write forty commits and leave head somewhere the user did not choose. So a
   * preview borrows the installed app's identity — same instance, therefore the
   * same storage namespace, therefore the user's real rows — and renders the
   * older document's views against it, touching neither `apps` nor `versions`.
   *
   * It is a read-only pass by construction: it resolves a view (queries only)
   * and never invokes an action, so a preview cannot mutate anything. The
   * previewed document's own permissions are enforced, not the installed one's,
   * because the question being answered is "what would this version show me?".
   */
  async previewView(
    appId: string,
    doc: AppDocument,
    viewName: string,
    principal: Principal,
  ): Promise<RenderNode> {
    const live = this.require(appId);
    const view = doc.views.find((v) => v.name === viewName);
    if (!view) throw new Error(`view "${viewName}" not found in version of "${appId}"`);

    const capabilities = new Map<string, Capability>();
    const aliasToCap = new Map<string, string>();
    const secretScope = { secrets: this.secrets.asScope(live.instanceId) };
    for (const ref of doc.capabilities) {
      const alias = ref.as ?? ref.capability;
      aliasToCap.set(alias, ref.capability);
      const factory = this.registry.resolve(ref.capability, ref.version);
      capabilities.set(
        alias,
        factory.create(evalConfig(ref, secretScope), {
          // Same namespace as the live app: a preview shows real data.
          namespace: `${live.workspaceId}:${appId}:${live.instanceId}`,
          logger: this.logs.scoped(`${appId}/${ref.capability}#preview`),
          secrets: this.secrets.reader(live.instanceId),
        }),
      );
    }

    const temp: Installed = {
      doc,
      workspaceId: live.workspaceId,
      instanceId: live.instanceId,
      version: live.version,
      capabilities,
      aliasToCap,
      permissions: new PermissionEngine(doc.permissions),
    };
    const user = this.userIdentity(temp, principal);
    return resolveView(view, this.host(temp, principal), { user, app: { id: appId, name: doc.name } });
  }

  /**
   * Submit a form: the write path from a rendered UI back into an application.
   *
   * SECURITY — why `form` is the only thing a caller may send:
   * The client posts raw field values and the *name* of the action it is
   * submitting. It never sends action arguments. This runtime looks the handler
   * up in the installed IR, drops any submitted key the document does not
   * declare as a `Field`, coerces the rest to the declared kinds, and evaluates
   * the handler's `args` Exprs itself under the scope { form, user, app, now }.
   * So a document that writes `submittedBy: { $: "user.id" }` or hard-codes
   * `status: "pending"` cannot be talked out of it by a crafted request — the
   * argument list is a property of the program, not of the input. Authorization
   * then happens exactly where every other call is authorized: `invokeAction`.
   *
   * Returns both the action result and a freshly resolved view, because a
   * submit is a round trip: the caller wants to know what happened *and* to
   * paint the new state without a second request.
   */
  async submit(
    appId: string,
    viewName: string,
    action: string,
    form: Record<string, unknown>,
    principal: Principal,
  ): Promise<{ result: unknown; view: RenderNode }> {
    const app = this.require(appId);
    const view = app.doc.views.find((v) => v.name === viewName);
    if (!view) throw new Error(`view "${viewName}" not found in "${appId}"`);

    const site = findSubmitSite(view, action);
    if (!site) {
      throw new Error(`view "${viewName}" declares no submit/click handler for action "${action}"`);
    }

    const declared = coerceFormValues(collectFields(site.node), form);
    const user = this.userIdentity(app, principal);
    const args = resolveSubmitArgs(site.handler, declared, {
      user,
      app: { id: app.doc.id, name: app.doc.name },
      now: new Date().toISOString(),
    });

    this.logs.scoped(appId).info(`submit ${viewName}/${action}`, args);
    const result = await this.invokeAction(appId, action, args, principal);
    const nextView = await this.renderView(appId, viewName, principal);
    return { result, view: nextView };
  }

  installed(appId: string): AppDocument | undefined {
    return this.apps.get(appId)?.doc;
  }

  /** Every installed document, for workspace-wide checks and tooling. */
  installedDocs(workspaceId?: string): AppDocument[] {
    return [...this.apps.values()]
      .filter((a) => workspaceId === undefined || a.workspaceId === workspaceId)
      .map((a) => a.doc);
  }

  /**
   * Cross-app connection diagnostics for a workspace: does every subscription's
   * `map` only read fields the source app actually declares in that event?
   * Non-fatal by construction — a workspace is edited one app at a time, so a
   * connection is legitimately dangling between two edits.
   */
  workspaceDiagnostics(workspaceId?: string): Diagnostic[] {
    return validateWorkspace(this.installedDocs(workspaceId)).diagnostics;
  }
}

const STORAGE_OP: Record<string, Operation> = {
  create: "create",
  update: "update",
  delete: "delete",
  get: "read",
  list: "read",
  count: "read",
};

function evalConfig(ref: CapabilityRef, scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ref.config ?? {})) out[k] = evaluate(v, scope);
  return out;
}

function truthy(v: unknown): boolean {
  return !(v === false || v == null || v === 0 || v === "");
}

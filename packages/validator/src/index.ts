import type {
  AppDocument,
  Action,
  Step,
  Expr,
  Node,
  CapabilityRef,
} from "@fabric/ir";
import { isExprNode, isNodeType, IR_SPEC_VERSION, FIELD_KINDS } from "@fabric/ir";

/**
 * The validator is the platform's immune system.
 *
 * WHY it is a hard gate: the AI proposes edits, users write prompts, and
 * capabilities evolve. The only guarantee that keeps a running app from
 * corruption is that NO document reaches the interpreter unless it is
 * internally consistent. Validation is therefore a pure function
 * (AppDocument, CapabilityManifest[]) -> Diagnostic[] with zero side effects,
 * so it can run in the studio (before save), the server (before render), and
 * CI (before publish).
 */

export interface Diagnostic {
  level: "error" | "warning";
  code: string;
  message: string;
  path: string;
}

export interface MethodSignature {
  name: string;
  permission?: string;
}

/** What the validator needs to know about an installed capability. */
export interface CapabilityManifestLite {
  name: string;
  methods: MethodSignature[];
}

export interface ValidateOptions {
  /** manifests of capabilities available in the target runtime. */
  capabilities?: CapabilityManifestLite[];
}

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export function validateApp(doc: AppDocument, opts: ValidateOptions = {}): ValidationResult {
  const d: Diagnostic[] = [];
  const err = (code: string, message: string, path: string) =>
    d.push({ level: "error", code, message, path });
  const warn = (code: string, message: string, path: string) =>
    d.push({ level: "warning", code, message, path });

  if (doc.spec !== IR_SPEC_VERSION) {
    warn("spec.version", `document spec ${doc.spec} != runtime ${IR_SPEC_VERSION}`, "spec");
  }
  if (!doc.id) err("app.id", "app id is required", "id");
  if (!doc.name) err("app.name", "app name is required", "name");

  const manifests = new Map((opts.capabilities ?? []).map((c) => [c.name, c]));
  const aliasToCap = new Map<string, string>();
  doc.capabilities.forEach((c: CapabilityRef, i) => {
    const alias = c.as ?? c.capability;
    if (aliasToCap.has(alias)) err("cap.alias", `duplicate capability alias "${alias}"`, `capabilities.${i}`);
    aliasToCap.set(alias, c.capability);
    if (manifests.size > 0 && !manifests.has(c.capability)) {
      err("cap.unknown", `capability "${c.capability}" is not installed`, `capabilities.${i}`);
    }
  });

  const modelNames = new Set(doc.models.map((m) => m.name));
  doc.models.forEach((m, i) => {
    m.fields.forEach((f, j) => {
      if (f.type === "ref" && (!f.ref || !modelNames.has(f.ref))) {
        err("model.ref", `field "${f.name}" references unknown model "${f.ref}"`, `models.${i}.fields.${j}`);
      }
      if (f.type === "enum" && (!f.enum || f.enum.length === 0)) {
        err("model.enum", `enum field "${f.name}" needs values`, `models.${i}.fields.${j}`);
      }
    });
  });

  const actionNames = new Set(doc.actions.map((a) => a.name));
  const eventNames = new Set(doc.events.map((e) => e.name));
  const codeUnitNames = new Set<string>();
  const codeUnits = new Map((doc.codeUnits ?? []).map((unit) => [unit.name, unit]));
  doc.codeUnits?.forEach((unit, i) => {
    const path = `codeUnits.${i}`;
    if (codeUnitNames.has(unit.name)) err("code.duplicate", `duplicate code unit "${unit.name}"`, path);
    codeUnitNames.add(unit.name);
    if (!/^sha256:[a-f0-9]{64}$/.test(unit.digest)) {
      err("code.digest", `code unit "${unit.name}" needs a sha256 content pin`, `${path}.digest`);
    }
    if (!unit.entry || unit.entry.startsWith("/") || unit.entry.split(/[\\/]/).includes("..")) {
      err("code.entry", `code unit entry must be a relative path inside the code root`, `${path}.entry`);
    }
  });

  doc.actions.forEach((a, i) => validateAction(a, `actions.${i}`));

  doc.subscriptions.forEach((s, i) => {
    if (!actionNames.has(s.run)) {
      err("sub.action", `subscription runs unknown action "${s.run}"`, `subscriptions.${i}`);
    }
    // "<app>.<event>" cross-app refs are validated at connection-bind time.
  });

  doc.views.forEach((v, i) => validateNode(v.root, `views.${i}.root`, false));

  doc.schedules?.forEach((s, i) => {
    if (!actionNames.has(s.run)) err("schedule.action", `schedule runs unknown action "${s.run}"`, `schedules.${i}`);
  });

  Object.entries(doc.permissions.actions ?? {}).forEach(([action, roles]) => {
    if (!actionNames.has(action)) warn("perm.action", `permission for unknown action "${action}"`, `permissions.actions.${action}`);
    roles.forEach((r) => {
      if (!doc.permissions.roles.includes(r)) err("perm.role", `unknown role "${r}"`, `permissions.actions.${action}`);
    });
  });

  return { ok: !d.some((x) => x.level === "error"), diagnostics: d };

  function validateAction(a: Action, path: string) {
    const seen = new Set<string>();
    a.steps.forEach((s, i) => validateStep(s, `${path}.steps.${i}`, seen));
  }

  function validateStep(s: Step, path: string, seen: Set<string>) {
    switch (s.kind) {
      case "call": {
        const [alias, method] = s.call.split(".");
        if (!alias || !method) {
          err("step.call.format", `call "${s.call}" must be "<capability>.<method>"`, path);
          break;
        }
        const cap = aliasToCap.get(alias);
        if (!cap) {
          err("step.call.alias", `call uses undeclared capability alias "${alias}"`, path);
        } else if (manifests.size > 0) {
          const mani = manifests.get(cap);
          if (mani && !mani.methods.some((m) => m.name === method)) {
            err("step.call.method", `capability "${cap}" has no method "${method}"`, path);
          }
        }
        if (s.id) seen.add(s.id);
        break;
      }
      case "code":
        if (!codeUnitNames.has(s.unit)) {
          err("step.code.unit", `code step uses undeclared unit "${s.unit}"`, path);
        } else {
          const unit = codeUnits.get(s.unit)!;
          const supplied = new Set(Object.keys(s.input ?? {}));
          for (const input of unit.input ?? []) {
            if (input.required && !supplied.has(input.name)) {
              err("step.code.input", `code unit "${s.unit}" needs input "${input.name}"`, path);
            }
          }
          for (const key of supplied) {
            if (unit.input && !unit.input.some((input) => input.name === key)) {
              warn("step.code.input", `code unit "${s.unit}" does not declare input "${key}"`, path);
            }
          }
        }
        if (s.id) seen.add(s.id);
        break;
      case "emit":
        if (!eventNames.has(s.event)) err("step.emit", `emits undeclared event "${s.event}"`, path);
        break;
      case "let":
        seen.add(s.id);
        break;
      case "if":
        s.then.forEach((c, i) => validateStep(c, `${path}.then.${i}`, seen));
        s.else?.forEach((c, i) => validateStep(c, `${path}.else.${i}`, seen));
        break;
      case "forEach":
        s.do.forEach((c, i) => validateStep(c, `${path}.do.${i}`, seen));
        break;
      case "return":
        break;
      default:
        err("step.kind", `unknown step kind`, path);
    }
  }

  function validateNode(n: Node, path: string, insideForm: boolean) {
    if (!n.type) err("node.type", "node missing type", path);
    else if (!isNodeType(n.type)) {
      warn("node.unknownType", `unknown node type "${n.type}" — renderers will fall back`, path);
    }
    if (n.bind && !modelNames.has(n.bind.query.model)) {
      err("node.bind", `binds unknown model "${n.bind.query.model}"`, `${path}.bind`);
    }
    Object.entries(n.on ?? {}).forEach(([ev, h]) => {
      if (!actionNames.has(h.action)) {
        err("node.handler", `handler "${ev}" calls unknown action "${h.action}"`, `${path}.on.${ev}`);
      }
    });

    // A Form is the only way data enters an app, so its wiring is checked hard:
    // a form the user can fill but not submit is a dead end, and a submit that
    // names a missing action is an error the AI must not be able to ship.
    if (n.type === "Form") {
      const submit = n.on?.submit;
      if (!submit) {
        err("form.submit", `Form needs an "on.submit" handler naming the action it runs`, path);
      } else if (!actionNames.has(submit.action)) {
        err("form.action", `Form submits to unknown action "${submit.action}"`, `${path}.on.submit`);
      }
      if (collectFieldNodes(n).length === 0) {
        warn("form.fields", `Form has no Field children — nothing to submit`, path);
      }
    }

    if (n.type === "Field") validateField(n, path, insideForm);

    n.children?.forEach((c, i) =>
      validateNode(c, `${path}.children.${i}`, insideForm || n.type === "Form"),
    );
  }

  function validateField(n: Node, path: string, insideForm: boolean) {
    const name = n.props?.name;
    if (typeof name !== "string" || name === "") {
      err("field.name", `Field needs a literal "name" prop (it keys the submitted value)`, path);
    }
    const kind = n.props?.kind;
    if (typeof kind !== "string" || !(FIELD_KINDS as readonly string[]).includes(kind)) {
      err("field.kind", `Field "kind" must be one of ${FIELD_KINDS.join(" | ")}`, path);
    } else if (kind === "select") {
      const options = n.props?.options;
      if (!Array.isArray(options) || options.length === 0) {
        err("field.options", `Field kind "select" needs a non-empty "options" array`, path);
      }
    }
    if (!insideForm) {
      warn("field.orphan", `Field is not inside a Form — it will never be submitted`, path);
    }
  }
}

function collectFieldNodes(n: Node): Node[] {
  const out: Node[] = [];
  visit(n);
  return out;
  function visit(x: Node) {
    if (x.type === "Field") out.push(x);
    x.children?.forEach(visit);
  }
}

/* ------------------------------------------------------------------ */
/* Workspace-level validation (cross-app connections)                  */
/* ------------------------------------------------------------------ */

export interface ValidateWorkspaceOptions {
  /**
   * Treat a subscription whose source app is absent from `docs` as a problem.
   * Default false: a workspace is legitimately partial (the source app may live
   * in another workspace, or simply not be installed yet).
   */
  requireKnownSources?: boolean;
  /** Level for cross-app findings. Default "warning" — never break an install. */
  level?: "error" | "warning";
}

/**
 * Validate a *set* of apps together.
 *
 * WHY this cannot live in validateApp: a subscription is the one part of a
 * document that talks about something outside it. `on: "expense-tracker.
 * expenseApproved"` with `map: { memo: {$: "event.description"} }` is only
 * meaningful next to the *source* app's declared event payload. Checking it
 * pairwise is what turns "connect like Lego" from hope into a guarantee: the
 * moment a source app stops declaring a field, every consumer that reads it is
 * named, with the field, before anything silently receives `undefined`.
 *
 * Deliberately non-fatal: apps are edited one at a time, so a connection is
 * expected to dangle briefly. The runtime surfaces these through logs.
 */
export function validateWorkspace(
  docs: AppDocument[],
  opts: ValidateWorkspaceOptions = {},
): ValidationResult {
  const level = opts.level ?? "warning";
  const d: Diagnostic[] = [];
  const add = (code: string, message: string, path: string) => d.push({ level, code, message, path });
  const byId = new Map(docs.map((doc) => [doc.id, doc]));

  for (const doc of docs) {
    doc.subscriptions.forEach((sub, i) => {
      const path = `${doc.id}.subscriptions.${i}`;
      const dot = sub.on.indexOf(".");
      const sourceId = dot >= 0 ? sub.on.slice(0, dot) : doc.id;
      const eventName = dot >= 0 ? sub.on.slice(dot + 1) : sub.on;

      const source = byId.get(sourceId);
      if (!source) {
        if (opts.requireKnownSources) {
          add("conn.source", `${doc.id} subscribes to unknown app "${sourceId}"`, path);
        }
        return;
      }

      const event = source.events.find((e) => e.name === eventName);
      if (!event) {
        add(
          "conn.event",
          `${doc.id} subscribes to "${eventName}" which ${sourceId} does not declare as an event`,
          path,
        );
        return;
      }

      const declared = new Set((event.payload ?? []).map((f) => f.name));
      const action = doc.actions.find((a) => a.name === sub.run);

      for (const [param, expr] of Object.entries(sub.map ?? {})) {
        if (action && !action.params.some((p) => p.name === param)) {
          add(
            "conn.param",
            `${doc.id} maps onto "${param}" which action "${sub.run}" does not declare as a param`,
            `${path}.map.${param}`,
          );
        }
        for (const field of eventFieldsRead(expr)) {
          if (!declared.has(field)) {
            add(
              "conn.map",
              `${doc.id} expects \`${field}\` which ${sourceId}'s \`${eventName}\` does not declare` +
                (declared.size ? ` (declares: ${[...declared].join(", ")})` : ` (declares nothing)`),
              `${path}.map.${param}`,
            );
          }
        }
      }
    });
  }

  return { ok: !d.some((x) => x.level === "error"), diagnostics: d };
}

/** Every `event.<field>` path an expression reads, at any depth. */
function eventFieldsRead(e: Expr): string[] {
  const out = new Set<string>();
  walk(e);
  return [...out];
  function walk(x: Expr) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isExprNode(x)) return Object.values(x).forEach((v) => walk(v as Expr));
    if ("$" in x) {
      const segs = x.$.split(".");
      if (segs[0] === "event" && segs[1]) out.add(segs[1]);
      return;
    }
    if ("$op" in x) return x.args.forEach(walk);
    if ("$fn" in x) return (x.args ?? []).forEach(walk);
    if ("$if" in x) return x.$if.forEach(walk);
    if ("$obj" in x) return Object.values(x.$obj).forEach(walk);
  }
}

/**
 * Structural well-formedness check for a raw expression tree. Used by tools
 * that construct Exprs (e.g. the AI) before they are embedded in a document.
 */
export function validateExpr(e: Expr, path = "expr"): Diagnostic[] {
  const out: Diagnostic[] = [];
  walk(e, path);
  return out;
  function walk(x: Expr, p: string) {
    if (x === null || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach((el, i) => walk(el, `${p}.${i}`));
    if (!isExprNode(x)) {
      Object.entries(x).forEach(([k, v]) => walk(v as Expr, `${p}.${k}`));
      return;
    }
    if ("$op" in x) x.args.forEach((a, i) => walk(a, `${p}.args.${i}`));
    else if ("$fn" in x) (x.args ?? []).forEach((a, i) => walk(a, `${p}.args.${i}`));
    else if ("$if" in x) x.$if.forEach((a, i) => walk(a, `${p}.$if.${i}`));
    else if ("$obj" in x) Object.entries(x.$obj).forEach(([k, v]) => walk(v, `${p}.${k}`));
  }
}

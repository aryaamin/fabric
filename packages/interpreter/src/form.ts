import type { View, Node, Handler, FieldKind } from "@fabric/ir";
import { evaluate, type Scope } from "./evaluate.ts";

/**
 * The `$form` scope — how user input enters an application.
 *
 * A view's `Form` node declares `Field`s and a `submit` handler. The handler's
 * `args` are Exprs written against the `form` scope namespace, e.g.
 *
 *   on: { submit: { action: "submitExpense",
 *                   args: { amount: { $: "form.amount" } } } }
 *
 * WHY the arguments live in the IR and not in the request:
 * A submission carries only *raw field values*. The mapping from those values
 * onto an action's parameters is part of the document, so it is evaluated
 * server-side, from the installed IR, at submit time. A client therefore cannot
 * invent an argument the document never declared (e.g. `status: "approved"` or
 * `submittedBy: "someone-else"`). The form is untrusted data; the IR is the
 * trusted program. Keeping those two apart is what makes a browser-rendered
 * form as safe as a server-rendered one.
 *
 * This module is pure: it finds handlers, shapes the `$form` scope, and
 * evaluates argument Exprs. Authorization and side effects belong to the
 * runtime.
 */

/** A `Field` node reduced to the literal facts a submit needs. */
export interface FieldSpec {
  name: string;
  kind: FieldKind;
  label?: string;
  required?: boolean;
  options?: string[];
}

/** A handler found in a view, together with the node that declared it. */
export interface HandlerSite {
  node: Node;
  event: string;
  handler: Handler;
}

/**
 * Locate a handler in a view by event name and target action.
 *
 * The runtime needs this to evaluate a submit's `args` from the document rather
 * than from the request, so it must be able to find the handler a client only
 * names ("submitExpense") inside the node tree.
 */
export function findHandler(view: View, event: string, action: string): Handler | undefined {
  return findHandlerSite(view, event, action)?.handler;
}

/** Same lookup as {@link findHandler}, but keeps the declaring node. */
export function findHandlerSite(view: View, event: string, action: string): HandlerSite | undefined {
  return walk(view.root);

  function walk(node: Node): HandlerSite | undefined {
    const handler = node.on?.[event];
    if (handler && handler.action === action) return { node, event, handler };
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return undefined;
  }
}

/**
 * Find a submittable handler for `action` anywhere in the view: a `Form`'s
 * `submit` first, then a `Button`'s `click`. Both are "the user asked to run
 * this action with these declared arguments".
 */
export function findSubmitSite(view: View, action: string): HandlerSite | undefined {
  return findHandlerSite(view, "submit", action) ?? findHandlerSite(view, "click", action);
}

/** Collect the `Field` declarations inside a node's subtree, in order. */
export function collectFields(node: Node): FieldSpec[] {
  const out: FieldSpec[] = [];
  visit(node);
  return out;

  function visit(n: Node) {
    if (n.type === "Field") {
      const spec = fieldSpec(n);
      if (spec) out.push(spec);
    }
    n.children?.forEach(visit);
  }
}

function fieldSpec(n: Node): FieldSpec | undefined {
  const name = literalString(n.props?.name);
  if (!name) return undefined;
  const kind = (literalString(n.props?.kind) ?? "text") as FieldKind;
  const label = literalString(n.props?.label);
  const options = Array.isArray(n.props?.options)
    ? (n.props!.options as unknown[]).filter((o): o is string => typeof o === "string")
    : undefined;
  return {
    name,
    kind,
    ...(label ? { label } : {}),
    ...(n.props?.required === true ? { required: true } : {}),
    ...(options ? { options } : {}),
  };
}

function literalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Coerce raw submitted values (HTML forms deliver everything as strings) into
 * the types the declared fields imply. Unknown keys are dropped: a submission
 * may only speak about fields the document declares.
 */
export function coerceFormValues(
  fields: FieldSpec[],
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.name];
    if (v === undefined) continue;
    out[f.name] = coerce(v, f.kind);
  }
  return out;
}

function coerce(v: unknown, kind: FieldKind): unknown {
  if (kind !== "number") return v;
  if (typeof v === "number") return v;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Evaluate a handler's declared `args` against the `$form` scope.
 *
 * `ambient` supplies `user`, `app` and `now`, mirroring action invocation, so a
 * form can write `{ $: "user.id" }` or `{ $fn: "now" }` alongside `form.*`.
 * A handler with no `args` passes the coerced form values through unchanged,
 * which keeps the common "field names == param names" case free of ceremony.
 */
export function resolveSubmitArgs(
  handler: Handler,
  form: Record<string, unknown>,
  ambient: Scope = {},
): Record<string, unknown> {
  if (!handler.args) return { ...form };
  const scope: Scope = { ...ambient, form };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(handler.args)) out[k] = evaluate(v, scope);
  return out;
}

import type { Expr, OpName, FnName } from "@fabric/ir";
import { isExprNode } from "@fabric/ir";

/**
 * The expression evaluator: a small, total, side-effect-free interpreter for
 * the Fabric expression AST.
 *
 * WHY total & pure: expressions run on every render and every step, driven by
 * AI- and user-authored documents. It must be impossible for an expression to
 * loop forever, throw obscure errors, or reach outside its scope. There is no
 * `eval`, no host functions beyond a fixed allow-list, and no recursion in the
 * language itself — only structural recursion over a finite tree.
 */

export type Scope = Record<string, unknown>;

export function evaluate(expr: Expr, scope: Scope): unknown {
  if (expr === null || typeof expr !== "object") return expr; // literal
  if (Array.isArray(expr)) return expr.map((e) => evaluate(e, scope));

  if (!isExprNode(expr)) {
    // plain object literal -> object of evaluated values
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(expr)) out[k] = evaluate(v as Expr, scope);
    return out;
  }

  if ("$" in expr) return getPath(scope, expr.$);
  if ("$obj" in expr) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(expr.$obj)) out[k] = evaluate(v, scope);
    return out;
  }
  if ("$if" in expr) {
    const [c, t, f] = expr.$if;
    return truthy(evaluate(c, scope)) ? evaluate(t, scope) : evaluate(f, scope);
  }
  if ("$op" in expr) return applyOp(expr.$op, expr.args.map((a) => evaluate(a, scope)));
  if ("$fn" in expr) return applyFn(expr.$fn, (expr.args ?? []).map((a) => evaluate(a, scope)));
  return undefined;
}

export function getPath(scope: Scope, path: string): unknown {
  let node: unknown = scope;
  for (const seg of path.split(".")) {
    if (node == null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

function truthy(v: unknown): boolean {
  return !(v === false || v == null || v === 0 || v === "");
}

function applyOp(op: OpName, a: unknown[]): unknown {
  const n = (x: unknown) => Number(x);
  switch (op) {
    case "+": return a.reduce<number>((s, x) => s + n(x), 0);
    case "-": return a.length === 1 ? -n(a[0]) : n(a[0]) - n(a[1]);
    case "*": return a.reduce<number>((s, x) => s * n(x), 1);
    case "/": return n(a[0]) / n(a[1]);
    case "%": return n(a[0]) % n(a[1]);
    case "==": return a[0] === a[1];
    case "!=": return a[0] !== a[1];
    case ">": return n(a[0]) > n(a[1]);
    case ">=": return n(a[0]) >= n(a[1]);
    case "<": return n(a[0]) < n(a[1]);
    case "<=": return n(a[0]) <= n(a[1]);
    case "and": return a.every(truthy);
    case "or": return a.some(truthy);
    case "not": return !truthy(a[0]);
    case "has": return Array.isArray(a[0]) ? a[0].includes(a[1]) : false;
    case "concat": return a.map((x) => (x == null ? "" : String(x))).join("");
    default: return undefined;
  }
}

function applyFn(fn: FnName, a: unknown[]): unknown {
  switch (fn) {
    case "now": return new Date().toISOString();
    case "uuid": return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    case "len": return Array.isArray(a[0]) ? a[0].length : String(a[0] ?? "").length;
    case "sum": return Array.isArray(a[0]) ? a[0].reduce<number>((s, x) => s + Number(x), 0) : 0;
    case "upper": return String(a[0] ?? "").toUpperCase();
    case "lower": return String(a[0] ?? "").toLowerCase();
    case "coalesce": return a.find((x) => x != null);
    case "get": return getPath((a[0] ?? {}) as Scope, String(a[1] ?? ""));
    // pluck(rows, field) — the one collection primitive dashboards need: it
    // turns a bound query result into the array of numbers/strings that `sum`
    // and `len` consume, so a metric like "total pending" stays a pure
    // expression instead of requiring an action.
    case "pluck":
      return Array.isArray(a[0])
        ? a[0].map((row) => (row == null ? undefined : (row as Record<string, unknown>)[String(a[1] ?? "")]))
        : [];
    case "formatDate": {
      const d = new Date(String(a[0]));
      return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    default: return undefined;
  }
}

/**
 * The Fabric expression model.
 *
 * WHY a data expression model instead of embedded code:
 * The IR must be diffable, validatable, sandboxed, and portable across
 * interpreter and (future) compiler. Arbitrary code (JS strings, `eval`)
 * would break all four. So logic is expressed as a small, total, JSON AST.
 *
 * Disambiguation rule (elegance over cleverness):
 *   - primitive JSON (string | number | boolean | null) => literal value
 *   - array                                             => array literal of Exprs
 *   - object with a reserved `$*` key                   => an expression node
 *   - any other object                                  => object literal of Exprs
 *
 * Reserved keys are the ONLY magic. Plain strings are never re-parsed, which
 * keeps evaluation predictable and injection-free.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type Expr =
  | string
  | number
  | boolean
  | null
  | Expr[]
  | RefExpr
  | OpExpr
  | FnExpr
  | CondExpr
  | ObjectExpr
  | TreeExpr;

/** `{ $: "input.amount" }` — read a value from the evaluation scope. */
export interface RefExpr {
  $: string;
}

/** `{ $op: "+", args: [a, b] }` — a pure operator. */
export interface OpExpr {
  $op: OpName;
  args: Expr[];
}

/** `{ $fn: "now", args: [] }` — a pure built-in function. */
export interface FnExpr {
  $fn: FnName;
  args?: Expr[];
}

/** `{ $if: [cond, then, else] }` — total conditional. */
export interface CondExpr {
  $if: [Expr, Expr, Expr];
}

/** `{ $obj: { key: Expr } }` — explicit object literal (rarely needed). */
export interface ObjectExpr {
  $obj: Record<string, Expr>;
}

/**
 * `{ status: "pending", amount: { $: "input.amount" } }` — a plain object whose
 * values are expressions, evaluated key by key.
 *
 * This is the fourth line of the disambiguation rule above, expressed in the
 * type system rather than only in the evaluator. It is what lets a document
 * write `data: { amount: ref("input.amount"), status: "pending" }` directly
 * instead of wrapping every record in `$obj`, which is how nearly every real
 * action and query is authored. `$obj` remains available for the rare case where
 * a key would otherwise collide with a reserved `$*` name.
 */
export interface TreeExpr {
  [key: string]: Expr;
}

export type OpName =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "and"
  | "or"
  | "not"
  | "has"
  | "concat";

export type FnName =
  | "now"
  | "uuid"
  | "len"
  | "sum"
  | "upper"
  | "lower"
  | "coalesce"
  | "get"
  | "pluck"
  | "formatDate";

export const RESERVED_EXPR_KEYS = ["$", "$op", "$fn", "$if", "$obj"] as const;

export function isExprNode(v: unknown): v is RefExpr | OpExpr | FnExpr | CondExpr | ObjectExpr {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.some((k) => (RESERVED_EXPR_KEYS as readonly string[]).includes(k));
}

/** Sugar for authoring: `ref("input.amount")`. */
export const ref = (path: string): RefExpr => ({ $: path });
export const op = (o: OpName, ...args: Expr[]): OpExpr => ({ $op: o, args });
export const fn = (f: FnName, ...args: Expr[]): FnExpr => ({ $fn: f, args });

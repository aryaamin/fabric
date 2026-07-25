import type { PermissionsSpec, Expr, Rule } from "@fabric/ir";

/**
 * The Permission Engine.
 *
 * WHY it is a pure decision function, separate from enforcement: authorization
 * must be testable in isolation and reusable at three layers — action
 * invocation, direct model CRUD from views, and (via row rules) query
 * filtering. The engine answers "is this allowed?"; the runtime *enforces* by
 * refusing to call capabilities. Row-level rules return an Expr that the
 * runtime hands to the interpreter, so this package never evaluates logic and
 * stays dependency-free.
 *
 * The model is deliberately simple (roles + optional row predicate) because
 * the target user is a non-programmer describing intent in words
 * ("only managers approve", "finance can only view"). Every phrase must map to
 * one obvious rule.
 */

export interface Principal {
  id: string;
  roles: string[];
}

export type Operation = "read" | "create" | "update" | "delete";

export interface Decision {
  allowed: boolean;
  reason: string;
  /** row-level predicate to AND into queries/mutations, when present. */
  where?: Expr;
}

const OWNER = "owner";

export class PermissionEngine {
  private spec: PermissionsSpec;
  constructor(spec: PermissionsSpec) {
    this.spec = spec;
  }

  private defaultAllowed(): boolean {
    return this.spec.default === "allow";
  }

  private isOwner(p: Principal): boolean {
    return p.roles.includes(OWNER);
  }

  canInvokeAction(action: string, p: Principal, requiredKey?: string): Decision {
    if (this.isOwner(p)) return { allowed: true, reason: "owner" };
    const key = requiredKey ?? action;
    const allowedRoles = this.spec.actions?.[key];
    if (!allowedRoles) {
      return this.defaultAllowed()
        ? { allowed: true, reason: "default allow" }
        : { allowed: false, reason: `no policy for action "${action}"` };
    }
    const ok = allowedRoles.some((r) => p.roles.includes(r));
    return ok
      ? { allowed: true, reason: `role in [${allowedRoles.join(", ")}]` }
      : { allowed: false, reason: `requires one of [${allowedRoles.join(", ")}]` };
  }

  canAccessModel(model: string, op: Operation, p: Principal): Decision {
    if (this.isOwner(p)) return { allowed: true, reason: "owner" };
    const policy = this.spec.models?.[model]?.[op];
    if (policy === undefined) {
      return this.defaultAllowed()
        ? { allowed: true, reason: "default allow" }
        : { allowed: false, reason: `no ${op} policy for model "${model}"` };
    }
    if (Array.isArray(policy)) {
      const ok = policy.some((r) => p.roles.includes(r));
      return { allowed: ok, reason: ok ? "role match" : `requires [${policy.join(", ")}]` };
    }
    const rule = policy as Rule;
    const ok = rule.allow.some((r) => p.roles.includes(r));
    if (!ok) return { allowed: false, reason: `requires [${rule.allow.join(", ")}]` };
    return rule.where
      ? { allowed: true, reason: "role match + row rule", where: rule.where }
      : { allowed: true, reason: "role match" };
  }
}

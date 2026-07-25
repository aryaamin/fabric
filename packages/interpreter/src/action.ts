import type { Action, Step } from "@fabric/ir";
import { evaluate, type Scope } from "./evaluate.ts";
import type { ExecutionHost } from "./host.ts";

/**
 * The action executor.
 *
 * An action is a declarative list of steps over a scope. Steps produce named
 * results ($steps.<id>, $let.<id>) that later steps and the return expression
 * read. Capability calls go through the host, which has already authorized
 * them. Because steps are data, an action is fully inspectable, diffable, and
 * re-orderable by the AI — a property no imperative function body has.
 */

export interface ActionResult {
  returned: unknown;
  emitted: { event: string; payload: unknown }[];
  steps: Record<string, unknown>;
}

export interface ActionInvocation {
  input: Record<string, unknown>;
  /** ambient scope: $user, $app, $now, $event (for subscriptions). */
  ambient?: Scope;
}

export async function runAction(
  action: Action,
  invocation: ActionInvocation,
  host: ExecutionHost,
): Promise<ActionResult> {
  const scope: Scope = {
    input: invocation.input,
    steps: {},
    let: {},
    ...(invocation.ambient ?? {}),
  };
  const emitted: { event: string; payload: unknown }[] = [];
  const control = { returned: undefined as unknown, didReturn: false };

  await runSteps(action.steps, scope, host, emitted, control);

  const returned = control.didReturn
    ? control.returned
    : action.returns !== undefined
      ? evaluate(action.returns, scope)
      : undefined;

  return { returned, emitted, steps: scope.steps as Record<string, unknown> };
}

async function runSteps(
  steps: Step[],
  scope: Scope,
  host: ExecutionHost,
  emitted: { event: string; payload: unknown }[],
  control: { returned: unknown; didReturn: boolean },
): Promise<void> {
  for (const step of steps) {
    if (control.didReturn) return;
    await runStep(step, scope, host, emitted, control);
  }
}

async function runStep(
  step: Step,
  scope: Scope,
  host: ExecutionHost,
  emitted: { event: string; payload: unknown }[],
  control: { returned: unknown; didReturn: boolean },
): Promise<void> {
  switch (step.kind) {
    case "call": {
      const [alias, method] = step.call.split(".") as [string, string];
      const args = evalArgs(step.args, scope);
      const result = await host.call(alias, method, args);
      if (step.id) (scope.steps as Record<string, unknown>)[step.id] = result;
      break;
    }
    case "code": {
      const input = evalArgs(step.input, scope);
      const result = await host.code(step.unit, input);
      if (step.id) (scope.steps as Record<string, unknown>)[step.id] = result;
      break;
    }
    case "emit": {
      const payload = evalArgs(step.payload, scope);
      emitted.push({ event: step.event, payload });
      await host.emit(step.event, payload);
      break;
    }
    case "let": {
      (scope.let as Record<string, unknown>)[step.id] = evaluate(step.value, scope);
      break;
    }
    case "if": {
      const branch = truthy(evaluate(step.cond, scope)) ? step.then : (step.else ?? []);
      await runSteps(branch, scope, host, emitted, control);
      break;
    }
    case "forEach": {
      const items = evaluate(step.in, scope);
      if (Array.isArray(items)) {
        for (const item of items) {
          const child: Scope = { ...scope, [step.id]: item };
          await runSteps(step.do, child, host, emitted, control);
          if (control.didReturn) return;
        }
      }
      break;
    }
    case "return": {
      control.returned = evaluate(step.value, scope);
      control.didReturn = true;
      break;
    }
  }
}

function evalArgs(
  args: Record<string, import("@fabric/ir").Expr> | undefined,
  scope: Scope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = evaluate(v, scope);
  return out;
}

function truthy(v: unknown): boolean {
  return !(v === false || v == null || v === 0 || v === "");
}

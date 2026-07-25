import type { View, Node, Handler } from "@fabric/ir";
import { evaluate, type Scope } from "./evaluate.ts";
import type { ExecutionHost } from "./host.ts";

/**
 * The view resolver.
 *
 * It turns an abstract Node tree into a concrete RenderNode tree by evaluating
 * props against scope and executing data bindings through the host. The output
 * is renderer-agnostic: a React renderer, a static HTML renderer, or an
 * embeddable web component can all consume the same RenderNode tree. Handlers
 * are kept as un-evaluated intents (action + arg expressions) because their
 * arguments depend on runtime input (e.g. form values) resolved at fire time.
 */

export interface RenderNode {
  type: string;
  props: Record<string, unknown>;
  data?: Record<string, unknown>[];
  children: RenderNode[];
  handlers: Record<string, Handler>;
}

export async function resolveView(
  view: View,
  host: ExecutionHost,
  ambient: Scope = {},
): Promise<RenderNode> {
  return resolveNode(view.root, host, { ...ambient });
}

async function resolveNode(node: Node, host: ExecutionHost, scope: Scope): Promise<RenderNode> {
  let data: Record<string, unknown>[] | undefined;
  let childScope = scope;

  if (node.bind) {
    const q = node.bind.query;
    const where = q.where ? (evaluate(q.where, scope) as Record<string, unknown>) : undefined;
    data = await host.query({ ...q, ...(where ? { where: where as never } : {}) });
    childScope = { ...scope, [node.bind.as]: data };
  }

  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.props ?? {})) props[k] = evaluate(v, childScope);

  const children: RenderNode[] = [];
  for (const c of node.children ?? []) children.push(await resolveNode(c, host, childScope));

  return {
    type: node.type,
    props,
    ...(data ? { data } : {}),
    children,
    handlers: node.on ?? {},
  };
}

import type { Query } from "@fabric/ir";

/**
 * ExecutionHost — the interpreter's window onto the runtime.
 *
 * WHY invert the dependency: the interpreter must know nothing about
 * capabilities, permissions, or storage backends. The runtime implements this
 * narrow port and injects it. This keeps the interpreter a pure evaluator of
 * IR and makes it trivially testable with a fake host.
 */
export interface ExecutionHost {
  /** invoke a capability method already authorized by the runtime. */
  call(alias: string, method: string, args: Record<string, unknown>): Promise<unknown>;
  /** execute a named, content-pinned real-code unit. */
  code(unit: string, input: Record<string, unknown>): Promise<unknown>;
  /** emit one of the app's declared events. */
  emit(event: string, payload: unknown): Promise<void>;
  /** run a data query for a view binding (routes to the storage capability). */
  query(q: Query): Promise<Record<string, unknown>[]>;
}

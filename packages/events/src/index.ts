/**
 * The Event Bus.
 *
 * WHY events are the composition primitive (not function imports or REST):
 * apps must connect without knowing each other's internals or being online at
 * the same time. An event is a fact ("expenseApproved") published to the
 * workspace; any number of apps may react. This gives late binding, fan-out,
 * and durability (events can be persisted and replayed) — the qualities that
 * make "connect like Lego" possible.
 *
 * The in-process bus below is the reference implementation. In production it
 * is backed by a durable queue (at-least-once delivery); the interface is
 * identical, so no app or connection changes.
 */

export interface FabricEvent<T = unknown> {
  id: string;
  /** "<appId>" for app events, or "cap:<capability>" for capability events. */
  source: string;
  name: string;
  payload: T;
  workspaceId: string;
  at: string;
  /** correlation id for tracing a causal chain across apps. */
  causationId?: string;
}

export type EventHandler = (e: FabricEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

interface Sub {
  workspaceId: string;
  /** "<source>.<name>", "<source>.*", or "*". */
  pattern: string;
  handler: EventHandler;
}

export class EventBus {
  private subs: Sub[] = [];
  private sinks: EventHandler[] = [];
  private log: FabricEvent[] = [];
  private maxLog = 1000;

  subscribe(workspaceId: string, pattern: string, handler: EventHandler): Unsubscribe {
    const sub: Sub = { workspaceId, pattern, handler };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  /** Observe every event for persistence/queue delivery without changing apps. */
  addSink(handler: EventHandler): Unsubscribe {
    this.sinks.push(handler);
    return () => {
      this.sinks = this.sinks.filter((sink) => sink !== handler);
    };
  }

  async publish(evt: Omit<FabricEvent, "id" | "at">): Promise<FabricEvent> {
    const full: FabricEvent = {
      ...evt,
      id: `evt_${crypto.randomUUID()}`,
      at: new Date().toISOString(),
    };
    this.log.push(full);
    for (const sink of this.sinks) await sink(full);

    if (this.log.length > this.maxLog) this.log.shift();

    const key = `${full.source}.${full.name}`;
    const matched = this.subs.filter(
      (s) => s.workspaceId === full.workspaceId && matches(s.pattern, key),
    );
    // Deliver sequentially so causal chains are deterministic in dev.
    for (const s of matched) await s.handler(full);
    return full;
  }

  /** Recent events, newest last. Powers the per-app activity feed. */
  recent(workspaceId: string, limit = 50): FabricEvent[] {
    return this.log.filter((e) => e.workspaceId === workspaceId).slice(-limit);
  }
}

function matches(pattern: string, key: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}

import type { AppDocument, Subscription } from "@fabric/ir";
import type { EventBus, Unsubscribe } from "@fabric/events";
import { evaluate } from "@fabric/interpreter";

/**
 * Connections.
 *
 * A connection is the runtime realization of a Subscription in an app's IR.
 * "When expense-tracker.expenseApproved, run recordEntry" becomes a bus
 * subscription that, on each matching event, maps the event payload to the
 * target action's params and invokes it.
 *
 * WHY this indirection exists: the *user* expresses intent ("when expense
 * approved, update accounting") and the AI writes a Subscription. Neither app
 * imports the other, calls an API, or shares a database. The connection
 * manager is the only thing that knows both exist, and it is pure plumbing
 * over the event bus.
 */

export type ActionInvoker = (
  appId: string,
  action: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export class ConnectionManager {
  private subs: Unsubscribe[] = [];
  private bus: EventBus;
  private invoke: ActionInvoker;

  constructor(bus: EventBus, invoke: ActionInvoker) {
    this.bus = bus;
    this.invoke = invoke;
  }

  /** Wire every subscription declared by an app in a workspace. */
  connect(workspaceId: string, app: AppDocument): void {
    for (const sub of app.subscriptions) {
      this.subs.push(this.wire(workspaceId, app.id, sub));
    }
  }

  private wire(workspaceId: string, appId: string, sub: Subscription): Unsubscribe {
    // "<sourceApp>.<event>" (cross-app) or "<event>" (local, same app source).
    const pattern = sub.on.includes(".") ? sub.on : `${appId}.${sub.on}`;
    return this.bus.subscribe(workspaceId, pattern, async (evt) => {
      const scope = { event: evt.payload, source: evt.source };
      const params: Record<string, unknown> = {};
      if (sub.map) {
        for (const [k, v] of Object.entries(sub.map)) params[k] = evaluate(v, scope);
      } else if (evt.payload && typeof evt.payload === "object") {
        Object.assign(params, evt.payload as Record<string, unknown>);
      }
      await this.invoke(appId, sub.run, params);
    });
  }

  disconnectAll(): void {
    this.subs.forEach((u) => u());
    this.subs = [];
  }
}

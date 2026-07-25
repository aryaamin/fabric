import type { SecretReader } from "@fabric/capabilities";

/**
 * The secret vault.
 *
 * WHY the runtime owns secrets and the IR never does: an application document
 * is shared, forked, and version-controlled. If a secret lived in the IR it
 * would leak the instant an app is shared. So the IR only names secrets
 * (`{$:"secrets.STRIPE_KEY"}`); values live here, keyed by app instance, and
 * are injected only into capability config and never exposed to app logic or
 * the client.
 */
export class SecretVault {
  private byInstance = new Map<string, Map<string, string>>();

  set(instanceId: string, name: string, value: string): void {
    let m = this.byInstance.get(instanceId);
    if (!m) {
      m = new Map();
      this.byInstance.set(instanceId, m);
    }
    m.set(name, value);
  }

  reader(instanceId: string): SecretReader {
    const m = this.byInstance.get(instanceId) ?? new Map<string, string>();
    return { get: (name: string) => m.get(name) };
  }

  /** plain object view for config expression evaluation (server-side only). */
  asScope(instanceId: string): Record<string, string> {
    return Object.fromEntries(this.byInstance.get(instanceId) ?? new Map());
  }
}

export * from "./expr.ts";
export * from "./document.ts";
export * from "./patch.ts";
export * from "./nodes.ts";

import type { AppDocument } from "./document.ts";
import { IR_SPEC_VERSION } from "./document.ts";

/** Authoring helper: fills in the spec version and structural defaults. */
export function defineApp(
  doc: Pick<AppDocument, "id" | "name"> & Partial<AppDocument>,
): AppDocument {
  return {
    spec: IR_SPEC_VERSION,
    capabilities: [],
    models: [],
    actions: [],
    events: [],
    subscriptions: [],
    views: [],
    permissions: { roles: ["owner"], default: "deny" },
    ...doc,
  };
}

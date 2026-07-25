import type {
  Capability,
  CapabilityContext,
  CapabilityFactory,
  CapabilityManifest,
  FactoryEnv,
} from "@fabric/capabilities";
import { BaseCapability, CapabilityError } from "@fabric/capabilities";
import { InMemoryDataStore, type DataStore, type Filter, type Sort } from "./store.ts";

export * from "./store.ts";

const manifest: CapabilityManifest = {
  name: "storage",
  version: "0.1.0",
  description: "Structured, per-app persistence. The app never picks a database.",
  methods: [
    { name: "create", permission: "storage.write", mutates: true, emits: ["created"], input: { model: { type: "string", required: true }, data: { type: "json", required: true } }, output: { type: "object" } },
    { name: "get", permission: "storage.read", input: { model: { type: "string", required: true }, id: { type: "string", required: true } }, output: { type: "object" } },
    { name: "update", permission: "storage.write", mutates: true, emits: ["updated"], input: { model: { type: "string", required: true }, id: { type: "string", required: true }, data: { type: "json", required: true } }, output: { type: "object" } },
    { name: "delete", permission: "storage.write", mutates: true, emits: ["deleted"], input: { model: { type: "string", required: true }, id: { type: "string", required: true } }, output: { type: "object" } },
    { name: "list", permission: "storage.read", input: { model: { type: "string", required: true }, where: { type: "json" }, sort: { type: "json" }, limit: { type: "number" } }, output: { type: "array" } },
    { name: "count", permission: "storage.read", input: { model: { type: "string", required: true }, where: { type: "json" } }, output: { type: "number" } },
  ],
  events: [
    { name: "created", payload: { model: { type: "string" }, id: { type: "string" } } },
    { name: "updated", payload: { model: { type: "string" }, id: { type: "string" } } },
    { name: "deleted", payload: { model: { type: "string" }, id: { type: "string" } } },
  ],
};

class StorageCapability extends BaseCapability {
  readonly manifest = manifest;
  private store: DataStore;
  constructor(store: DataStore) {
    super();
    this.store = store;
  }

  protected handlers = {
    create: async (a: { model: string; data: Record<string, unknown> }, ctx: CapabilityContext) => {
      const rec = await this.store.create(a.model, a.data ?? {});
      await ctx.emit("created", { model: a.model, id: rec.id });
      return rec;
    },
    get: async (a: { model: string; id: string }) => this.store.get(a.model, a.id),
    update: async (a: { model: string; id: string; data: Record<string, unknown> }, ctx: CapabilityContext) => {
      const rec = await this.store.update(a.model, a.id, a.data ?? {});
      await ctx.emit("updated", { model: a.model, id: rec.id });
      return rec;
    },
    delete: async (a: { model: string; id: string }, ctx: CapabilityContext) => {
      const ok = await this.store.remove(a.model, a.id);
      if (ok) await ctx.emit("deleted", { model: a.model, id: a.id });
      return { deleted: ok };
    },
    list: async (a: { model: string; where?: Filter; sort?: Sort[]; limit?: number }) =>
      this.store.list(a.model, { where: a.where, sort: a.sort, limit: a.limit }),
    count: async (a: { model: string; where?: Filter }) => this.store.count(a.model, a.where),
  };
}

/**
 * Factory. In production, `create` would select an adapter based on config
 * (Neon, SQLite, ...) using `env.namespace` for isolation. Here it returns the
 * reference in-memory adapter, one store per app installation.
 */
export function storageCapabilityFactory(
  makeStore: (env: FactoryEnv) => DataStore = () => new InMemoryDataStore(),
): CapabilityFactory {
  return {
    manifest,
    create(_config: Record<string, unknown>, env: FactoryEnv): Capability {
      if (!env.namespace) throw new CapabilityError("no_namespace", "storage requires a namespace");
      return new StorageCapability(makeStore(env));
    },
  };
}

/**
 * DataStore — the swappable persistence port.
 *
 * WHY a port + adapter: the storage *capability* is stable, but its backend
 * must be free to change (in-memory for dev/preview, SQLite for local, Neon
 * Postgres for production) with zero app changes. Everything above this
 * interface is infra-agnostic. The in-memory adapter below is the reference
 * implementation and the one used by the preview runtime.
 */

export interface Record_ {
  id: string;
  createdAt: string;
  updatedAt: string;
  [k: string]: unknown;
}

export type Filter = Record<string, unknown | FilterOp>;
export interface FilterOp {
  $eq?: unknown;
  $ne?: unknown;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $in?: unknown[];
  $contains?: string;
}

export interface Sort {
  field: string;
  dir: "asc" | "desc";
}

export interface ListParams {
  where?: Filter;
  sort?: Sort[];
  limit?: number;
  offset?: number;
}

export interface DataStore {
  create(collection: string, data: Record<string, unknown>): Promise<Record_>;
  get(collection: string, id: string): Promise<Record_ | null>;
  update(collection: string, id: string, patch: Record<string, unknown>): Promise<Record_>;
  remove(collection: string, id: string): Promise<boolean>;
  list(collection: string, params?: ListParams): Promise<Record_[]>;
  count(collection: string, where?: Filter): Promise<number>;
}

function newId(): string {
  return crypto.randomUUID();
}

/** Namespaced in-memory store. Each app installation gets its own instance. */
export class InMemoryDataStore implements DataStore {
  private data = new Map<string, Map<string, Record_>>();

  private col(name: string): Map<string, Record_> {
    let c = this.data.get(name);
    if (!c) {
      c = new Map();
      this.data.set(name, c);
    }
    return c;
  }

  async create(collection: string, data: Record<string, unknown>): Promise<Record_> {
    const now = new Date().toISOString();
    const rec: Record_ = { ...data, id: newId(), createdAt: now, updatedAt: now };
    this.col(collection).set(rec.id, rec);
    return structuredClone(rec);
  }

  async get(collection: string, id: string): Promise<Record_ | null> {
    const rec = this.col(collection).get(id);
    return rec ? structuredClone(rec) : null;
  }

  async update(collection: string, id: string, patch: Record<string, unknown>): Promise<Record_> {
    const c = this.col(collection);
    const rec = c.get(id);
    if (!rec) throw new Error(`record ${collection}/${id} not found`);
    const next: Record_ = { ...rec, ...patch, id: rec.id, createdAt: rec.createdAt, updatedAt: new Date().toISOString() };
    c.set(id, next);
    return structuredClone(next);
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.col(collection).delete(id);
  }

  async list(collection: string, params: ListParams = {}): Promise<Record_[]> {
    return applyListParams([...this.col(collection).values()], params).map((r) => structuredClone(r));
  }

  async count(collection: string, where?: Filter): Promise<number> {
    return [...this.col(collection).values()].filter((r) => matchesFilter(r, where)).length;
  }
}

/** Shared query semantics used by every adapter, including Neon. */
export function applyListParams(rows: Record_[], params: ListParams = {}): Record_[] {
  const filtered = rows.filter((r) => matchesFilter(r, params.where));
  for (const s of [...(params.sort ?? [])].reverse()) {
    filtered.sort((a, b) => compareValues(a[s.field], b[s.field]) * (s.dir === "desc" ? -1 : 1));
  }
  const start = params.offset ?? 0;
  const end = params.limit != null ? start + params.limit : undefined;
  return filtered.slice(start, end);
}

export function matchesFilter(row: Record_, where?: Filter): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => matchField(row[field], cond));
}

function matchField(value: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond)) return value === cond;
  const c = cond as FilterOp;
  if ("$eq" in c) return value === c.$eq;
  if ("$ne" in c) return value !== c.$ne;
  if ("$in" in c) return Array.isArray(c.$in) && c.$in.includes(value);
  if ("$contains" in c) return typeof value === "string" && value.includes(String(c.$contains));
  if ("$gt" in c) return compareValues(value, c.$gt) > 0;
  if ("$gte" in c) return compareValues(value, c.$gte) >= 0;
  if ("$lt" in c) return compareValues(value, c.$lt) < 0;
  if ("$lte" in c) return compareValues(value, c.$lte) <= 0;
  return true;
}

export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

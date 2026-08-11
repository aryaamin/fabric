import {
  applyListParams,
  matchesFilter,
  type DataStore,
  type Filter,
  type ListParams,
  type Record_,
} from "./store.ts";

export type SqlRow = Record<string, unknown>;

/**
 * Minimal SQL boundary. The core storage package stays provider-neutral while
 * the Studio can adapt Neon, Postgres.js, or a test double to this function.
 */
export type SqlExecutor = <T extends SqlRow = SqlRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<T[]>;

interface StoredRow extends SqlRow {
  id: string;
  data: Record<string, unknown> | string;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * Durable app-record adapter.
 *
 * Small Software deliberately trades huge-table query optimization for one
 * exact query language across local and cloud runtimes: rows for a collection
 * are loaded from Postgres, then filtered/sorted with the same pure functions
 * as InMemoryDataStore. Per-app namespaces keep these sets intentionally small.
 */
export class PostgresDataStore implements DataStore {
  private readonly sql: SqlExecutor;
  private readonly namespace: string;

  constructor(sql: SqlExecutor, namespace: string) {
    if (!namespace) throw new Error("PostgresDataStore requires a namespace");
    this.sql = sql;
    this.namespace = namespace;
  }

  async create(collection: string, data: Record<string, unknown>): Promise<Record_> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const payload = userData(data);
    await this.sql(
      `INSERT INTO app_records
        (namespace, collection, id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
      [this.namespace, collection, id, JSON.stringify(payload), now],
    );
    return { ...payload, id, createdAt: now, updatedAt: now };
  }

  async get(collection: string, id: string): Promise<Record_ | null> {
    const rows = await this.sql<StoredRow>(
      `SELECT id, data, created_at, updated_at
       FROM app_records
       WHERE namespace = $1 AND collection = $2 AND id = $3`,
      [this.namespace, collection, id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(collection: string, id: string, patch: Record<string, unknown>): Promise<Record_> {
    const current = await this.get(collection, id);
    if (!current) throw new Error(`record ${collection}/${id} not found`);
    const now = new Date().toISOString();
    const payload = userData({ ...current, ...patch });
    const rows = await this.sql<StoredRow>(
      `UPDATE app_records
       SET data = $4::jsonb, updated_at = $5
       WHERE namespace = $1 AND collection = $2 AND id = $3
       RETURNING id, data, created_at, updated_at`,
      [this.namespace, collection, id, JSON.stringify(payload), now],
    );
    if (!rows[0]) throw new Error(`record ${collection}/${id} not found`);
    return toRecord(rows[0]);
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }>(
      `DELETE FROM app_records
       WHERE namespace = $1 AND collection = $2 AND id = $3
       RETURNING id`,
      [this.namespace, collection, id],
    );
    return rows.length > 0;
  }

  async list(collection: string, params: ListParams = {}): Promise<Record_[]> {
    const rows = await this.collection(collection);
    return applyListParams(rows, params);
  }

  async count(collection: string, where?: Filter): Promise<number> {
    const rows = await this.collection(collection);
    return rows.filter((row) => matchesFilter(row, where)).length;
  }

  private async collection(collection: string): Promise<Record_[]> {
    const rows = await this.sql<StoredRow>(
      `SELECT id, data, created_at, updated_at
       FROM app_records
       WHERE namespace = $1 AND collection = $2`,
      [this.namespace, collection],
    );
    return rows.map(toRecord);
  }
}

function toRecord(row: StoredRow): Record_ {
  const data = typeof row.data === "string" ? (JSON.parse(row.data) as Record<string, unknown>) : row.data;
  return {
    ...data,
    id: row.id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function userData(value: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = value;
  return data;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

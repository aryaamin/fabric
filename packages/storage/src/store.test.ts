import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryDataStore, applyListParams, type Record_ } from "./store.ts";
import { PostgresDataStore, type SqlExecutor } from "./postgres.ts";

test("record metadata cannot be overwritten by user data", async () => {
  const store = new InMemoryDataStore();
  const record = await store.create("Task", {
    id: "forged",
    createdAt: "yesterday",
    updatedAt: "yesterday",
    title: "Ship",
  });

  assert.notEqual(record.id, "forged");
  assert.notEqual(record.createdAt, "yesterday");
  assert.equal(record.title, "Ship");
});

test("all adapters share filter, sort, and pagination semantics", () => {
  const rows: Record_[] = [
    record("1", { score: 2, title: "Beta" }),
    record("2", { score: 7, title: "Alpha" }),
    record("3", { score: 5, title: "Gamma" }),
  ];

  const result = applyListParams(rows, {
    where: { score: { $gte: 5 } },
    sort: [{ field: "title", dir: "asc" }],
    limit: 1,
  });

  assert.deepEqual(result.map((row) => row.id), ["2"]);
});

test("Postgres adapter scopes every query to its app namespace", async () => {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  const sql: SqlExecutor = async <T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    calls.push({ text, params });
    return [] as T[];
  };
  const store = new PostgresDataStore(sql, "ws:app:instance");

  const created = await store.create("Task", { title: "Ship" });

  assert.equal(created.title, "Ship");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.params[0], "ws:app:instance");
  assert.equal(calls[0]!.params[1], "Task");
  assert.match(calls[0]!.text, /INSERT INTO app_records/);
});

function record(id: string, data: Record<string, unknown>): Record_ {
  return {
    ...data,
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

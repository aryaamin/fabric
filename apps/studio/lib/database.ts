import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { CloudSqlExecutor } from "@fabric/cloud";
import type { ProjectSqlExecutor } from "@fabric/projects";
import type { SqlExecutor } from "@fabric/storage";
import type { VersionSqlExecutor } from "@fabric/versioning";
import type { WorkspaceSqlExecutor } from "@fabric/workspace";

type DatabaseExecutor = SqlExecutor &
  VersionSqlExecutor &
  WorkspaceSqlExecutor &
  ProjectSqlExecutor &
  CloudSqlExecutor;

let client: NeonQueryFunction<false, false> | undefined;

/**
 * Lazily creates the Neon HTTP client so `next build` can evaluate modules
 * before Marketplace environment variables have been provisioned.
 */
export function getDatabaseExecutor(): DatabaseExecutor {
  const sql = databaseClient();
  return (async <T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    const rows = await sql.query(text, [...params]);
    return rows as T[];
  }) as DatabaseExecutor;
}

export async function runDatabaseTransaction(
  statements: { text: string; params?: readonly unknown[] }[],
): Promise<void> {
  if (statements.length === 0) return;
  const sql = databaseClient();
  await sql.transaction(
    statements.map((statement) =>
      sql.query(statement.text, [...(statement.params ?? [])]),
    ),
  );
}

export function hasDurableDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function databaseClient(): NeonQueryFunction<false, false> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for durable Fabric storage");
  }
  return (client ??= neon(connectionString));
}

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
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for durable Fabric storage");
  }
  client ??= neon(connectionString);
  return (async <T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    const rows = await client!.query(text, [...params]);
    return rows as T[];
  }) as DatabaseExecutor;
}

export function hasDurableDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

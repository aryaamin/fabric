import type { AppDocument } from "@fabric/ir";
import { hashDoc, type CommitInput, type Version } from "./index.ts";

export type VersionSqlRow = Record<string, unknown>;
export type VersionSqlExecutor = <T extends VersionSqlRow = VersionSqlRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<T[]>;

/** Async production counterpart to the synchronous demo VersionStore. */
export interface VersionRepository {
  commit(workspaceId: string, input: CommitInput): Promise<Version>;
  get(workspaceId: string, versionId: string): Promise<Version | null>;
  head(workspaceId: string, appId: string): Promise<Version | null>;
  listHeads(workspaceId: string): Promise<Version[]>;
  restore(workspaceId: string, appId: string, versionId: string): Promise<Version>;
  history(workspaceId: string, appId: string): Promise<Version[]>;
  all(workspaceId: string, appId: string): Promise<Version[]>;
  fork(workspaceId: string, versionId: string, newAppId: string, author?: string): Promise<Version>;
}

interface VersionRow extends VersionSqlRow {
  id: string;
  app_id: string;
  parent_id: string | null;
  author: string;
  message: string;
  doc: AppDocument | string;
  created_at: string | Date;
}

export class PostgresVersionRepository implements VersionRepository {
  private readonly sql: VersionSqlExecutor;

  constructor(sql: VersionSqlExecutor) {
    this.sql = sql;
  }

  async commit(workspaceId: string, input: CommitInput): Promise<Version> {
    const id = hashDoc(input.doc);
    const now = new Date().toISOString();
    await this.sql(
      `INSERT INTO app_versions
        (workspace_id, id, app_id, parent_id, author, message, doc, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [
        workspaceId,
        id,
        input.appId,
        input.parent ?? null,
        input.author ?? "ai",
        input.message ?? "edit",
        JSON.stringify(input.doc),
        now,
      ],
    );
    await this.sql(
      `INSERT INTO app_installations
        (workspace_id, app_id, instance_id, head_version_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (workspace_id, app_id)
       DO UPDATE SET head_version_id = EXCLUDED.head_version_id, updated_at = EXCLUDED.updated_at`,
      [workspaceId, input.appId, crypto.randomUUID(), id, now],
    );
    const version = await this.get(workspaceId, id);
    if (!version) throw new Error(`failed to persist version ${id}`);
    return version;
  }

  async get(workspaceId: string, versionId: string): Promise<Version | null> {
    const rows = await this.sql<VersionRow>(
      `SELECT id, app_id, parent_id, author, message, doc, created_at
       FROM app_versions
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, versionId],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async head(workspaceId: string, appId: string): Promise<Version | null> {
    const rows = await this.sql<VersionRow>(
      `SELECT v.id, v.app_id, v.parent_id, v.author, v.message, v.doc, v.created_at
       FROM app_installations i
       JOIN app_versions v
         ON v.workspace_id = i.workspace_id AND v.id = i.head_version_id
       WHERE i.workspace_id = $1 AND i.app_id = $2`,
      [workspaceId, appId],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listHeads(workspaceId: string): Promise<Version[]> {
    const rows = await this.sql<VersionRow>(
      `SELECT v.id, v.app_id, v.parent_id, v.author, v.message, v.doc, v.created_at
       FROM app_installations i
       JOIN app_versions v
         ON v.workspace_id = i.workspace_id AND v.id = i.head_version_id
       WHERE i.workspace_id = $1`,
      [workspaceId],
    );
    return rows.map(fromRow);
  }

  async restore(workspaceId: string, appId: string, versionId: string): Promise<Version> {
    const version = await this.get(workspaceId, versionId);
    if (!version || version.appId !== appId) {
      throw new Error(`version ${versionId} not in app ${appId}`);
    }
    const rows = await this.sql<{ app_id: string }>(
      `UPDATE app_installations
       SET head_version_id = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND app_id = $2
       RETURNING app_id`,
      [workspaceId, appId, versionId],
    );
    if (!rows[0]) throw new Error(`app ${appId} is not installed`);
    return version;
  }

  async history(workspaceId: string, appId: string): Promise<Version[]> {
    const head = await this.head(workspaceId, appId);
    if (!head) return [];
    const rows = await this.sql<VersionRow>(
      `WITH RECURSIVE history AS (
         SELECT id, app_id, parent_id, author, message, doc, created_at, workspace_id
         FROM app_versions
         WHERE workspace_id = $1 AND id = $2
         UNION ALL
         SELECT v.id, v.app_id, v.parent_id, v.author, v.message, v.doc, v.created_at, v.workspace_id
         FROM app_versions v
         JOIN history h ON v.workspace_id = h.workspace_id AND v.id = h.parent_id
       )
       SELECT id, app_id, parent_id, author, message, doc, created_at
       FROM history`,
      [workspaceId, head.id],
    );
    return rows.map(fromRow);
  }

  async all(workspaceId: string, appId: string): Promise<Version[]> {
    const rows = await this.sql<VersionRow>(
      `SELECT id, app_id, parent_id, author, message, doc, created_at
       FROM app_versions
       WHERE workspace_id = $1 AND app_id = $2
       ORDER BY created_at ASC`,
      [workspaceId, appId],
    );
    return rows.map(fromRow);
  }

  async fork(
    workspaceId: string,
    versionId: string,
    newAppId: string,
    author = "user",
  ): Promise<Version> {
    const source = await this.get(workspaceId, versionId);
    if (!source) throw new Error(`version ${versionId} not found`);
    const doc: AppDocument = { ...structuredClone(source.doc), id: newAppId };
    return this.commit(workspaceId, {
      appId: newAppId,
      doc,
      parent: source.id,
      author,
      message: `forked from ${source.appId}@${source.id.slice(0, 8)}`,
    });
  }
}

function fromRow(row: VersionRow): Version {
  const doc = typeof row.doc === "string" ? (JSON.parse(row.doc) as AppDocument) : row.doc;
  return {
    id: row.id,
    appId: row.app_id,
    author: row.author,
    message: row.message,
    doc,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    ...(row.parent_id ? { parent: row.parent_id } : {}),
  };
}

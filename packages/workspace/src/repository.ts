import {
  createObject,
  createWorkspace,
  type CreateObjectInput,
  type Grant,
  type ShareRole,
  type Workspace,
  type WorkspaceObject,
} from "./index.ts";

export type WorkspaceSqlRow = Record<string, unknown>;
export type WorkspaceSqlExecutor = <T extends WorkspaceSqlRow = WorkspaceSqlRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<T[]>;

export interface WorkspaceRepository {
  get(workspaceId: string): Promise<Workspace | null>;
  create(workspaceId: string, name: string): Promise<Workspace>;
  listObjects(workspaceId: string): Promise<WorkspaceObject[]>;
  findBySlug(workspaceId: string, slug: string): Promise<WorkspaceObject | null>;
  createObject(workspaceId: string, input: CreateObjectInput): Promise<WorkspaceObject>;
  saveObject(workspaceId: string, object: WorkspaceObject): Promise<void>;
  upsertGrant(objectId: string, grant: Grant): Promise<void>;
}

interface ObjectRow extends WorkspaceSqlRow {
  id: string;
  kind: WorkspaceObject["kind"];
  name: string;
  slug: string;
  app_id: string | null;
  project_id: string | null;
  parent_id: string | null;
  icon: string | null;
  link_role: ShareRole | null;
  share_token: string;
  public: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

interface GrantRow extends WorkspaceSqlRow {
  object_id: string;
  principal_id: string;
  role: ShareRole;
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  private readonly sql: WorkspaceSqlExecutor;

  constructor(sql: WorkspaceSqlExecutor) {
    this.sql = sql;
  }

  async get(workspaceId: string): Promise<Workspace | null> {
    const rows = await this.sql<{ id: string; name: string }>(
      "SELECT id, name FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (!rows[0]) return null;
    const workspace = createWorkspace(rows[0].id, rows[0].name);
    for (const object of await this.listObjects(workspaceId)) workspace.objects.set(object.id, object);
    return workspace;
  }

  async create(workspaceId: string, name: string): Promise<Workspace> {
    await this.sql(
      `INSERT INTO workspaces (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [workspaceId, name],
    );
    return createWorkspace(workspaceId, name);
  }

  async listObjects(workspaceId: string): Promise<WorkspaceObject[]> {
    const objects = await this.sql<ObjectRow>(
      `SELECT id, kind, name, slug, app_id, project_id, parent_id, icon, link_role,
              share_token, public, created_at, updated_at
       FROM workspace_objects
       WHERE workspace_id = $1
       ORDER BY updated_at DESC`,
      [workspaceId],
    );
    if (objects.length === 0) return [];
    const grants = await this.sql<GrantRow>(
      `SELECT object_id, principal_id, role
       FROM workspace_grants
       WHERE object_id = ANY($1::text[])`,
      [objects.map((object) => object.id)],
    );
    return objects.map((row) => fromRow(row, grants.filter((grant) => grant.object_id === row.id)));
  }

  async findBySlug(workspaceId: string, slug: string): Promise<WorkspaceObject | null> {
    const rows = await this.sql<ObjectRow>(
      `SELECT id, kind, name, slug, app_id, project_id, parent_id, icon, link_role,
              share_token, public, created_at, updated_at
       FROM workspace_objects
       WHERE workspace_id = $1 AND slug = $2`,
      [workspaceId, slug],
    );
    if (!rows[0]) return null;
    const grants = await this.sql<GrantRow>(
      `SELECT object_id, principal_id, role
       FROM workspace_grants
       WHERE object_id = $1`,
      [rows[0].id],
    );
    return fromRow(rows[0], grants);
  }

  async createObject(workspaceId: string, input: CreateObjectInput): Promise<WorkspaceObject> {
    const object = createObject(createWorkspace(workspaceId, ""), input);
    await this.sql(
      `INSERT INTO workspace_objects
        (id, workspace_id, kind, name, slug, app_id, project_id, parent_id, icon,
         link_role, share_token, public, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        object.id,
        workspaceId,
        object.kind,
        object.name,
        object.slug,
        object.appId ?? null,
        object.projectId ?? null,
        object.parentId ?? null,
        object.icon ?? null,
        object.linkRole ?? null,
        object.shareToken,
        object.public,
        object.createdAt,
        object.updatedAt,
      ],
    );
    for (const grant of object.grants) await this.upsertGrant(object.id, grant);
    return object;
  }

  async saveObject(workspaceId: string, object: WorkspaceObject): Promise<void> {
    const rows = await this.sql<{ id: string }>(
      `UPDATE workspace_objects
       SET name = $3, slug = $4, app_id = $5, project_id = $6, parent_id = $7, icon = $8,
           link_role = $9, share_token = $10, public = $11, updated_at = $12
       WHERE workspace_id = $1 AND id = $2
       RETURNING id`,
      [
        workspaceId,
        object.id,
        object.name,
        object.slug,
        object.appId ?? null,
        object.projectId ?? null,
        object.parentId ?? null,
        object.icon ?? null,
        object.linkRole ?? null,
        object.shareToken,
        object.public,
        object.updatedAt,
      ],
    );
    if (!rows[0]) throw new Error(`workspace object ${object.id} not found`);
    for (const grant of object.grants) await this.upsertGrant(object.id, grant);
  }

  async upsertGrant(objectId: string, grant: Grant): Promise<void> {
    await this.sql(
      `INSERT INTO workspace_grants (object_id, principal_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (object_id, principal_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [objectId, grant.principalId, grant.role],
    );
  }
}

function fromRow(row: ObjectRow, grants: GrantRow[]): WorkspaceObject {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    grants: grants.map((grant) => ({ principalId: grant.principal_id, role: grant.role })),
    shareToken: row.share_token,
    public: row.public,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.app_id ? { appId: row.app_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.link_role ? { linkRole: row.link_role } : {}),
  };
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

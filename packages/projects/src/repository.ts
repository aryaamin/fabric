import {
  createSnapshot,
  normalizeServices,
  normalizeSourceFiles,
  type CloudProject,
  type CreateProjectInput,
  type ProjectRepository,
  type ProjectService,
  type ProjectSnapshot,
  type SealSnapshotInput,
  type SnapshotFile,
  type SourceFile,
  type SourceFileInput,
} from "./index.ts";

export type ProjectSqlRow = Record<string, unknown>;
export type ProjectSqlExecutor = <T extends ProjectSqlRow = ProjectSqlRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<T[]>;

interface ProjectRow extends ProjectSqlRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  mode: CloudProject["mode"];
  head_snapshot_id: string | null;
  active_deployment_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ServiceRow extends ProjectSqlRow {
  project_id: string;
  name: string;
  kind: ProjectService["kind"];
  root: string;
  runtime: ProjectService["runtime"];
  build_command: string[] | string | null;
  start_command: string[] | string | null;
  health_check_path: string | null;
}

interface FileRow extends ProjectSqlRow {
  path: string;
  content: string;
  encoding: SourceFile["encoding"];
  executable: boolean;
}

interface SnapshotRow extends ProjectSqlRow {
  id: string;
  tree_digest: string;
  workspace_id: string;
  project_id: string;
  parent_id: string | null;
  files: SnapshotFile[] | string;
  author: string;
  message: string;
  created_at: string | Date;
}

/** Durable Postgres adapter for the provider-neutral project repository. */
export class PostgresProjectRepository implements ProjectRepository {
  private readonly sql: ProjectSqlExecutor;

  constructor(sql: ProjectSqlExecutor) {
    this.sql = sql;
  }

  async create(workspaceId: string, input: CreateProjectInput): Promise<CloudProject> {
    const id = input.id ?? `prj_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const services = normalizeServices(
      input.services ?? [{ name: "web", kind: "web", root: ".", runtime: "auto" }],
    );
    const slug = normalizeProjectSlug(input.slug ?? input.name);
    const rows = await this.sql<ProjectRow>(
      `INSERT INTO cloud_projects
        (workspace_id, id, name, slug, mode, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING workspace_id, id, name, slug, mode, head_snapshot_id,
                 active_deployment_id, created_at, updated_at`,
      [workspaceId, id, requireName(input.name), slug, input.mode ?? "source", now],
    );
    if (!rows[0]) throw new Error(`failed to create project ${id}`);
    await this.replaceServices(workspaceId, id, services);
    return fromProjectRow(rows[0], services);
  }

  async get(workspaceId: string, projectId: string): Promise<CloudProject | null> {
    const rows = await this.sql<ProjectRow>(
      `SELECT workspace_id, id, name, slug, mode, head_snapshot_id,
              active_deployment_id, created_at, updated_at
       FROM cloud_projects
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, projectId],
    );
    return rows[0] ? fromProjectRow(rows[0], await this.services(workspaceId, projectId)) : null;
  }

  async list(workspaceId: string): Promise<CloudProject[]> {
    const rows = await this.sql<ProjectRow>(
      `SELECT workspace_id, id, name, slug, mode, head_snapshot_id,
              active_deployment_id, created_at, updated_at
       FROM cloud_projects
       WHERE workspace_id = $1
       ORDER BY updated_at DESC`,
      [workspaceId],
    );
    return Promise.all(
      rows.map(async (row) => fromProjectRow(row, await this.services(workspaceId, row.id))),
    );
  }

  async updateServices(
    workspaceId: string,
    projectId: string,
    services: ProjectService[],
  ): Promise<CloudProject> {
    await this.mustProject(workspaceId, projectId);
    await this.replaceServices(workspaceId, projectId, normalizeServices(services));
    await this.touch(workspaceId, projectId);
    return this.mustProject(workspaceId, projectId);
  }

  async writeFiles(
    workspaceId: string,
    projectId: string,
    inputs: SourceFileInput[],
  ): Promise<SourceFile[]> {
    await this.mustProject(workspaceId, projectId);
    const normalized = normalizeSourceFiles(inputs);
    const combined = new Map((await this.listFiles(workspaceId, projectId)).map((file) => [file.path, file]));
    for (const file of normalized) combined.set(file.path, file);
    normalizeSourceFiles([...combined.values()]);
    for (const file of normalized) {
      await this.sql(
        `INSERT INTO project_working_files
          (workspace_id, project_id, path, content, encoding, executable, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (workspace_id, project_id, path)
         DO UPDATE SET content = EXCLUDED.content, encoding = EXCLUDED.encoding,
                       executable = EXCLUDED.executable, updated_at = EXCLUDED.updated_at`,
        [workspaceId, projectId, file.path, file.content, file.encoding, file.executable],
      );
    }
    await this.touch(workspaceId, projectId);
    return normalized;
  }

  async deleteFiles(workspaceId: string, projectId: string, paths: string[]): Promise<void> {
    await this.mustProject(workspaceId, projectId);
    const normalized = paths.map((path) => normalizeSourceFiles([{ path, content: "" }])[0]!.path);
    if (normalized.length > 0) {
      await this.sql(
        `DELETE FROM project_working_files
         WHERE workspace_id = $1 AND project_id = $2 AND path = ANY($3::text[])`,
        [workspaceId, projectId, normalized],
      );
      await this.touch(workspaceId, projectId);
    }
  }

  async listFiles(workspaceId: string, projectId: string): Promise<SourceFile[]> {
    await this.mustProject(workspaceId, projectId);
    const rows = await this.sql<FileRow>(
      `SELECT path, content, encoding, executable
       FROM project_working_files
       WHERE workspace_id = $1 AND project_id = $2
       ORDER BY path`,
      [workspaceId, projectId],
    );
    return rows.map(fromFileRow);
  }

  async sealSnapshot(
    workspaceId: string,
    projectId: string,
    input: SealSnapshotInput = {},
  ): Promise<ProjectSnapshot> {
    const project = await this.mustProject(workspaceId, projectId);
    if (input.expectedHeadId !== undefined && (project.headSnapshotId ?? null) !== input.expectedHeadId) {
      throw new Error("project head changed");
    }
    const snapshot = createSnapshot({
      workspaceId,
      projectId,
      files: await this.listFiles(workspaceId, projectId),
      parentId: input.parentId ?? project.headSnapshotId,
      author: input.author,
      message: input.message,
    });
    await this.sql(
      `INSERT INTO project_snapshots
        (workspace_id, project_id, id, tree_digest, parent_id, files, author, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (workspace_id, project_id, id) DO NOTHING`,
      [
        workspaceId,
        projectId,
        snapshot.id,
        snapshot.treeDigest,
        snapshot.parentId ?? null,
        JSON.stringify(snapshot.files),
        snapshot.author,
        snapshot.message,
        snapshot.createdAt,
      ],
    );
    const persisted = await this.getSnapshot(workspaceId, projectId, snapshot.id);
    if (!persisted || persisted.treeDigest !== snapshot.treeDigest) {
      throw new Error(`failed to persist snapshot ${snapshot.id}`);
    }
    if (input.setHead !== false) {
      await this.setHead(workspaceId, projectId, snapshot.id, input.expectedHeadId);
    }
    return persisted;
  }

  async getSnapshot(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<ProjectSnapshot | null> {
    const rows = await this.sql<SnapshotRow>(
      `SELECT workspace_id, project_id, id, tree_digest, parent_id, files,
              author, message, created_at
       FROM project_snapshots
       WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
      [workspaceId, projectId, snapshotId],
    );
    return rows[0] ? fromSnapshotRow(rows[0]) : null;
  }

  async listSnapshots(workspaceId: string, projectId: string): Promise<ProjectSnapshot[]> {
    const rows = await this.sql<SnapshotRow>(
      `SELECT workspace_id, project_id, id, tree_digest, parent_id, files,
              author, message, created_at
       FROM project_snapshots
       WHERE workspace_id = $1 AND project_id = $2
       ORDER BY created_at DESC`,
      [workspaceId, projectId],
    );
    return rows.map(fromSnapshotRow);
  }

  async setHead(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    expectedHeadId?: string | null,
  ): Promise<CloudProject> {
    if (!(await this.getSnapshot(workspaceId, projectId, snapshotId))) {
      throw new Error(`snapshot ${snapshotId} not found`);
    }
    const condition =
      expectedHeadId === undefined
        ? ""
        : expectedHeadId === null
          ? " AND head_snapshot_id IS NULL"
          : " AND head_snapshot_id = $4";
    const params =
      expectedHeadId === undefined || expectedHeadId === null
        ? [workspaceId, projectId, snapshotId]
        : [workspaceId, projectId, snapshotId, expectedHeadId];
    const rows = await this.sql<ProjectRow>(
      `UPDATE cloud_projects
       SET head_snapshot_id = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2${condition}
       RETURNING workspace_id, id, name, slug, mode, head_snapshot_id,
                 active_deployment_id, created_at, updated_at`,
      params,
    );
    if (!rows[0]) throw new Error("project head changed");
    const snapshot = await this.getSnapshot(workspaceId, projectId, snapshotId);
    await this.sql(
      `DELETE FROM project_working_files WHERE workspace_id = $1 AND project_id = $2`,
      [workspaceId, projectId],
    );
    for (const file of snapshot!.files) {
      await this.sql(
        `INSERT INTO project_working_files
          (workspace_id, project_id, path, content, encoding, executable, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [workspaceId, projectId, file.path, file.content, file.encoding, file.executable],
      );
    }
    return fromProjectRow(rows[0], await this.services(workspaceId, projectId));
  }

  async setActiveDeployment(
    workspaceId: string,
    projectId: string,
    deploymentId: string | null,
  ): Promise<CloudProject> {
    const rows = await this.sql<ProjectRow>(
      `UPDATE cloud_projects
       SET active_deployment_id = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING workspace_id, id, name, slug, mode, head_snapshot_id,
                 active_deployment_id, created_at, updated_at`,
      [workspaceId, projectId, deploymentId],
    );
    if (!rows[0]) throw new Error(`project ${projectId} not found`);
    return fromProjectRow(rows[0], await this.services(workspaceId, projectId));
  }

  private async services(workspaceId: string, projectId: string): Promise<ProjectService[]> {
    const rows = await this.sql<ServiceRow>(
      `SELECT project_id, name, kind, root, runtime, build_command,
              start_command, health_check_path
       FROM project_services
       WHERE workspace_id = $1 AND project_id = $2
       ORDER BY name`,
      [workspaceId, projectId],
    );
    return rows.map(fromServiceRow);
  }

  private async replaceServices(
    workspaceId: string,
    projectId: string,
    services: ProjectService[],
  ): Promise<void> {
    await this.sql(
      `DELETE FROM project_services WHERE workspace_id = $1 AND project_id = $2`,
      [workspaceId, projectId],
    );
    for (const service of services) {
      await this.sql(
        `INSERT INTO project_services
          (workspace_id, project_id, name, kind, root, runtime, build_command,
           start_command, health_check_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
        [
          workspaceId,
          projectId,
          service.name,
          service.kind,
          service.root,
          service.runtime,
          JSON.stringify(service.buildCommand ?? null),
          JSON.stringify(service.startCommand ?? null),
          service.healthCheckPath ?? null,
        ],
      );
    }
  }

  private async mustProject(workspaceId: string, projectId: string): Promise<CloudProject> {
    const project = await this.get(workspaceId, projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    return project;
  }

  private async touch(workspaceId: string, projectId: string): Promise<void> {
    await this.sql(
      `UPDATE cloud_projects SET updated_at = NOW() WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, projectId],
    );
  }
}

function fromProjectRow(row: ProjectRow, services: ProjectService[]): CloudProject {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    mode: row.mode,
    services,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.head_snapshot_id ? { headSnapshotId: row.head_snapshot_id } : {}),
    ...(row.active_deployment_id ? { activeDeploymentId: row.active_deployment_id } : {}),
  };
}

function fromServiceRow(row: ServiceRow): ProjectService {
  const buildCommand = jsonArray(row.build_command);
  const startCommand = jsonArray(row.start_command);
  return {
    name: row.name,
    kind: row.kind,
    root: row.root,
    runtime: row.runtime,
    ...(buildCommand ? { buildCommand } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(row.health_check_path ? { healthCheckPath: row.health_check_path } : {}),
  };
}

function fromFileRow(row: FileRow): SourceFile {
  return {
    path: row.path,
    content: row.content,
    encoding: row.encoding,
    executable: row.executable,
  };
}

function fromSnapshotRow(row: SnapshotRow): ProjectSnapshot {
  return {
    id: row.id,
    treeDigest: row.tree_digest,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    files: typeof row.files === "string" ? (JSON.parse(row.files) as SnapshotFile[]) : row.files,
    author: row.author,
    message: row.message,
    createdAt: iso(row.created_at),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
  };
}

function jsonArray(value: string[] | string | null): string[] | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? (JSON.parse(value) as string[]) : value;
}

function normalizeProjectSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!slug) throw new Error("project slug is required");
  return slug;
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("project name is required");
  return name;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

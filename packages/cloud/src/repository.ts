import {
  assertBuildTransition,
  assertDeploymentTransition,
  type Build,
  type BuildEvent,
  type BuildPlan,
  type BuildState,
  type CloudRepository,
  type Deployment,
  type DeploymentState,
} from "./index.ts";

export type CloudSqlRow = Record<string, unknown>;
export type CloudSqlExecutor = <T extends CloudSqlRow = CloudSqlRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<T[]>;

interface BuildRow extends CloudSqlRow {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string;
  service: string;
  plan: BuildPlan | string;
  state: BuildState;
  idempotency_key: string;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface BuildEventRow extends CloudSqlRow {
  build_id: string;
  sequence: number;
  stream: BuildEvent["stream"];
  message: string;
  created_at: string | Date;
}

interface DeploymentRow extends CloudSqlRow {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string;
  build_id: string | null;
  service: string;
  provider: string;
  provider_deployment_id: string | null;
  state: DeploymentState;
  idempotency_key: string;
  immutable_url: string | null;
  provider_metadata: Record<string, unknown> | string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export class PostgresCloudRepository implements CloudRepository {
  private readonly sql: CloudSqlExecutor;

  constructor(sql: CloudSqlExecutor) {
    this.sql = sql;
  }

  async requestBuild(
    input: Omit<Build, "id" | "state" | "createdAt" | "updatedAt">,
  ): Promise<Build> {
    requireIdempotencyKey(input.idempotencyKey);
    const id = `bld_${crypto.randomUUID()}`;
    await this.sql(
      `INSERT INTO builds
        (workspace_id, id, project_id, snapshot_id, service, plan, state,
         idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'QUEUED', $7, NOW(), NOW())
       ON CONFLICT (workspace_id, project_id, idempotency_key) DO NOTHING`,
      [
        input.workspaceId,
        id,
        input.projectId,
        input.snapshotId,
        input.service,
        JSON.stringify(input.plan),
        input.idempotencyKey,
      ],
    );
    const rows = await this.sql<BuildRow>(
      `${buildSelect()}
       WHERE workspace_id = $1 AND project_id = $2 AND idempotency_key = $3`,
      [input.workspaceId, input.projectId, input.idempotencyKey],
    );
    if (!rows[0]) throw new Error("failed to request build");
    return fromBuildRow(rows[0]);
  }

  async getBuild(workspaceId: string, buildId: string): Promise<Build | null> {
    const rows = await this.sql<BuildRow>(
      `${buildSelect()} WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, buildId],
    );
    return rows[0] ? fromBuildRow(rows[0]) : null;
  }

  async listBuilds(workspaceId: string, projectId: string, limit = 50): Promise<Build[]> {
    requireListLimit(limit);
    const rows = await this.sql<BuildRow>(
      `${buildSelect()}
       WHERE workspace_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return rows.map(fromBuildRow);
  }

  async transitionBuild(
    workspaceId: string,
    buildId: string,
    next: BuildState,
    error?: string,
  ): Promise<Build> {
    const current = await this.getBuild(workspaceId, buildId);
    if (!current) throw new Error(`build ${buildId} not found`);
    assertBuildTransition(current.state, next);
    if (current.state === next) return current;
    const rows = await this.sql<BuildRow>(
      `UPDATE builds
       SET state = $4, error = COALESCE($5, error), updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 AND state = $3
       RETURNING id, workspace_id, project_id, snapshot_id, service, plan, state,
                 idempotency_key, error, created_at, updated_at`,
      [workspaceId, buildId, current.state, next, error ?? null],
    );
    if (!rows[0]) throw new Error(`build ${buildId} changed concurrently`);
    return fromBuildRow(rows[0]);
  }

  async appendBuildEvent(
    workspaceId: string,
    buildId: string,
    event: Omit<BuildEvent, "buildId" | "sequence" | "createdAt">,
  ): Promise<BuildEvent> {
    const counters = await this.sql<{ sequence: number }>(
      `UPDATE builds
       SET next_event_sequence = next_event_sequence + 1
       WHERE workspace_id = $1 AND id = $2
       RETURNING next_event_sequence - 1 AS sequence`,
      [workspaceId, buildId],
    );
    if (!counters[0]) throw new Error(`build ${buildId} not found`);
    const rows = await this.sql<BuildEventRow>(
      `INSERT INTO build_events
        (workspace_id, build_id, sequence, stream, message, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING build_id, sequence, stream, message, created_at`,
      [workspaceId, buildId, counters[0].sequence, event.stream, event.message],
    );
    if (!rows[0]) throw new Error(`failed to append event for build ${buildId}`);
    return fromBuildEventRow(rows[0]);
  }

  async listBuildEvents(
    workspaceId: string,
    buildId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<BuildEvent[]> {
    if (limit < 1 || limit > 1_000) throw new Error("event limit must be between 1 and 1000");
    const rows = await this.sql<BuildEventRow>(
      `SELECT build_id, sequence, stream, message, created_at
       FROM build_events
       WHERE workspace_id = $1 AND build_id = $2 AND sequence > $3
       ORDER BY sequence
       LIMIT $4`,
      [workspaceId, buildId, afterSequence, limit],
    );
    return rows.map(fromBuildEventRow);
  }

  async requestDeployment(
    input: Omit<Deployment, "id" | "state" | "createdAt" | "updatedAt">,
  ): Promise<Deployment> {
    requireIdempotencyKey(input.idempotencyKey);
    const id = `dep_${crypto.randomUUID()}`;
    await this.sql(
      `INSERT INTO deployments
        (workspace_id, id, project_id, snapshot_id, build_id, service, provider,
         provider_deployment_id, state, idempotency_key, immutable_url,
         provider_metadata, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'QUEUED', $9, $10, $11::jsonb,
               $12, NOW(), NOW())
       ON CONFLICT (workspace_id, project_id, idempotency_key) DO NOTHING`,
      [
        input.workspaceId,
        id,
        input.projectId,
        input.snapshotId,
        input.buildId ?? null,
        input.service,
        input.provider,
        input.providerDeploymentId ?? null,
        input.idempotencyKey,
        input.immutableUrl ?? null,
        JSON.stringify(input.providerMetadata ?? {}),
        input.error ?? null,
      ],
    );
    const rows = await this.sql<DeploymentRow>(
      `${deploymentSelect()}
       WHERE workspace_id = $1 AND project_id = $2 AND idempotency_key = $3`,
      [input.workspaceId, input.projectId, input.idempotencyKey],
    );
    if (!rows[0]) throw new Error("failed to request deployment");
    return fromDeploymentRow(rows[0]);
  }

  async getDeployment(workspaceId: string, deploymentId: string): Promise<Deployment | null> {
    const rows = await this.sql<DeploymentRow>(
      `${deploymentSelect()} WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, deploymentId],
    );
    return rows[0] ? fromDeploymentRow(rows[0]) : null;
  }

  async listDeployments(
    workspaceId: string,
    projectId: string,
    limit = 50,
  ): Promise<Deployment[]> {
    requireListLimit(limit);
    const rows = await this.sql<DeploymentRow>(
      `${deploymentSelect()}
       WHERE workspace_id = $1 AND project_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [workspaceId, projectId, limit],
    );
    return rows.map(fromDeploymentRow);
  }

  async transitionDeployment(
    workspaceId: string,
    deploymentId: string,
    next: DeploymentState,
    patch: Partial<
      Pick<Deployment, "providerDeploymentId" | "immutableUrl" | "providerMetadata" | "error">
    > = {},
  ): Promise<Deployment> {
    const current = await this.getDeployment(workspaceId, deploymentId);
    if (!current) throw new Error(`deployment ${deploymentId} not found`);
    assertDeploymentTransition(current.state, next);
    if (current.state === next && Object.keys(patch).length === 0) return current;
    const rows = await this.sql<DeploymentRow>(
      `UPDATE deployments
       SET state = $4,
           provider_deployment_id = COALESCE($5, provider_deployment_id),
           immutable_url = COALESCE($6, immutable_url),
           provider_metadata = COALESCE($7::jsonb, provider_metadata),
           error = COALESCE($8, error),
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 AND state = $3
       RETURNING id, workspace_id, project_id, snapshot_id, build_id, service,
                 provider, provider_deployment_id, state, idempotency_key,
                 immutable_url, provider_metadata, error, created_at, updated_at`,
      [
        workspaceId,
        deploymentId,
        current.state,
        next,
        patch.providerDeploymentId ?? null,
        patch.immutableUrl ?? null,
        patch.providerMetadata ? JSON.stringify(patch.providerMetadata) : null,
        patch.error ?? null,
      ],
    );
    if (!rows[0]) throw new Error(`deployment ${deploymentId} changed concurrently`);
    return fromDeploymentRow(rows[0]);
  }
}

function buildSelect(): string {
  return `SELECT id, workspace_id, project_id, snapshot_id, service, plan, state,
                 idempotency_key, error, created_at, updated_at
          FROM builds`;
}

function deploymentSelect(): string {
  return `SELECT id, workspace_id, project_id, snapshot_id, build_id, service,
                 provider, provider_deployment_id, state, idempotency_key,
                 immutable_url, provider_metadata, error, created_at, updated_at
          FROM deployments`;
}

function fromBuildRow(row: BuildRow): Build {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    service: row.service,
    plan: json<BuildPlan>(row.plan),
    state: row.state,
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.error ? { error: row.error } : {}),
  };
}

function fromBuildEventRow(row: BuildEventRow): BuildEvent {
  return {
    buildId: row.build_id,
    sequence: Number(row.sequence),
    stream: row.stream,
    message: row.message,
    createdAt: iso(row.created_at),
  };
}

function fromDeploymentRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    service: row.service,
    provider: row.provider,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.build_id ? { buildId: row.build_id } : {}),
    ...(row.provider_deployment_id ? { providerDeploymentId: row.provider_deployment_id } : {}),
    ...(row.immutable_url ? { immutableUrl: row.immutable_url } : {}),
    ...(row.provider_metadata ? { providerMetadata: json(row.provider_metadata) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function requireIdempotencyKey(value: string): void {
  if (!value.trim()) throw new Error("idempotency key is required");
}

function requireListLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("list limit must be between 1 and 100");
  }
}

function json<T = Record<string, unknown>>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

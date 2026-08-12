import {
  InMemoryCloudRepository,
  PostgresCloudRepository,
  createDeployment,
  detectBuildPlans,
  executeBuild,
  refreshDeployment,
  type Build,
  type BuildPlan,
  type CloudRepository,
  type Deployment,
} from "@fabric/cloud";
import {
  InMemoryProjectRepository,
  PostgresProjectRepository,
  type CloudProject,
  type CreateProjectInput,
  type ProjectRepository,
  type ProjectSnapshot,
  type ProjectTemplate,
  type SealSnapshotInput,
  type SourceFile,
  type SourceFileInput,
  projectTemplateFiles,
} from "@fabric/projects";
import { resolveAccess, type ShareRole, type WorkspaceObject } from "@fabric/workspace";
import type { StudioIdentity } from "./auth";
import {
  createStudioDeploymentProvider,
  createStudioSandboxExecutor,
  deploymentProviderConfigured,
  sandboxProviderConfigured,
  shouldRunCloudOperationsInline,
} from "./cloud-providers";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";
import {
  hasDurableQueue,
  publishCloudBuild,
  publishCloudDeployment,
} from "./queue";
import {
  createCloudProjectObject,
  findWorkspaceProjectObject,
  listWorkspaceObjects,
  loadWorkspace,
  publishCloudProjectObject,
} from "./workspace";

declare global {
  // eslint-disable-next-line no-var
  var __fabricProjectRepository: InMemoryProjectRepository | undefined;
  // eslint-disable-next-line no-var
  var __fabricCloudRepository: InMemoryCloudRepository | undefined;
}

export class ControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ProjectResult {
  project: CloudProject;
  object: WorkspaceObject;
  role: ShareRole;
}

export class StudioControlPlane {
  readonly identity: StudioIdentity;
  private readonly projects: ProjectRepository;
  private readonly cloud: CloudRepository;

  constructor(
    identity: StudioIdentity,
    options: { projects?: ProjectRepository; cloud?: CloudRepository } = {},
  ) {
    this.identity = identity;
    this.projects = options.projects ?? getProjectRepository();
    this.cloud = options.cloud ?? getCloudRepository();
  }

  async createProject(
    input: CreateProjectInput & { template?: ProjectTemplate },
  ): Promise<ProjectResult> {
    await loadWorkspace(this.identity.workspaceId, this.identity.id);
    const project = await this.projects.create(this.identity.workspaceId, input);
    const templateFiles = projectTemplateFiles(input.template ?? "empty", project.name);
    if (templateFiles.length > 0) {
      await this.projects.writeFiles(this.identity.workspaceId, project.id, templateFiles);
    }
    const object = await createCloudProjectObject(
      this.identity.workspaceId,
      this.identity.id,
      project.id,
      project.name,
      project.slug,
    );
    return { project, object, role: "owner" };
  }

  async listProjects(): Promise<ProjectResult[]> {
    const [projects, objects] = await Promise.all([
      this.projects.list(this.identity.workspaceId),
      listWorkspaceObjects(this.identity.workspaceId, this.identity.id),
    ]);
    const byProject = new Map(
      objects
        .filter((object) => object.projectId)
        .map((object) => [object.projectId!, object]),
    );
    return projects.flatMap((project) => {
      const object = byProject.get(project.id);
      if (!object) return [];
      const role = resolveAccess(object, { principalId: this.identity.id });
      return role ? [{ project, object, role }] : [];
    });
  }

  async getProject(projectId: string, minimum: ShareRole = "viewer"): Promise<ProjectResult> {
    const object = await findWorkspaceProjectObject(
      this.identity.workspaceId,
      projectId,
      this.identity.id,
    );
    if (!object) throw new ControlPlaneError(404, "not_found", `project ${projectId} not found`);
    const role = resolveAccess(object, { principalId: this.identity.id });
    if (!role || ROLE_RANK[role] < ROLE_RANK[minimum]) {
      throw new ControlPlaneError(403, "forbidden", `${minimum} access required`);
    }
    const project = await this.projects.get(this.identity.workspaceId, projectId);
    if (!project) throw new ControlPlaneError(404, "not_found", `project ${projectId} not found`);
    return { project, object, role };
  }

  async listFiles(projectId: string): Promise<SourceFile[]> {
    await this.getProject(projectId);
    return this.projects.listFiles(this.identity.workspaceId, projectId);
  }

  async writeFiles(projectId: string, files: SourceFileInput[]): Promise<SourceFile[]> {
    await this.getProject(projectId, "editor");
    return this.projects.writeFiles(this.identity.workspaceId, projectId, files);
  }

  async deleteFiles(projectId: string, paths: string[]): Promise<void> {
    await this.getProject(projectId, "editor");
    await this.projects.deleteFiles(this.identity.workspaceId, projectId, paths);
  }

  async sealSnapshot(
    projectId: string,
    input: Omit<SealSnapshotInput, "author"> = {},
  ): Promise<ProjectSnapshot> {
    await this.getProject(projectId, "editor");
    return this.projects.sealSnapshot(this.identity.workspaceId, projectId, {
      ...input,
      author: this.identity.id,
    });
  }

  async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    await this.getProject(projectId);
    return this.projects.listSnapshots(this.identity.workspaceId, projectId);
  }

  async getSnapshot(projectId: string, snapshotId: string): Promise<ProjectSnapshot> {
    await this.getProject(projectId);
    const snapshot = await this.projects.getSnapshot(
      this.identity.workspaceId,
      projectId,
      snapshotId,
    );
    if (!snapshot) {
      throw new ControlPlaneError(404, "not_found", `snapshot ${snapshotId} not found`);
    }
    return snapshot;
  }

  async inspectBuildPlans(projectId: string, snapshotId?: string): Promise<BuildPlan[]> {
    const { project } = await this.getProject(projectId);
    const id = snapshotId ?? project.headSnapshotId;
    if (!id) throw new ControlPlaneError(409, "snapshot_required", "seal a snapshot first");
    const snapshot = await this.getSnapshot(projectId, id);
    return detectBuildPlans(snapshot, project.services);
  }

  async requestBuild(input: {
    projectId: string;
    snapshotId?: string;
    service?: string;
    idempotencyKey: string;
  }): Promise<Build> {
    const { project } = await this.getProject(input.projectId, "editor");
    const inline = !hasDurableQueue() && shouldRunCloudOperationsInline();
    if (!hasDurableQueue() && !inline) {
      throw new ControlPlaneError(
        503,
        "build_dispatch_unavailable",
        "Fabric build dispatch is temporarily unavailable",
      );
    }
    if (inline && !sandboxProviderConfigured()) {
      throw new ControlPlaneError(
        503,
        "build_executor_unavailable",
        "Fabric build execution is temporarily unavailable",
      );
    }
    const snapshotId = input.snapshotId ?? project.headSnapshotId;
    if (!snapshotId) {
      throw new ControlPlaneError(409, "snapshot_required", "seal a snapshot first");
    }
    const snapshot = await this.getSnapshot(input.projectId, snapshotId);
    const service = input.service
      ? project.services.find((candidate) => candidate.name === input.service)
      : project.services[0];
    if (!service) {
      throw new ControlPlaneError(400, "invalid_service", `service ${input.service} not found`);
    }
    const plan = detectBuildPlans(snapshot, [service])[0]!;
    let build = await this.cloud.requestBuild({
      workspaceId: this.identity.workspaceId,
      projectId: input.projectId,
      snapshotId,
      service: service.name,
      plan,
      idempotencyKey: input.idempotencyKey,
    });
    const dispatched = await publishCloudBuild({
      workspaceId: build.workspaceId,
      projectId: build.projectId,
      snapshotId: build.snapshotId,
      buildId: build.id,
    });
    if (!dispatched && inline && build.state === "QUEUED") {
      build = await executeBuild({
        build,
        snapshot,
        repository: this.cloud,
        executor: createStudioSandboxExecutor(),
        limits: {
          timeoutMs: 290_000,
          memoryMb: 2_048,
          cpu: 1,
          network: "restricted",
        },
      });
    }
    return build;
  }

  async getBuild(projectId: string, buildId: string): Promise<Build> {
    await this.getProject(projectId);
    const build = await this.cloud.getBuild(this.identity.workspaceId, buildId);
    if (!build || build.projectId !== projectId) {
      throw new ControlPlaneError(404, "not_found", `build ${buildId} not found`);
    }
    return build;
  }

  async listBuilds(projectId: string, limit = 25): Promise<Build[]> {
    await this.getProject(projectId);
    return this.cloud.listBuilds(this.identity.workspaceId, projectId, limit);
  }

  async listBuildEvents(
    projectId: string,
    buildId: string,
    afterSequence = 0,
    limit = 100,
  ) {
    await this.getBuild(projectId, buildId);
    return this.cloud.listBuildEvents(
      this.identity.workspaceId,
      buildId,
      afterSequence,
      limit,
    );
  }

  async requestDeployment(input: {
    projectId: string;
    buildId: string;
    idempotencyKey: string;
  }): Promise<Deployment> {
    await this.getProject(input.projectId, "editor");
    if (!deploymentProviderConfigured()) {
      throw new ControlPlaneError(
        503,
        "deployment_provider_unavailable",
        "Fabric deployment is temporarily unavailable",
      );
    }
    const inline = !hasDurableQueue() && shouldRunCloudOperationsInline();
    if (!hasDurableQueue() && !inline) {
      throw new ControlPlaneError(
        503,
        "deployment_dispatch_unavailable",
        "Fabric deployment dispatch is temporarily unavailable",
      );
    }
    const build = await this.getBuild(input.projectId, input.buildId);
    if (build.state !== "SUCCEEDED") {
      throw new ControlPlaneError(
        409,
        "build_not_ready",
        "A deployment requires a successful build",
      );
    }
    let deployment = await this.cloud.requestDeployment({
      workspaceId: this.identity.workspaceId,
      projectId: input.projectId,
      snapshotId: build.snapshotId,
      buildId: build.id,
      service: build.service,
      provider: "vercel-web",
      idempotencyKey: input.idempotencyKey,
    });
    const dispatched = await publishCloudDeployment({
      workspaceId: deployment.workspaceId,
      projectId: deployment.projectId,
      snapshotId: deployment.snapshotId,
      buildId: build.id,
      deploymentId: deployment.id,
      idempotencyKey: deployment.idempotencyKey,
    });
    if (!dispatched && inline && deployment.state === "QUEUED") {
      const snapshot = await this.getSnapshot(input.projectId, build.snapshotId);
      deployment = await createDeployment({
        build,
        snapshot,
        repository: this.cloud,
        providers: [createStudioDeploymentProvider()],
        idempotencyKey: deployment.idempotencyKey,
      });
    }
    return deployment;
  }

  async getDeployment(projectId: string, deploymentId: string): Promise<Deployment> {
    await this.getProject(projectId);
    let deployment = await this.cloud.getDeployment(
      this.identity.workspaceId,
      deploymentId,
    );
    if (!deployment || deployment.projectId !== projectId) {
      throw new ControlPlaneError(
        404,
        "not_found",
        `deployment ${deploymentId} not found`,
      );
    }
    if (
      deployment.state === "BUILDING" &&
      deployment.providerDeploymentId &&
      deploymentProviderConfigured()
    ) {
      deployment = await refreshDeployment({
        deployment,
        repository: this.cloud,
        provider: createStudioDeploymentProvider(),
      });
    }
    if (deployment.state === "READY") {
      await this.projects.setActiveDeployment(
        this.identity.workspaceId,
        projectId,
        deployment.id,
      );
    }
    return deployment;
  }

  async listDeployments(projectId: string, limit = 25): Promise<Deployment[]> {
    await this.getProject(projectId);
    const deployments = await this.cloud.listDeployments(
      this.identity.workspaceId,
      projectId,
      limit,
    );
    return Promise.all(
      deployments.map((deployment) =>
        deployment.state === "BUILDING"
          ? this.getDeployment(projectId, deployment.id)
          : deployment,
      ),
    );
  }

  async publishProject(
    projectId: string,
    deploymentId: string,
  ): Promise<{ projectId: string; deploymentId: string; shareToken: string }> {
    await this.getProject(projectId, "owner");
    const deployment = await this.getDeployment(projectId, deploymentId);
    if (deployment.state !== "READY") {
      throw new ControlPlaneError(
        409,
        "deployment_not_ready",
        "Wait for the Fabric deployment to become ready before publishing",
      );
    }
    await this.projects.setActiveDeployment(
      this.identity.workspaceId,
      projectId,
      deployment.id,
    );
    const object = await publishCloudProjectObject(
      this.identity.workspaceId,
      this.identity.id,
      projectId,
    );
    return {
      projectId,
      deploymentId,
      shareToken: object.shareToken,
    };
  }
}

export function controlPlaneProblem(
  error: unknown,
  context: { route?: string; requestId?: string | null } = {},
): Response {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Fabric control-plane request failed",
      route: context.route,
      requestId: context.requestId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (error instanceof ControlPlaneError) {
    return Response.json(
      { ok: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /already exists|slug/i.test(message) ? 409 : 400;
  return Response.json({ ok: false, code: "invalid_request", error: message }, { status });
}

export function getProjectRepository(): ProjectRepository {
  if (hasDurableDatabase()) return new PostgresProjectRepository(getDatabaseExecutor());
  globalThis.__fabricProjectRepository ??= new InMemoryProjectRepository();
  return globalThis.__fabricProjectRepository;
}

export function getCloudRepository(): CloudRepository {
  if (hasDurableDatabase()) return new PostgresCloudRepository(getDatabaseExecutor());
  globalThis.__fabricCloudRepository ??= new InMemoryCloudRepository();
  return globalThis.__fabricCloudRepository;
}

const ROLE_RANK: Record<ShareRole, number> = { viewer: 1, editor: 2, owner: 3 };

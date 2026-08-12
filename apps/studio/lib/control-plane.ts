import {
  InMemoryCloudRepository,
  PostgresCloudRepository,
  createDeployment,
  detectBuildPlans,
  effectiveExecutionPolicy,
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
  type ManifestSource,
  type ApplicationManifest,
  applicationManifestFromFiles,
  createSnapshot,
  inferredApplicationManifest,
  inspectLogicalSchema,
  manifestProjectServices,
  parseApplicationManifest,
  planSchemaMigration,
  projectTemplateFiles,
  serializeApplicationManifest,
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
  claimWorkspaceQuota,
  fabricExecutionPolicy,
  projectCloudUsage,
  projectSuspensionStatus,
  setProjectSuspended,
  workspaceCloudStatus,
} from "./cloud-policy";
import {
  approveSchemaMigration,
  getSchemaMigrationReview,
  listSchemaMigrationReviews,
  recordSchemaMigrationSealed,
} from "./schema-migrations";
import {
  executeSchemaMigration,
  listSchemaMigrationRuns,
  rollbackSchemaMigration,
} from "./schema-migration-executor";
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
    const templateFiles = [
      ...projectTemplateFiles(input.template ?? "empty", project.name),
      {
        path: "fabric.json",
        content: serializeApplicationManifest(
          inferredApplicationManifest(project.name, project.services),
        ),
        encoding: "utf8" as const,
      },
    ];
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
    const { project } = await this.getProject(projectId, "editor");
    const files = await this.projects.listFiles(this.identity.workspaceId, projectId);
    const desiredManifest = applicationManifestFromFiles(files, {
      name: project.name,
      services: project.services,
    });
    const baselineSnapshot = project.headSnapshotId
      ? await this.getSnapshot(projectId, project.headSnapshotId)
      : undefined;
    const baselineManifest = baselineSnapshot
      ? applicationManifestFromFiles(baselineSnapshot.files, {
          name: project.name,
          services: project.services,
        })
      : undefined;
    const schemaPlan = planSchemaMigration(
      baselineManifest?.manifest.spec.data,
      desiredManifest.manifest.spec.data,
    );
    if (schemaPlan.approvalRequired) {
      const review = await getSchemaMigrationReview(
        this.identity.workspaceId,
        projectId,
        schemaPlan.id,
      );
      if (!review || review.state !== "approved") {
        throw new ControlPlaneError(
          409,
          "schema_approval_required",
          `destructive schema migration ${schemaPlan.id} requires owner approval`,
        );
      }
    }
    const preview = createSnapshot({
      workspaceId: this.identity.workspaceId,
      projectId,
      files,
      parentId: input.parentId ?? project.headSnapshotId,
      author: this.identity.id,
      message: input.message,
    });
    await this.claimQuota({
      projectId,
      operation: "snapshot",
      units: preview.files.reduce((total, file) => total + file.size, 0),
      idempotencyKey: preview.id,
    });
    const snapshot = await this.projects.sealSnapshot(this.identity.workspaceId, projectId, {
      ...input,
      author: this.identity.id,
    });
    if (schemaPlan.changes.length > 0) {
      await recordSchemaMigrationSealed({
        workspaceId: this.identity.workspaceId,
        projectId,
        plan: schemaPlan,
        snapshotId: snapshot.id,
        principalId: this.identity.id,
      });
    }
    return snapshot;
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
    const manifest = applicationManifestFromFiles(snapshot.files, {
      name: project.name,
      services: project.services,
    });
    return detectBuildPlans(snapshot, manifestProjectServices(manifest.manifest));
  }

  async getApplicationManifest(
    projectId: string,
    snapshotId?: string,
  ): Promise<ManifestSource & { snapshotId?: string }> {
    const { project } = await this.getProject(projectId);
    const files = snapshotId
      ? (await this.getSnapshot(projectId, snapshotId)).files
      : await this.projects.listFiles(this.identity.workspaceId, projectId);
    return {
      ...applicationManifestFromFiles(files, {
        name: project.name,
        services: project.services,
      }),
      ...(snapshotId ? { snapshotId } : {}),
    };
  }

  async writeApplicationManifest(
    projectId: string,
    manifest: unknown,
  ): Promise<ManifestSource> {
    await this.getProject(projectId, "editor");
    const validated = parseApplicationManifest(manifest);
    await this.projects.writeFiles(this.identity.workspaceId, projectId, [
      {
        path: "fabric.json",
        content: serializeApplicationManifest(validated),
        encoding: "utf8",
      },
    ]);
    return {
      manifest: validated as ApplicationManifest,
      source: "declared",
      path: "fabric.json",
    };
  }

  async inspectApplicationSchema(projectId: string, snapshotId?: string) {
    const source = await this.getApplicationManifest(projectId, snapshotId);
    return {
      projectId,
      snapshotId: source.snapshotId,
      source: source.source,
      schema: inspectLogicalSchema(source.manifest.spec.data),
    };
  }

  async previewSchemaMigration(projectId: string, baselineSnapshotId?: string) {
    const { project } = await this.getProject(projectId);
    const baselineId = baselineSnapshotId ?? project.headSnapshotId;
    const [current, desired] = await Promise.all([
      baselineId
        ? this.getApplicationManifest(projectId, baselineId)
        : Promise.resolve(undefined),
      this.getApplicationManifest(projectId),
    ]);
    const currentSchema = inspectLogicalSchema(current?.manifest.spec.data);
    const desiredSchema = inspectLogicalSchema(desired.manifest.spec.data);
    const plan = planSchemaMigration(
      current?.manifest.spec.data,
      desired.manifest.spec.data,
    );
    const review = plan.approvalRequired
      ? await getSchemaMigrationReview(
          this.identity.workspaceId,
          projectId,
          plan.id,
        )
      : null;
    return {
      projectId,
      baselineSnapshotId: baselineId,
      current: currentSchema,
      desired: desiredSchema,
      plan,
      approved: review?.state === "approved",
      review,
    };
  }

  async approveSchemaMigration(
    projectId: string,
    planId: string,
    reason?: string,
  ) {
    await this.getProject(projectId, "owner");
    const preview = await this.previewSchemaMigration(projectId);
    if (preview.plan.id !== planId) {
      throw new ControlPlaneError(
        409,
        "schema_plan_changed",
        "schema changed after this migration preview; inspect it again",
      );
    }
    try {
      await approveSchemaMigration({
        workspaceId: this.identity.workspaceId,
        projectId,
        plan: preview.plan,
        principalId: this.identity.id,
        reason,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "schema_approval_not_required") {
        throw new ControlPlaneError(
          409,
          "schema_approval_not_required",
          "this schema migration does not require explicit approval",
        );
      }
      throw error;
    }
    return this.previewSchemaMigration(projectId);
  }

  async listSchemaMigrations(projectId: string) {
    await this.getProject(projectId);
    const [reviews, runs] = await Promise.all([
      listSchemaMigrationReviews(this.identity.workspaceId, projectId),
      listSchemaMigrationRuns(this.identity.workspaceId, projectId),
    ]);
    return { reviews, runs };
  }

  async applySchemaMigration(projectId: string, planId: string) {
    await this.getProject(projectId, "owner");
    const review = await getSchemaMigrationReview(
      this.identity.workspaceId,
      projectId,
      planId,
    );
    if (!review || review.state !== "sealed" || !review.sealedSnapshotId) {
      throw new ControlPlaneError(
        409,
        "schema_migration_not_sealed",
        "seal the reviewed schema migration before applying it",
      );
    }
    const targetSnapshot = await this.getSnapshot(
      projectId,
      review.sealedSnapshotId,
    );
    const [target, baseline] = await Promise.all([
      this.getApplicationManifest(projectId, review.sealedSnapshotId),
      targetSnapshot.parentId
        ? this.getApplicationManifest(projectId, targetSnapshot.parentId)
        : Promise.resolve(undefined),
    ]);
    return executeSchemaMigration({
      workspaceId: this.identity.workspaceId,
      projectId,
      targetSnapshotId: review.sealedSnapshotId,
      plan: review.plan,
      backupSchema: inspectLogicalSchema(baseline?.manifest.spec.data),
      desiredSchema: inspectLogicalSchema(target.manifest.spec.data),
      principalId: this.identity.id,
    });
  }

  async rollbackSchemaMigration(projectId: string, runId: string) {
    await this.getProject(projectId, "owner");
    try {
      return await rollbackSchemaMigration({
        workspaceId: this.identity.workspaceId,
        projectId,
        runId,
        principalId: this.identity.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found")) {
        throw new ControlPlaneError(404, "not_found", message);
      }
      throw new ControlPlaneError(409, "schema_rollback_unavailable", message);
    }
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
    const manifest = applicationManifestFromFiles(snapshot.files, {
      name: project.name,
      services: project.services,
    }).manifest;
    const services = manifestProjectServices(manifest);
    const service = input.service
      ? services.find((candidate) => candidate.name === input.service)
      : services[0];
    if (!service) {
      throw new ControlPlaneError(400, "invalid_service", `service ${input.service} not found`);
    }
    const plan = detectBuildPlans(snapshot, [service])[0]!;
    await this.claimQuota({
      projectId: input.projectId,
      operation: "build",
      idempotencyKey: input.idempotencyKey,
      metadata: { snapshotId, service: service.name },
      policy: effectiveExecutionPolicy(
        fabricExecutionPolicy(),
        manifest.spec.policies,
      ),
    });
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
        limits: fabricExecutionPolicy().build,
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
    const { project } = await this.getProject(input.projectId, "editor");
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
    const [schemaReviews, schemaRuns] = await Promise.all([
      listSchemaMigrationReviews(this.identity.workspaceId, input.projectId),
      listSchemaMigrationRuns(this.identity.workspaceId, input.projectId),
    ]);
    const schemaReview = schemaReviews.find(
      (review) =>
        review.sealedSnapshotId === build.snapshotId &&
        review.plan.changes.length > 0,
    );
    if (
      schemaReview &&
      !schemaRuns.some(
        (run) =>
          run.planId === schemaReview.planId &&
          run.targetSnapshotId === build.snapshotId &&
          run.state === "succeeded",
      )
    ) {
      throw new ControlPlaneError(
        409,
        "schema_migration_required",
        `apply schema migration ${schemaReview.planId} before deployment`,
      );
    }
    const snapshot = await this.getSnapshot(input.projectId, build.snapshotId);
    const deploymentPolicy = effectiveExecutionPolicy(
      fabricExecutionPolicy(),
      applicationManifestFromFiles(snapshot.files, {
        name: project.name,
        services: project.services,
      }).manifest.spec.policies,
    );
    await this.claimQuota({
      projectId: input.projectId,
      operation: "deployment",
      idempotencyKey: input.idempotencyKey,
      metadata: { buildId: build.id, snapshotId: build.snapshotId },
      policy: deploymentPolicy,
    });
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
      deployment = await createDeployment({
        build,
        snapshot,
        repository: this.cloud,
        providers: [createStudioDeploymentProvider(deploymentPolicy.runtime)],
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

  async getProjectCloudStatus(projectId: string) {
    await this.getProject(projectId);
    const [workspace, project, manifest, usage] = await Promise.all([
      workspaceCloudStatus(this.identity.workspaceId),
      projectSuspensionStatus(this.identity.workspaceId, projectId),
      this.getApplicationManifest(projectId),
      projectCloudUsage(this.identity.workspaceId, projectId),
    ]);
    return {
      ...workspace,
      policy: effectiveExecutionPolicy(
        workspace.policy,
        manifest.manifest.spec.policies,
      ),
      usage,
      projectSuspended: project.suspended,
      projectReason: project.reason,
    };
  }

  async suspendProject(
    projectId: string,
    suspended: boolean,
    reason?: string,
  ) {
    await this.getProject(projectId, "owner");
    await setProjectSuspended({
      workspaceId: this.identity.workspaceId,
      projectId,
      suspended,
      principalId: this.identity.id,
      reason,
    });
    if (suspended) {
      const [builds, deployments] = await Promise.all([
        this.cloud.listBuilds(this.identity.workspaceId, projectId, 100),
        this.cloud.listDeployments(this.identity.workspaceId, projectId, 100),
      ]);
      await Promise.all(
        builds
          .filter((build) => build.state === "QUEUED" || build.state === "RUNNING")
          .map((build) =>
            this.cloud.transitionBuild(
              this.identity.workspaceId,
              build.id,
              "CANCELLED",
              "Project suspended by owner",
            ),
          ),
      );
      for (const deployment of deployments) {
        if (
          deployment.state !== "QUEUED" &&
          deployment.state !== "BUILDING"
        ) {
          continue;
        }
        if (
          deployment.state === "BUILDING" &&
          deployment.providerDeploymentId &&
          deploymentProviderConfigured()
        ) {
          await createStudioDeploymentProvider()
            .cancel(deployment.providerDeploymentId)
            .catch((error) => {
              console.error(
                JSON.stringify({
                  level: "error",
                  message: "Fabric provider cancellation failed",
                  deploymentId: deployment.id,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            });
        }
        await this.cloud.transitionDeployment(
          this.identity.workspaceId,
          deployment.id,
          "CANCELLED",
          { error: "Project suspended by owner" },
        );
      }
    }
    return this.getProjectCloudStatus(projectId);
  }

  private async claimQuota(input: {
    projectId: string;
    operation: "build" | "deployment" | "snapshot";
    units?: number;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    policy?: ReturnType<typeof fabricExecutionPolicy>;
  }) {
    try {
      return await claimWorkspaceQuota({
        workspaceId: this.identity.workspaceId,
        ...input,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("quota_exceeded:")) {
        throw new ControlPlaneError(429, "quota_exceeded", message.slice(16).trim());
      }
      if (
        message.startsWith("workspace_suspended:") ||
        message.startsWith("project_suspended:")
      ) {
        throw new ControlPlaneError(423, "project_suspended", message.split(":").slice(1).join(":").trim());
      }
      throw error;
    }
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

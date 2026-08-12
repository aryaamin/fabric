import type { ProjectSnapshot } from "@fabric/projects";
import {
  selectDeploymentProvider,
  type Build,
  type CloudRepository,
  type Deployment,
  type DeploymentProvider,
  type ExecutionLimits,
  type ExecutionProvider,
} from "./index.ts";

export async function executeBuild(input: {
  build: Build;
  snapshot: ProjectSnapshot;
  repository: CloudRepository;
  executor: ExecutionProvider;
  limits: ExecutionLimits;
  signal?: AbortSignal;
}): Promise<Build> {
  const { build, snapshot, repository, executor } = input;
  if (build.snapshotId !== snapshot.id || build.projectId !== snapshot.projectId) {
    throw new Error("build snapshot does not match request");
  }
  let running = await repository.transitionBuild(build.workspaceId, build.id, "RUNNING");
  await repository.appendBuildEvent(build.workspaceId, build.id, {
    stream: "system",
    message: `executor=${executor.name} runtime=${build.plan.runtime}`,
  });
  try {
    const execution = await executor.execute({
      snapshot,
      plan: build.plan,
      limits: input.limits,
      signal: input.signal,
      onEvent: async (event) => {
        await repository.appendBuildEvent(build.workspaceId, build.id, event);
      },
    });
    if (execution.exitCode !== 0) {
      running = await repository.transitionBuild(
        build.workspaceId,
        build.id,
        "FAILED",
        `executor exited with code ${execution.exitCode}`,
      );
    } else {
      running = await repository.transitionBuild(build.workspaceId, build.id, "SUCCEEDED");
    }
    return running;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.appendBuildEvent(build.workspaceId, build.id, {
      stream: "stderr",
      message,
    });
    return repository.transitionBuild(build.workspaceId, build.id, "FAILED", message);
  }
}

export async function createDeployment(input: {
  build: Build;
  snapshot: ProjectSnapshot;
  repository: CloudRepository;
  providers: DeploymentProvider[];
  environment?: Record<string, string>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<Deployment> {
  if (input.build.state !== "SUCCEEDED") throw new Error("deployment requires a successful build");
  if (
    input.build.snapshotId !== input.snapshot.id ||
    input.build.projectId !== input.snapshot.projectId
  ) {
    throw new Error("deployment snapshot does not match build");
  }
  const provider = selectDeploymentProvider(input.providers, input.build.plan);
  let deployment = await input.repository.requestDeployment({
    workspaceId: input.build.workspaceId,
    projectId: input.build.projectId,
    snapshotId: input.snapshot.id,
    buildId: input.build.id,
    service: input.build.service,
    provider: provider.name,
    idempotencyKey: input.idempotencyKey,
  });
  if (deployment.state !== "QUEUED") return deployment;
  deployment = await input.repository.transitionDeployment(
    deployment.workspaceId,
    deployment.id,
    "BUILDING",
  );
  try {
    const handle = await provider.create({
      projectId: deployment.projectId,
      snapshot: input.snapshot,
      plan: input.build.plan,
      environment: input.environment ?? {},
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    });
    if (handle.status === "ERROR" || handle.status === "CANCELLED") {
      return input.repository.transitionDeployment(
        deployment.workspaceId,
        deployment.id,
        handle.status,
        {
          providerDeploymentId: handle.providerDeploymentId,
          providerMetadata: handle.providerMetadata,
          error: `provider returned ${handle.status}`,
        },
      );
    }
    if (handle.status === "READY") {
      return input.repository.transitionDeployment(
        deployment.workspaceId,
        deployment.id,
        "READY",
        {
          providerDeploymentId: handle.providerDeploymentId,
          immutableUrl: handle.immutableUrl,
          providerMetadata: handle.providerMetadata,
        },
      );
    }
    return input.repository.transitionDeployment(
      deployment.workspaceId,
      deployment.id,
      "BUILDING",
      {
        providerDeploymentId: handle.providerDeploymentId,
        immutableUrl: handle.immutableUrl,
        providerMetadata: handle.providerMetadata,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return input.repository.transitionDeployment(
      deployment.workspaceId,
      deployment.id,
      "ERROR",
      { error: message },
    );
  }
}

export async function refreshDeployment(input: {
  deployment: Deployment;
  repository: CloudRepository;
  provider: DeploymentProvider;
  signal?: AbortSignal;
}): Promise<Deployment> {
  if (input.deployment.state !== "BUILDING") return input.deployment;
  if (!input.deployment.providerDeploymentId) {
    throw new Error("provider deployment id is missing");
  }
  const handle = await input.provider.inspect(input.deployment.providerDeploymentId, input.signal);
  if (handle.status === "QUEUED" || handle.status === "BUILDING") return input.deployment;
  return input.repository.transitionDeployment(
    input.deployment.workspaceId,
    input.deployment.id,
    handle.status,
    {
      providerDeploymentId: handle.providerDeploymentId,
      immutableUrl: handle.immutableUrl,
      providerMetadata: handle.providerMetadata,
      ...(handle.status === "ERROR" ? { error: "provider deployment failed" } : {}),
    },
  );
}

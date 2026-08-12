import { randomUUID } from "node:crypto";
import type { ProjectService, ProjectSnapshot } from "@fabric/projects";

/** Provider-neutral build and deployment contracts for Fabric Cloud. */

export type SupportedRuntime = "nodejs" | "python" | "go";
export type WorkloadKind = "static" | "function" | "service" | "worker" | "cron";
export type NetworkProtocol = "http" | "websocket" | "tcp";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface BuildPlan {
  schemaVersion: 1;
  service: string;
  runtime: SupportedRuntime;
  runtimeVersion?: string;
  framework?: string;
  packageManager?: string;
  install?: CommandSpec;
  build?: CommandSpec;
  start?: CommandSpec;
  output: {
    kind: WorkloadKind;
    directory?: string;
  };
  requirements: {
    protocols: NetworkProtocol[];
    longLived: boolean;
    background: boolean;
  };
}

export interface RuntimeDetector {
  readonly runtime: SupportedRuntime;
  detect(snapshot: ProjectSnapshot, service: ProjectService): BuildPlan | null;
}

export interface ExecutionLimits {
  timeoutMs: number;
  memoryMb: number;
  cpu: number;
  network: "none" | "restricted";
}

export interface ExecutionResult {
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  artifactRef?: string;
}

export interface ExecutionProvider {
  readonly name: string;
  execute(input: {
    snapshot: ProjectSnapshot;
    plan: BuildPlan;
    limits: ExecutionLimits;
    signal?: AbortSignal;
    onEvent?: (event: Omit<BuildEvent, "buildId" | "sequence" | "createdAt">) => Promise<void>;
  }): Promise<ExecutionResult>;
}

export interface ProviderCapabilities {
  runtimes: SupportedRuntime[];
  workloads: WorkloadKind[];
  protocols: NetworkProtocol[];
  longLived: boolean;
  background: boolean;
}

export interface DeploymentHandle {
  providerDeploymentId: string;
  status: DeploymentState;
  immutableUrl?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface DeploymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  create(input: {
    projectId: string;
    snapshot: ProjectSnapshot;
    plan: BuildPlan;
    environment: Record<string, string>;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<DeploymentHandle>;
  inspect(providerDeploymentId: string, signal?: AbortSignal): Promise<DeploymentHandle>;
  cancel(providerDeploymentId: string, signal?: AbortSignal): Promise<void>;
}

export type ResourceKind =
  | "relational_database"
  | "object_storage"
  | "key_value"
  | "durable_queue"
  | "secret";

export interface ResourceSpec {
  id: string;
  projectId: string;
  name: string;
  kind: ResourceKind;
  plan?: string;
  region?: string;
  configuration?: Record<string, unknown>;
}

export interface ResourceBinding {
  id: string;
  resourceId: string;
  projectId: string;
  provider: string;
  status: "provisioning" | "ready" | "error" | "revoked";
  environment: Record<string, string>;
  secretReferences: Record<string, string>;
  providerMetadata?: Record<string, unknown>;
}

export interface ResourceProvider {
  readonly name: string;
  readonly kinds: ResourceKind[];
  provision(spec: ResourceSpec, signal?: AbortSignal): Promise<ResourceBinding>;
  revoke(binding: ResourceBinding, signal?: AbortSignal): Promise<void>;
}

export type BuildState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type DeploymentState = "QUEUED" | "BUILDING" | "READY" | "ERROR" | "CANCELLED";

export interface Build {
  id: string;
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  service: string;
  plan: BuildPlan;
  state: BuildState;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface BuildEvent {
  buildId: string;
  sequence: number;
  stream: "system" | "stdout" | "stderr";
  message: string;
  createdAt: string;
}

export interface Deployment {
  id: string;
  workspaceId: string;
  projectId: string;
  snapshotId: string;
  buildId?: string;
  service: string;
  provider: string;
  providerDeploymentId?: string;
  state: DeploymentState;
  idempotencyKey: string;
  immutableUrl?: string;
  providerMetadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface CloudRepository {
  requestBuild(input: Omit<Build, "id" | "state" | "createdAt" | "updatedAt">): Promise<Build>;
  getBuild(workspaceId: string, buildId: string): Promise<Build | null>;
  listBuilds(workspaceId: string, projectId: string, limit?: number): Promise<Build[]>;
  transitionBuild(
    workspaceId: string,
    buildId: string,
    next: BuildState,
    error?: string,
  ): Promise<Build>;
  appendBuildEvent(
    workspaceId: string,
    buildId: string,
    event: Omit<BuildEvent, "buildId" | "sequence" | "createdAt">,
  ): Promise<BuildEvent>;
  listBuildEvents(
    workspaceId: string,
    buildId: string,
    afterSequence?: number,
    limit?: number,
  ): Promise<BuildEvent[]>;
  requestDeployment(
    input: Omit<Deployment, "id" | "state" | "createdAt" | "updatedAt">,
  ): Promise<Deployment>;
  getDeployment(workspaceId: string, deploymentId: string): Promise<Deployment | null>;
  listDeployments(
    workspaceId: string,
    projectId: string,
    limit?: number,
  ): Promise<Deployment[]>;
  transitionDeployment(
    workspaceId: string,
    deploymentId: string,
    next: DeploymentState,
    patch?: Partial<
      Pick<
        Deployment,
        "providerDeploymentId" | "immutableUrl" | "providerMetadata" | "error"
      >
    >,
  ): Promise<Deployment>;
}

export class InMemoryCloudRepository implements CloudRepository {
  private readonly builds = new Map<string, Build>();
  private readonly buildKeys = new Map<string, string>();
  private readonly events = new Map<string, BuildEvent[]>();
  private readonly deployments = new Map<string, Deployment>();
  private readonly deploymentKeys = new Map<string, string>();

  async requestBuild(
    input: Omit<Build, "id" | "state" | "createdAt" | "updatedAt">,
  ): Promise<Build> {
    const key = operationKey(input.workspaceId, input.projectId, input.idempotencyKey);
    const existingId = this.buildKeys.get(key);
    if (existingId) return clone(this.builds.get(recordKey(input.workspaceId, existingId))!);
    const now = new Date().toISOString();
    const build: Build = {
      ...clone(input),
      id: `bld_${randomUUID()}`,
      state: "QUEUED",
      createdAt: now,
      updatedAt: now,
    };
    this.builds.set(recordKey(input.workspaceId, build.id), build);
    this.buildKeys.set(key, build.id);
    return clone(build);
  }

  async getBuild(workspaceId: string, buildId: string): Promise<Build | null> {
    const build = this.builds.get(recordKey(workspaceId, buildId));
    return build ? clone(build) : null;
  }

  async listBuilds(workspaceId: string, projectId: string, limit = 50): Promise<Build[]> {
    return [...this.builds.values()]
      .filter((build) => build.workspaceId === workspaceId && build.projectId === projectId)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async transitionBuild(
    workspaceId: string,
    buildId: string,
    next: BuildState,
    error?: string,
  ): Promise<Build> {
    const key = recordKey(workspaceId, buildId);
    const build = this.builds.get(key);
    if (!build) throw new Error(`build ${buildId} not found`);
    assertBuildTransition(build.state, next);
    build.state = next;
    build.updatedAt = new Date().toISOString();
    if (error) build.error = error;
    this.builds.set(key, build);
    return clone(build);
  }

  async appendBuildEvent(
    workspaceId: string,
    buildId: string,
    event: Omit<BuildEvent, "buildId" | "sequence" | "createdAt">,
  ): Promise<BuildEvent> {
    if (!(await this.getBuild(workspaceId, buildId))) throw new Error(`build ${buildId} not found`);
    const key = recordKey(workspaceId, buildId);
    const events = this.events.get(key) ?? [];
    const persisted: BuildEvent = {
      ...event,
      buildId,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      createdAt: new Date().toISOString(),
    };
    events.push(persisted);
    this.events.set(key, events);
    return clone(persisted);
  }

  async listBuildEvents(
    workspaceId: string,
    buildId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<BuildEvent[]> {
    if (limit < 1 || limit > 1_000) throw new Error("event limit must be between 1 and 1000");
    return (this.events.get(recordKey(workspaceId, buildId)) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit)
      .map(clone);
  }

  async requestDeployment(
    input: Omit<Deployment, "id" | "state" | "createdAt" | "updatedAt">,
  ): Promise<Deployment> {
    const key = operationKey(input.workspaceId, input.projectId, input.idempotencyKey);
    const existingId = this.deploymentKeys.get(key);
    if (existingId) {
      return clone(this.deployments.get(recordKey(input.workspaceId, existingId))!);
    }
    const now = new Date().toISOString();
    const deployment: Deployment = {
      ...clone(input),
      id: `dep_${randomUUID()}`,
      state: "QUEUED",
      createdAt: now,
      updatedAt: now,
    };
    this.deployments.set(recordKey(input.workspaceId, deployment.id), deployment);
    this.deploymentKeys.set(key, deployment.id);
    return clone(deployment);
  }

  async getDeployment(workspaceId: string, deploymentId: string): Promise<Deployment | null> {
    const deployment = this.deployments.get(recordKey(workspaceId, deploymentId));
    return deployment ? clone(deployment) : null;
  }

  async listDeployments(
    workspaceId: string,
    projectId: string,
    limit = 50,
  ): Promise<Deployment[]> {
    return [...this.deployments.values()]
      .filter(
        (deployment) =>
          deployment.workspaceId === workspaceId && deployment.projectId === projectId,
      )
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async transitionDeployment(
    workspaceId: string,
    deploymentId: string,
    next: DeploymentState,
    patch: Partial<
      Pick<Deployment, "providerDeploymentId" | "immutableUrl" | "providerMetadata" | "error">
    > = {},
  ): Promise<Deployment> {
    const key = recordKey(workspaceId, deploymentId);
    const deployment = this.deployments.get(key);
    if (!deployment) throw new Error(`deployment ${deploymentId} not found`);
    assertDeploymentTransition(deployment.state, next);
    Object.assign(deployment, clone(patch), { state: next, updatedAt: new Date().toISOString() });
    this.deployments.set(key, deployment);
    return clone(deployment);
  }
}

const BUILD_TRANSITIONS: Record<BuildState, readonly BuildState[]> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

const DEPLOYMENT_TRANSITIONS: Record<DeploymentState, readonly DeploymentState[]> = {
  QUEUED: ["BUILDING", "CANCELLED", "ERROR"],
  BUILDING: ["READY", "ERROR", "CANCELLED"],
  READY: [],
  ERROR: [],
  CANCELLED: [],
};

export function assertBuildTransition(current: BuildState, next: BuildState): void {
  if (current === next) return;
  if (!BUILD_TRANSITIONS[current].includes(next)) {
    throw new Error(`invalid build transition ${current} -> ${next}`);
  }
}

export function assertDeploymentTransition(
  current: DeploymentState,
  next: DeploymentState,
): void {
  if (current === next) return;
  if (!DEPLOYMENT_TRANSITIONS[current].includes(next)) {
    throw new Error(`invalid deployment transition ${current} -> ${next}`);
  }
}

export function providerSupports(provider: DeploymentProvider, plan: BuildPlan): boolean {
  const capabilities = provider.capabilities;
  return (
    capabilities.runtimes.includes(plan.runtime) &&
    capabilities.workloads.includes(plan.output.kind) &&
    plan.requirements.protocols.every((protocol) => capabilities.protocols.includes(protocol)) &&
    (!plan.requirements.longLived || capabilities.longLived) &&
    (!plan.requirements.background || capabilities.background)
  );
}

export function selectDeploymentProvider(
  providers: DeploymentProvider[],
  plan: BuildPlan,
): DeploymentProvider {
  const provider = providers.find((candidate) => providerSupports(candidate, plan));
  if (!provider) {
    throw new Error(
      `provider_capability_mismatch: no provider supports ${plan.runtime}/${plan.output.kind}`,
    );
  }
  return provider;
}

function operationKey(workspaceId: string, projectId: string, idempotencyKey: string): string {
  if (!idempotencyKey.trim()) throw new Error("idempotency key is required");
  return `${workspaceId}\0${projectId}\0${idempotencyKey}`;
}

function recordKey(workspaceId: string, id: string): string {
  return `${workspaceId}\0${id}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export * from "./detectors.ts";
export * from "./pipeline.ts";
export * from "./repository.ts";

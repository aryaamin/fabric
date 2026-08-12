import { createHash, randomUUID } from "node:crypto";
import {
  FABRIC_MANIFEST_PATH,
  parseApplicationManifest,
} from "./manifest.ts";

export * from "./templates.ts";
export * from "./manifest.ts";
export * from "./schema.ts";
export * from "./schema-execution.ts";

/**
 * Provider-neutral source project model.
 *
 * Source files become immutable snapshots before any build or deployment can
 * observe them. The working tree is intentionally separate so agents can make
 * several edits and then seal one atomic version.
 */

export type ProjectMode = "source" | "fabric_ir";
export type ServiceKind = "web" | "worker" | "cron";
export type RuntimeHint = "auto" | "nodejs" | "python" | "go";

export interface ProjectService {
  name: string;
  kind: ServiceKind;
  root: string;
  runtime: RuntimeHint;
  buildCommand?: string[];
  startCommand?: string[];
  healthCheckPath?: string;
}

export interface CloudProject {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  mode: ProjectMode;
  services: ProjectService[];
  headSnapshotId?: string;
  activeDeploymentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  id?: string;
  name: string;
  slug?: string;
  mode?: ProjectMode;
  services?: ProjectService[];
}

export interface SourceFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  executable: boolean;
}

export interface SourceFileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  executable?: boolean;
}

export interface SnapshotFile extends SourceFile {
  digest: string;
  size: number;
}

export interface ProjectSnapshot {
  id: string;
  treeDigest: string;
  workspaceId: string;
  projectId: string;
  parentId?: string;
  files: SnapshotFile[];
  author: string;
  message: string;
  createdAt: string;
}

export interface SealSnapshotInput {
  author?: string;
  message?: string;
  parentId?: string;
  expectedHeadId?: string | null;
  setHead?: boolean;
}

export interface FileLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
}

export const DEFAULT_FILE_LIMITS: FileLimits = {
  maxFiles: 1_000,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 10_485_760,
  maxPathBytes: 1_024,
};

export interface ProjectRepository {
  create(workspaceId: string, input: CreateProjectInput): Promise<CloudProject>;
  get(workspaceId: string, projectId: string): Promise<CloudProject | null>;
  list(workspaceId: string): Promise<CloudProject[]>;
  updateServices(
    workspaceId: string,
    projectId: string,
    services: ProjectService[],
  ): Promise<CloudProject>;
  writeFiles(
    workspaceId: string,
    projectId: string,
    files: SourceFileInput[],
  ): Promise<SourceFile[]>;
  deleteFiles(workspaceId: string, projectId: string, paths: string[]): Promise<void>;
  listFiles(workspaceId: string, projectId: string): Promise<SourceFile[]>;
  sealSnapshot(
    workspaceId: string,
    projectId: string,
    input?: SealSnapshotInput,
  ): Promise<ProjectSnapshot>;
  getSnapshot(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<ProjectSnapshot | null>;
  listSnapshots(workspaceId: string, projectId: string): Promise<ProjectSnapshot[]>;
  setHead(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    expectedHeadId?: string | null,
  ): Promise<CloudProject>;
  setActiveDeployment(
    workspaceId: string,
    projectId: string,
    deploymentId: string | null,
  ): Promise<CloudProject>;
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, CloudProject>();
  private readonly workingFiles = new Map<string, Map<string, SourceFile>>();
  private readonly snapshots = new Map<string, ProjectSnapshot>();
  private readonly limits: FileLimits;

  constructor(limits: FileLimits = DEFAULT_FILE_LIMITS) {
    this.limits = limits;
  }

  async create(workspaceId: string, input: CreateProjectInput): Promise<CloudProject> {
    const id = input.id ?? `prj_${randomUUID()}`;
    const key = projectKey(workspaceId, id);
    if (this.projects.has(key)) throw new Error(`project ${id} already exists`);
    const now = new Date().toISOString();
    const project: CloudProject = {
      id,
      workspaceId,
      name: requireName(input.name),
      slug: normalizeSlug(input.slug ?? input.name),
      mode: input.mode ?? "source",
      services: normalizeServices(input.services ?? [defaultService()]),
      createdAt: now,
      updatedAt: now,
    };
    if ([...this.projects.values()].some((item) => item.workspaceId === workspaceId && item.slug === project.slug)) {
      throw new Error(`project slug "${project.slug}" already exists`);
    }
    this.projects.set(key, project);
    this.workingFiles.set(key, new Map());
    return clone(project);
  }

  async get(workspaceId: string, projectId: string): Promise<CloudProject | null> {
    const project = this.projects.get(projectKey(workspaceId, projectId));
    return project ? clone(project) : null;
  }

  async list(workspaceId: string): Promise<CloudProject[]> {
    return [...this.projects.values()]
      .filter((project) => project.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async updateServices(
    workspaceId: string,
    projectId: string,
    services: ProjectService[],
  ): Promise<CloudProject> {
    const project = this.mustProject(workspaceId, projectId);
    project.services = normalizeServices(services);
    project.updatedAt = new Date().toISOString();
    return clone(project);
  }

  async writeFiles(
    workspaceId: string,
    projectId: string,
    inputs: SourceFileInput[],
  ): Promise<SourceFile[]> {
    this.mustProject(workspaceId, projectId);
    const key = projectKey(workspaceId, projectId);
    const current = new Map(this.workingFiles.get(key) ?? []);
    const normalized = normalizeSourceFiles(inputs, this.limits);
    for (const file of normalized) current.set(file.path, file);
    validateSourceFiles([...current.values()], this.limits);
    this.workingFiles.set(key, current);
    this.touch(workspaceId, projectId);
    return normalized.map(clone);
  }

  async deleteFiles(workspaceId: string, projectId: string, paths: string[]): Promise<void> {
    this.mustProject(workspaceId, projectId);
    const files = this.workingFiles.get(projectKey(workspaceId, projectId)) ?? new Map();
    for (const path of paths) files.delete(normalizePath(path, this.limits.maxPathBytes));
    this.touch(workspaceId, projectId);
  }

  async listFiles(workspaceId: string, projectId: string): Promise<SourceFile[]> {
    this.mustProject(workspaceId, projectId);
    return [...(this.workingFiles.get(projectKey(workspaceId, projectId))?.values() ?? [])]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(clone);
  }

  async sealSnapshot(
    workspaceId: string,
    projectId: string,
    input: SealSnapshotInput = {},
  ): Promise<ProjectSnapshot> {
    const project = this.mustProject(workspaceId, projectId);
    if (input.expectedHeadId !== undefined && (project.headSnapshotId ?? null) !== input.expectedHeadId) {
      throw new Error("project head changed");
    }
    const parentId = input.parentId ?? project.headSnapshotId;
    if (
      parentId &&
      !this.snapshots.has(snapshotKey(workspaceId, projectId, parentId))
    ) {
      throw new Error(`parent snapshot ${parentId} not found`);
    }
    const source = await this.listFiles(workspaceId, projectId);
    const snapshot = createSnapshot({
      workspaceId,
      projectId,
      files: source,
      parentId,
      author: input.author,
      message: input.message,
    });
    const existing = this.snapshots.get(snapshotKey(workspaceId, projectId, snapshot.id));
    if (existing && !snapshotEqual(existing, snapshot)) {
      throw new Error(`snapshot digest collision for ${snapshot.id}`);
    }
    this.snapshots.set(snapshotKey(workspaceId, projectId, snapshot.id), snapshot);
    if (input.setHead !== false) {
      project.headSnapshotId = snapshot.id;
      project.updatedAt = snapshot.createdAt;
    }
    return clone(snapshot);
  }

  async getSnapshot(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
  ): Promise<ProjectSnapshot | null> {
    const snapshot = this.snapshots.get(snapshotKey(workspaceId, projectId, snapshotId));
    return snapshot ? clone(snapshot) : null;
  }

  async listSnapshots(workspaceId: string, projectId: string): Promise<ProjectSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.workspaceId === workspaceId && snapshot.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async setHead(
    workspaceId: string,
    projectId: string,
    snapshotId: string,
    expectedHeadId?: string | null,
  ): Promise<CloudProject> {
    const project = this.mustProject(workspaceId, projectId);
    if (expectedHeadId !== undefined && (project.headSnapshotId ?? null) !== expectedHeadId) {
      throw new Error("project head changed");
    }
    const snapshot = await this.getSnapshot(workspaceId, projectId, snapshotId);
    if (!snapshot) throw new Error(`snapshot ${snapshotId} not found`);
    project.headSnapshotId = snapshotId;
    project.updatedAt = new Date().toISOString();
    this.workingFiles.set(
      projectKey(workspaceId, projectId),
      new Map(snapshot.files.map((file) => [file.path, sourceFile(file)])),
    );
    return clone(project);
  }

  async setActiveDeployment(
    workspaceId: string,
    projectId: string,
    deploymentId: string | null,
  ): Promise<CloudProject> {
    const project = this.mustProject(workspaceId, projectId);
    if (deploymentId) project.activeDeploymentId = deploymentId;
    else delete project.activeDeploymentId;
    project.updatedAt = new Date().toISOString();
    return clone(project);
  }

  private mustProject(workspaceId: string, projectId: string): CloudProject {
    const project = this.projects.get(projectKey(workspaceId, projectId));
    if (!project) throw new Error(`project ${projectId} not found`);
    return project;
  }

  private touch(workspaceId: string, projectId: string): void {
    this.mustProject(workspaceId, projectId).updatedAt = new Date().toISOString();
  }
}

export function createSnapshot(input: {
  workspaceId: string;
  projectId: string;
  files: SourceFileInput[];
  parentId?: string;
  author?: string;
  message?: string;
  createdAt?: string;
  limits?: FileLimits;
}): ProjectSnapshot {
  const files = normalizeSourceFiles(input.files, input.limits).map(snapshotFile);
  const manifest = files.find((file) => file.path === FABRIC_MANIFEST_PATH);
  if (manifest) {
    if (manifest.encoding !== "utf8") {
      throw new Error(`${FABRIC_MANIFEST_PATH} must be UTF-8 JSON`);
    }
    parseApplicationManifest(manifest.content);
  }
  const treeDigest = sha256(
    JSON.stringify(files.map(({ path, digest, size, executable }) => ({ path, digest, size, executable }))),
  );
  const id = `snap_${sha256(JSON.stringify({
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    treeDigest,
  })).slice(0, 40)}`;
  return {
    id,
    treeDigest: `sha256:${treeDigest}`,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    files,
    author: input.author ?? "ai",
    message: input.message ?? "snapshot",
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.parentId ? { parentId: input.parentId } : {}),
  };
}

export function verifySnapshot(snapshot: ProjectSnapshot, limits = DEFAULT_FILE_LIMITS): void {
  const source = normalizeSourceFiles(snapshot.files, limits);
  const expected = createSnapshot({
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    files: source,
    parentId: snapshot.parentId,
    author: snapshot.author,
    message: snapshot.message,
    createdAt: snapshot.createdAt,
    limits,
  });
  for (const file of snapshot.files) {
    if (snapshotFile(source.find((candidate) => candidate.path === file.path)!).digest !== file.digest) {
      throw new Error(`digest mismatch for ${file.path}`);
    }
  }
  if (expected.treeDigest !== snapshot.treeDigest || expected.id !== snapshot.id) {
    throw new Error(`snapshot ${snapshot.id} failed integrity verification`);
  }
}

export function normalizeSourceFiles(
  inputs: SourceFileInput[],
  limits: FileLimits = DEFAULT_FILE_LIMITS,
): SourceFile[] {
  const files = inputs.map((input) => ({
    path: normalizePath(input.path, limits.maxPathBytes),
    content: normalizeContent(input.content, input.encoding ?? "utf8"),
    encoding: input.encoding ?? "utf8",
    executable: input.executable ?? false,
  }));
  validateSourceFiles(files, limits);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizePath(path: string, maxPathBytes = DEFAULT_FILE_LIMITS.maxPathBytes): string {
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new Error(`unsafe project path "${path}"`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe project path "${path}"`);
  }
  if (parts.includes(".git")) throw new Error(`reserved project path "${path}"`);
  const basename = parts.at(-1)!.toLowerCase();
  if (
    (basename === ".env" || basename.startsWith(".env.")) &&
    basename !== ".env.example" &&
    basename !== ".env.sample"
  ) {
    throw new Error(`secret-bearing environment files cannot be snapshotted`);
  }
  const normalized = parts.join("/");
  if (Buffer.byteLength(normalized, "utf8") > maxPathBytes) throw new Error(`project path too long`);
  return normalized;
}

export function normalizeServices(services: ProjectService[]): ProjectService[] {
  if (services.length === 0) throw new Error("at least one project service is required");
  const names = new Set<string>();
  return services.map((service) => {
    const name = service.name.trim();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error(`invalid service name "${name}"`);
    if (names.has(name)) throw new Error(`duplicate service "${name}"`);
    names.add(name);
    const root = service.root === "." ? "." : normalizePath(service.root);
    if (service.healthCheckPath && !service.healthCheckPath.startsWith("/")) {
      throw new Error(`health check path must start with "/"`);
    }
    return {
      ...clone(service),
      name,
      root,
      buildCommand: normalizeCommand(service.buildCommand),
      startCommand: normalizeCommand(service.startCommand),
    };
  });
}

export function normalizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (!slug) throw new Error("project slug is required");
  return slug;
}

function validateSourceFiles(files: SourceFile[], limits: FileLimits): void {
  if (files.length > limits.maxFiles) throw new Error(`project exceeds ${limits.maxFiles} files`);
  const exact = new Set<string>();
  const folded = new Set<string>();
  let total = 0;
  for (const file of files) {
    normalizePath(file.path, limits.maxPathBytes);
    if (exact.has(file.path)) throw new Error(`duplicate project path "${file.path}"`);
    const lower = file.path.toLocaleLowerCase("en-US");
    if (folded.has(lower)) throw new Error(`case-colliding project path "${file.path}"`);
    exact.add(file.path);
    folded.add(lower);
    const size = contentBytes(file).byteLength;
    if (size > limits.maxFileBytes) throw new Error(`${file.path} exceeds file size limit`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error("project exceeds total size limit");
  }
}

function snapshotFile(file: SourceFile): SnapshotFile {
  const bytes = contentBytes(file);
  return { ...clone(file), size: bytes.byteLength, digest: `sha256:${sha256(bytes)}` };
}

function sourceFile(file: SnapshotFile): SourceFile {
  return {
    path: file.path,
    content: file.content,
    encoding: file.encoding,
    executable: file.executable,
  };
}

function contentBytes(file: Pick<SourceFile, "content" | "encoding">): Buffer {
  return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
}

function normalizeContent(content: string, encoding: SourceFile["encoding"]): string {
  if (encoding === "utf8") return content.replace(/\r\n/g, "\n");
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== content.replace(/\s+/g, "").replace(/=+$/, "")) {
    throw new Error("invalid base64 file content");
  }
  return bytes.toString("base64");
}

function normalizeCommand(command: string[] | undefined): string[] | undefined {
  if (!command) return undefined;
  if (command.length === 0 || command.some((part) => !part || part.includes("\0"))) {
    throw new Error("commands must be non-empty argv arrays");
  }
  return [...command];
}

function defaultService(): ProjectService {
  return { name: "web", kind: "web", root: ".", runtime: "auto" };
}

function requireName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("project name is required");
  return normalized;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectKey(workspaceId: string, projectId: string): string {
  return `${workspaceId}\0${projectId}`;
}

function snapshotKey(workspaceId: string, projectId: string, snapshotId: string): string {
  return `${workspaceId}\0${projectId}\0${snapshotId}`;
}

function snapshotEqual(a: ProjectSnapshot, b: ProjectSnapshot): boolean {
  return a.treeDigest === b.treeDigest && a.parentId === b.parentId && a.projectId === b.projectId;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export * from "./repository.ts";

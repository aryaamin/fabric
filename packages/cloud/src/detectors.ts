import type { ProjectService, ProjectSnapshot, SnapshotFile } from "@fabric/projects";
import type {
  BuildPlan,
  CommandSpec,
  RuntimeDetector,
  SupportedRuntime,
  WorkloadKind,
} from "./index.ts";

export function detectBuildPlan(
  snapshot: ProjectSnapshot,
  service: ProjectService,
  detectors: RuntimeDetector[] = DEFAULT_RUNTIME_DETECTORS,
): BuildPlan {
  const candidates =
    service.runtime === "auto"
      ? detectors
      : detectors.filter((detector) => detector.runtime === service.runtime);
  for (const detector of candidates) {
    const plan = detector.detect(snapshot, service);
    if (plan) return plan;
  }
  throw new Error(
    `unsupported_runtime: could not detect ${service.runtime === "auto" ? "a runtime" : service.runtime} for ${service.name}`,
  );
}

export function detectBuildPlans(
  snapshot: ProjectSnapshot,
  services: ProjectService[],
  detectors: RuntimeDetector[] = DEFAULT_RUNTIME_DETECTORS,
): BuildPlan[] {
  return services.map((service) => detectBuildPlan(snapshot, service, detectors));
}

export class NodeRuntimeDetector implements RuntimeDetector {
  readonly runtime = "nodejs" as const;

  detect(snapshot: ProjectSnapshot, service: ProjectService): BuildPlan | null {
    const files = serviceFiles(snapshot, service);
    const packageFile = files.get("package.json");
    if (!packageFile) return null;
    const pkg = parseJson<{
      engines?: { node?: string };
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(text(packageFile), packageFile.path);
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    const packageManager = detectNodePackageManager(files);
    const framework = detectNodeFramework(dependencies);
    const buildScript = pkg.scripts?.build;
    const startScript = pkg.scripts?.start;
    const staticOutput = framework === "vite" && Boolean(buildScript);
    const functionOutput =
      framework === "next" ||
      framework === "nestjs" ||
      framework === "fastify" ||
      framework === "express" ||
      framework === "hono";
    const start =
      commandOverride(service.startCommand, service.root) ??
      (startScript ? packageScript(packageManager, "start", service.root) : undefined);

    if (!staticOutput && !start && service.kind !== "cron") {
      throw new Error(
        `ambiguous_entrypoint: ${service.name} needs a start script or explicit startCommand`,
      );
    }

    return {
      schemaVersion: 1,
      service: service.name,
      runtime: "nodejs",
      runtimeVersion: pkg.engines?.node,
      framework,
      packageManager,
      install: nodeInstall(packageManager, files, service.root),
      build:
        commandOverride(service.buildCommand, service.root) ??
        (buildScript ? packageScript(packageManager, "build", service.root) : undefined),
      start,
      output: {
        kind: staticOutput ? "static" : workload(service, functionOutput ? "function" : "service"),
        ...(staticOutput ? { directory: joinRoot(service.root, "dist") } : {}),
      },
      requirements: requirements(service, staticOutput || functionOutput),
    };
  }
}

export class PythonRuntimeDetector implements RuntimeDetector {
  readonly runtime = "python" as const;

  detect(snapshot: ProjectSnapshot, service: ProjectService): BuildPlan | null {
    const files = serviceFiles(snapshot, service);
    const requirementsFile = files.get("requirements.txt");
    const pyproject = files.get("pyproject.toml");
    if (!requirementsFile && !pyproject) return null;
    const dependencyText = `${requirementsFile ? text(requirementsFile) : ""}\n${pyproject ? text(pyproject) : ""}`.toLowerCase();
    const framework = dependencyText.includes("fastapi")
      ? "fastapi"
      : dependencyText.includes("django")
        ? "django"
        : dependencyText.includes("flask")
          ? "flask"
          : undefined;
    const start =
      commandOverride(service.startCommand, service.root) ??
      pythonStart(files, framework, service.root);
    if (!start && service.kind !== "cron") {
      throw new Error(
        `ambiguous_entrypoint: ${service.name} needs main.py or an explicit startCommand`,
      );
    }
    return {
      schemaVersion: 1,
      service: service.name,
      runtime: "python",
      framework,
      install: requirementsFile
        ? command("python", ["-m", "pip", "install", "--requirement", "requirements.txt"], service.root)
        : command("python", ["-m", "pip", "install", "."], service.root),
      build: commandOverride(service.buildCommand, service.root),
      start,
      output: { kind: workload(service, framework ? "function" : "service") },
      requirements: requirements(service, Boolean(framework)),
    };
  }
}

export class GoRuntimeDetector implements RuntimeDetector {
  readonly runtime = "go" as const;

  detect(snapshot: ProjectSnapshot, service: ProjectService): BuildPlan | null {
    const files = serviceFiles(snapshot, service);
    const module = files.get("go.mod");
    if (!module) return null;
    const version = /^go\s+([^\s]+)$/m.exec(text(module))?.[1];
    return {
      schemaVersion: 1,
      service: service.name,
      runtime: "go",
      runtimeVersion: version,
      install: command("go", ["mod", "download"], service.root),
      build:
        commandOverride(service.buildCommand, service.root) ??
        command("go", ["build", "-trimpath", "-o", ".fabric/bin/app", "."], service.root),
      start:
        commandOverride(service.startCommand, service.root) ??
        command(".fabric/bin/app", [], service.root),
      output: { kind: workload(service, "service") },
      requirements: requirementsForService(service),
    };
  }
}

export const DEFAULT_RUNTIME_DETECTORS: RuntimeDetector[] = [
  new NodeRuntimeDetector(),
  new PythonRuntimeDetector(),
  new GoRuntimeDetector(),
];

function serviceFiles(
  snapshot: ProjectSnapshot,
  service: ProjectService,
): Map<string, SnapshotFile> {
  const prefix = service.root === "." ? "" : `${service.root}/`;
  return new Map(
    snapshot.files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => [file.path.slice(prefix.length), file]),
  );
}

function detectNodePackageManager(files: Map<string, SnapshotFile>): string {
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  return "npm";
}

function detectNodeFramework(dependencies: Record<string, string>): string | undefined {
  if (dependencies.next) return "next";
  if (dependencies.vite) return "vite";
  if (dependencies["@nestjs/core"]) return "nestjs";
  if (dependencies.fastify) return "fastify";
  if (dependencies.express) return "express";
  if (dependencies.hono) return "hono";
  return undefined;
}

function nodeInstall(
  manager: string,
  files: Map<string, SnapshotFile>,
  cwd: string,
): CommandSpec {
  if (manager === "pnpm") return command("pnpm", ["install", "--frozen-lockfile"], cwd);
  if (manager === "yarn") return command("yarn", ["install", "--immutable"], cwd);
  if (manager === "bun") return command("bun", ["install", "--frozen-lockfile"], cwd);
  return command("npm", files.has("package-lock.json") ? ["ci"] : ["install"], cwd);
}

function packageScript(manager: string, script: string, cwd: string): CommandSpec {
  if (manager === "npm") return command("npm", ["run", script], cwd);
  return command(manager, ["run", script], cwd);
}

function pythonStart(
  files: Map<string, SnapshotFile>,
  framework: string | undefined,
  cwd: string,
): CommandSpec | undefined {
  if (framework === "fastapi" && files.has("main.py")) {
    return command(
      "python",
      ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${PORT}"],
      cwd,
    );
  }
  if (framework === "django" && files.has("manage.py")) {
    return command("python", ["manage.py", "runserver", "0.0.0.0:${PORT}"], cwd);
  }
  if (framework === "flask" && (files.has("app.py") || files.has("main.py"))) {
    return command(
      "python",
      [
        "-m",
        "flask",
        "--app",
        files.has("app.py") ? "app" : "main",
        "run",
        "--host",
        "0.0.0.0",
        "--port",
        "${PORT}",
      ],
      cwd,
    );
  }
  return files.has("main.py") ? command("python", ["main.py"], cwd) : undefined;
}

function requirements(
  service: ProjectService,
  platformManaged: boolean,
): BuildPlan["requirements"] {
  if (platformManaged) {
    return {
      protocols: ["http"],
      longLived: false,
      background: false,
    };
  }
  return requirementsForService(service);
}

function requirementsForService(service: ProjectService): BuildPlan["requirements"] {
  return {
    protocols: service.kind === "web" ? ["http"] : [],
    longLived: service.kind === "web" || service.kind === "worker",
    background: service.kind === "worker",
  };
}

function workload(service: ProjectService, webDefault: WorkloadKind): WorkloadKind {
  if (service.kind === "worker") return "worker";
  if (service.kind === "cron") return "cron";
  return webDefault;
}

function commandOverride(value: string[] | undefined, cwd: string): CommandSpec | undefined {
  if (!value) return undefined;
  const [executable, ...args] = value;
  if (!executable) throw new Error("command executable is required");
  return command(executable, args, cwd);
}

function command(executable: string, args: string[], cwd: string): CommandSpec {
  return { executable, args, cwd };
}

function joinRoot(root: string, child: string): string {
  return root === "." ? child : `${root}/${child}`;
}

function text(file: SnapshotFile): string {
  if (file.encoding !== "utf8") throw new Error(`manifest ${file.path} must be utf8`);
  return file.content;
}

function parseJson<T>(value: string, path: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`invalid JSON in ${path}`);
  }
}

export function runtimeLabel(runtime: SupportedRuntime): string {
  if (runtime === "nodejs") return "Node.js";
  if (runtime === "python") return "Python";
  return "Go";
}

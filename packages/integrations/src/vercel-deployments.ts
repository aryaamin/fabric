import { createHash } from "node:crypto";
import { Vercel } from "@vercel/sdk";
import type {
  BuildPlan,
  DeploymentHandle,
  DeploymentProvider,
  DeploymentState,
  RuntimePolicy,
} from "@fabric/cloud";
import { DEFAULT_EXECUTION_POLICY } from "@fabric/cloud";
import type { ProjectSnapshot } from "@fabric/projects";

type DeploymentsClient = Pick<
  Vercel["deployments"],
  "uploadFile" | "createDeployment" | "getDeployment" | "cancelDeployment"
>;

export interface VercelDeploymentProviderOptions {
  token?: string;
  teamId?: string;
  projectNamePrefix?: string;
  client?: DeploymentsClient;
  fetch?: typeof globalThis.fetch;
  runtimePolicy?: RuntimePolicy;
}

export function createVercelDeploymentProvider(
  options: VercelDeploymentProviderOptions,
): DeploymentProvider {
  const client =
    options.client ??
    (options.token ? new Vercel({ bearerToken: options.token }).deployments : undefined);
  if (!client) throw new Error("Vercel deployment token or client is required");
  const teamId = options.teamId;
  return {
    name: "vercel-web",
    capabilities: {
      runtimes: ["nodejs", "python", "go"],
      workloads: ["static", "function"],
      protocols: ["http"],
      longLived: false,
      background: false,
    },
    async create(input): Promise<DeploymentHandle> {
      if (Object.keys(input.environment).length > 0) {
        throw new Error(
          "Vercel deployment environment bindings must be provisioned as encrypted project environment variables",
        );
      }
      const files = await uploadSnapshot(client, input.snapshot, options);
      const name = deploymentProjectName(
        input.projectId,
        options.projectNamePrefix ?? "fabric",
      );
      const functions = functionSettings(
        input.snapshot,
        input.plan,
        options.runtimePolicy ?? DEFAULT_EXECUTION_POLICY.runtime,
      );
      const response = await client.createDeployment({
        teamId,
        skipAutoDetectionConfirmation: "1",
        requestBody: {
          name,
          project: name,
          files,
          meta: {
            fabricProjectId: input.projectId,
            fabricSnapshotId: input.snapshot.id,
            fabricIdempotencyKey: input.idempotencyKey,
          },
          ...(functions ? { functions } : {}),
          projectSettings: projectSettings(input.plan),
        },
      });
      if (options.token) {
        await makeGeneratedProjectPublic(
          options.fetch ?? globalThis.fetch,
          options.token,
          teamId,
          name,
        );
      }
      return deploymentHandle(response);
    },
    async inspect(providerDeploymentId): Promise<DeploymentHandle> {
      const response = await client.getDeployment({
        idOrUrl: providerDeploymentId,
        teamId,
      });
      return deploymentHandle(response);
    },
    async cancel(providerDeploymentId): Promise<void> {
      await client.cancelDeployment({ id: providerDeploymentId, teamId });
    },
  };
}

function functionSettings(
  snapshot: ProjectSnapshot,
  plan: BuildPlan,
  policy: RuntimePolicy,
): Record<string, { maxDuration: number; maxConcurrency: number }> | undefined {
  if (plan.output.kind !== "function") return undefined;
  const paths = functionPaths(snapshot, plan);
  if (paths.length === 0) return undefined;
  const configuration = {
    maxDuration: Math.max(1, Math.ceil(policy.maxDurationMs / 1_000)),
    maxConcurrency: policy.maxConcurrency,
  };
  return Object.fromEntries(paths.map((path) => [path, configuration]));
}

function functionPaths(snapshot: ProjectSnapshot, plan: BuildPlan): string[] {
  const prefix = plan.start?.cwd && plan.start.cwd !== "." ? `${plan.start.cwd}/` : "";
  if (plan.framework === "next") {
    const candidates = [
      `${prefix}app/api/**/*`,
      `${prefix}pages/api/**/*`,
      `${prefix}src/app/api/**/*`,
      `${prefix}src/pages/api/**/*`,
    ];
    return candidates.filter((pattern) =>
      snapshot.files.some((file) =>
        file.path.startsWith(pattern.replace("/**/*", "/")),
      ),
    );
  }
  if (plan.runtime === "python") {
    const preferred =
      plan.framework === "flask"
        ? ["app.py", "main.py"]
        : plan.framework === "django"
          ? snapshot.files
              .map((file) => file.path)
              .filter((path) => path.endsWith("/wsgi.py"))
          : ["main.py"];
    return preferred
      .map((path) => (path.startsWith(prefix) ? path : `${prefix}${path}`))
      .filter((path) => snapshot.files.some((file) => file.path === path))
      .slice(0, 1);
  }
  const startFile = plan.start?.args.find((argument) =>
    /\.(?:[cm]?[jt]s|go)$/.test(argument),
  );
  if (startFile) {
    const path = startFile.startsWith(prefix) ? startFile : `${prefix}${startFile}`;
    if (snapshot.files.some((file) => file.path === path)) return [path];
  }
  return [];
}

async function uploadSnapshot(
  client: DeploymentsClient,
  snapshot: ProjectSnapshot,
  options: VercelDeploymentProviderOptions,
) {
  const files: { file: string; sha: string; size: number }[] = [];
  for (const file of snapshot.files) {
    const content = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
    const sha = createHash("sha1").update(content).digest("hex");
    if (options.token) {
      await uploadFile(options.fetch ?? globalThis.fetch, options.token, options.teamId, content, sha);
    } else {
      await client.uploadFile({
        teamId: options.teamId,
        contentLength: content.byteLength,
        xVercelDigest: sha,
        requestBody: content,
      });
    }
    files.push({ file: file.path, sha, size: content.byteLength });
  }
  return files;
}

async function uploadFile(
  request: typeof globalThis.fetch,
  token: string,
  teamId: string | undefined,
  content: Buffer,
  digest: string,
): Promise<void> {
  const url = new URL("https://api.vercel.com/v2/files");
  if (teamId) url.searchParams.set("teamId", teamId);
  const response = await request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-length": String(content.byteLength),
      "content-type": "application/octet-stream",
      "x-vercel-digest": digest,
    },
    body: new Blob([Uint8Array.from(content)]),
  });
  if (!response.ok) {
    throw new Error(
      `Fabric deployment file upload failed (${response.status}): ${(await response.text()).slice(0, 1_000)}`,
    );
  }
}

async function makeGeneratedProjectPublic(
  request: typeof globalThis.fetch,
  token: string,
  teamId: string | undefined,
  projectName: string,
): Promise<void> {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);
  const response = await request(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ssoProtection: null,
      passwordProtection: null,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Fabric could not publish the generated application (${response.status})`,
    );
  }
}

function projectSettings(plan: BuildPlan) {
  return {
    framework: framework(plan.framework),
    installCommand: plan.install ? shellCommand(plan.install.executable, plan.install.args) : null,
    buildCommand: plan.build ? shellCommand(plan.build.executable, plan.build.args) : null,
    outputDirectory: plan.output.directory ?? null,
    ...(plan.runtime === "nodejs" && nodeVersion(plan.runtimeVersion)
      ? { nodeVersion: nodeVersion(plan.runtimeVersion) }
      : {}),
  };
}

function framework(
  value: string | undefined,
):
  | "nextjs"
  | "vite"
  | "fastapi"
  | "flask"
  | "django"
  | "express"
  | "hono"
  | "nestjs"
  | "fastify"
  | null {
  if (value === "next") return "nextjs";
  if (
    value === "vite" ||
    value === "fastapi" ||
    value === "flask" ||
    value === "django" ||
    value === "express" ||
    value === "hono" ||
    value === "nestjs" ||
    value === "fastify"
  ) {
    return value;
  }
  return null;
}

function nodeVersion(value: string | undefined): "24.x" | "22.x" | "20.x" | undefined {
  if (!value) return "24.x";
  if (value.includes("24")) return "24.x";
  if (value.includes("22")) return "22.x";
  if (value.includes("20")) return "20.x";
  return undefined;
}

function deploymentProjectName(projectId: string, prefix: string): string {
  const value = `${prefix}-${projectId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!value) throw new Error("Vercel project name is empty");
  return value;
}

function shellCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function deploymentHandle(response: {
  id: string;
  readyState: string;
  url?: string;
  errorCode?: string;
  errorMessage?: string | null;
}): DeploymentHandle {
  return {
    providerDeploymentId: response.id,
    status: deploymentState(response.readyState),
    ...(response.url ? { immutableUrl: `https://${response.url}` } : {}),
    providerMetadata: {
      readyState: response.readyState,
      ...(response.errorCode ? { errorCode: response.errorCode } : {}),
      ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
    },
  };
}

function deploymentState(state: string): DeploymentState {
  if (state === "READY") return "READY";
  if (state === "ERROR" || state === "BLOCKED") return "ERROR";
  if (state === "CANCELED" || state === "CANCELLED") return "CANCELLED";
  if (state === "QUEUED") return "QUEUED";
  return "BUILDING";
}

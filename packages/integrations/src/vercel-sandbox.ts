import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import type {
  BuildPlan,
  CommandSpec,
  ExecutionProvider,
  ExecutionResult,
  SupportedRuntime,
} from "@fabric/cloud";
import type { ProjectSnapshot } from "@fabric/projects";

export interface VercelSandboxExecutorOptions {
  token?: string;
  teamId?: string;
  projectId?: string;
  images?: Partial<Record<SupportedRuntime, string>>;
  allowedDomains?: Partial<Record<SupportedRuntime, string[]>>;
  createSandbox?: typeof Sandbox.create;
}

export function createVercelSandboxExecutor(
  options: VercelSandboxExecutorOptions = {},
): ExecutionProvider {
  return {
    name: "vercel-sandbox",
    async execute(input): Promise<ExecutionResult> {
      const startedAt = new Date().toISOString();
      const create = options.createSandbox ?? Sandbox.create;
      const credentials = explicitCredentials(options);
      const sandbox = await create({
        ...(credentials ?? {}),
        image: options.images?.[input.plan.runtime] ?? "vercel/sandbox/universal:latest",
        timeout: input.limits.timeoutMs,
        resources: { vcpus: normalizeVcpus(input.limits.cpu) },
        networkPolicy: networkPolicy(
          input.plan.runtime,
          input.limits.network,
          options.allowedDomains,
        ),
        signal: input.signal,
        tags: {
          fabric: "build",
          runtime: input.plan.runtime,
        },
      });
      try {
        await sandbox.writeFiles(
          input.snapshot.files.map((file) => ({
            path: file.path,
            content:
              file.encoding === "base64"
                ? Buffer.from(file.content, "base64")
                : file.content,
            mode: file.executable ? 0o755 : 0o644,
          })),
          { signal: input.signal },
        );
        const deadline = Date.now() + input.limits.timeoutMs;
        for (const [phase, spec] of commands(input.plan)) {
          await input.onEvent?.({
            stream: "system",
            message: `${phase}: ${displayCommand(spec)}`,
          });
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("sandbox build timed out");
          const command = await sandbox.runCommand({
            cmd: spec.executable,
            args: spec.args.map(expandBuildVariable),
            cwd: sandboxPath(sandbox.cwd, spec.cwd),
            env: spec.env,
            detached: true,
            signal: input.signal,
            timeoutMs: remaining,
          });
          const logs = (async () => {
            for await (const line of command.logs({ signal: input.signal })) {
              await input.onEvent?.({
                stream: line.stream,
                message: line.data,
              });
            }
          })();
          const finished = await command.wait({ signal: input.signal });
          await logs;
          if (finished.exitCode !== 0) {
            return {
              exitCode: finished.exitCode,
              startedAt,
              finishedAt: new Date().toISOString(),
            };
          }
        }
        return {
          exitCode: 0,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      } finally {
        await sandbox.stop({ signal: input.signal }).catch(() => undefined);
      }
    },
  };
}

function commands(plan: BuildPlan): Array<[string, CommandSpec]> {
  return [
    ...(plan.install ? ([["install", plan.install]] as Array<[string, CommandSpec]>) : []),
    ...(plan.build ? ([["build", plan.build]] as Array<[string, CommandSpec]>) : []),
  ];
}

function networkPolicy(
  runtime: SupportedRuntime,
  mode: "none" | "restricted",
  configured: VercelSandboxExecutorOptions["allowedDomains"],
): NetworkPolicy {
  if (mode === "none") return "deny-all";
  return { allow: configured?.[runtime] ?? DEFAULT_ALLOWED_DOMAINS[runtime] };
}

const DEFAULT_ALLOWED_DOMAINS: Record<SupportedRuntime, string[]> = {
  nodejs: ["registry.npmjs.org", "*.npmjs.org", "github.com", "*.githubusercontent.com"],
  python: ["pypi.org", "files.pythonhosted.org", "github.com", "*.githubusercontent.com"],
  go: [
    "proxy.golang.org",
    "sum.golang.org",
    "storage.googleapis.com",
    "github.com",
    "*.githubusercontent.com",
  ],
};

function explicitCredentials(options: VercelSandboxExecutorOptions) {
  const values = [options.token, options.teamId, options.projectId];
  if (values.every(Boolean)) {
    return {
      token: options.token!,
      teamId: options.teamId!,
      projectId: options.projectId!,
    };
  }
  if (values.some(Boolean)) {
    throw new Error("Vercel Sandbox token, teamId, and projectId must be configured together");
  }
  return undefined;
}

function normalizeVcpus(cpu: number): number {
  if (!Number.isFinite(cpu) || cpu <= 0) throw new Error("sandbox CPU must be positive");
  return Math.min(8, Math.max(1, Math.ceil(cpu)));
}

function sandboxPath(cwd: string, relative: string): string {
  return relative === "." ? cwd : `${cwd}/${relative}`;
}

function expandBuildVariable(value: string): string {
  return value.replaceAll("${PORT}", "3000");
}

function displayCommand(command: CommandSpec): string {
  return [command.executable, ...command.args].map(shellDisplay).join(" ");
}

function shellDisplay(value: string): string {
  return /^[a-zA-Z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

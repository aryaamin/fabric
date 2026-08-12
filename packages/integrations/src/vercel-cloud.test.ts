import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "@vercel/sandbox";
import { createSnapshot } from "@fabric/projects";
import type { BuildPlan } from "@fabric/cloud";
import {
  createVercelDeploymentProvider,
  createVercelSandboxExecutor,
  type VercelDeploymentProviderOptions,
} from "./index.ts";

const snapshot = createSnapshot({
  workspaceId: "ws",
  projectId: "prj_example",
  files: [
    {
      path: "package.json",
      content: '{"scripts":{"build":"next build","start":"next start"}}',
    },
    { path: "app/page.tsx", content: "export default function Page(){return null}\n" },
  ],
});

const plan: BuildPlan = {
  schemaVersion: 1,
  service: "web",
  runtime: "nodejs",
  runtimeVersion: "24.x",
  framework: "next",
  packageManager: "npm",
  install: { executable: "npm", args: ["install"], cwd: "." },
  build: { executable: "npm", args: ["run", "build"], cwd: "." },
  output: { kind: "function" },
  requirements: { protocols: ["http"], longLived: false, background: false },
};

test("Vercel Sandbox executor uploads immutable files and streams build output", async () => {
  const written: string[] = [];
  const stopped: boolean[] = [];
  const fakeSandbox = {
    cwd: "/vercel/sandbox",
    async writeFiles(files: { path: string }[]) {
      written.push(...files.map((file) => file.path));
    },
    async runCommand(params: { cmd: string }) {
      return {
        async *logs() {
          yield { stream: "stdout" as const, data: `${params.cmd} ok` };
        },
        async wait() {
          return { exitCode: 0 };
        },
      };
    },
    async stop() {
      stopped.push(true);
      return {};
    },
  };
  const executor = createVercelSandboxExecutor({
    createSandbox: (async () => fakeSandbox) as unknown as typeof Sandbox.create,
  });
  const events: string[] = [];
  const result = await executor.execute({
    snapshot,
    plan,
    limits: { timeoutMs: 60_000, memoryMb: 2_048, cpu: 1, network: "restricted" },
    async onEvent(event) {
      events.push(event.message);
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(written, ["app/page.tsx", "package.json"]);
  assert.deepEqual(events, [
    "install: npm install",
    "npm ok",
    "build: npm run build",
    "npm ok",
  ]);
  assert.equal(stopped.length, 1);
});

test("Vercel deployment provider uploads by digest and returns immutable URL", async () => {
  const uploads: { digest?: string; bytes?: number }[] = [];
  let deploymentRequest: unknown;
  const client = {
    async uploadFile(request: { xVercelDigest?: string; contentLength?: number }) {
      uploads.push({ digest: request.xVercelDigest, bytes: request.contentLength });
      return {};
    },
    async createDeployment(request: unknown) {
      deploymentRequest = request;
      return {
        id: "dpl_1",
        readyState: "BUILDING",
        url: "fabric-example.vercel.app",
      };
    },
    async getDeployment() {
      return {
        id: "dpl_1",
        readyState: "READY",
        url: "fabric-example.vercel.app",
      };
    },
    async cancelDeployment() {
      return {};
    },
  } as unknown as NonNullable<VercelDeploymentProviderOptions["client"]>;
  const provider = createVercelDeploymentProvider({
    client,
    teamId: "team_1",
  });
  const created = await provider.create({
    projectId: snapshot.projectId,
    snapshot,
    plan,
    environment: {},
    idempotencyKey: "deploy-1",
  });
  const ready = await provider.inspect(created.providerDeploymentId);

  assert.equal(uploads.length, 2);
  assert(uploads.every((upload) => upload.digest?.length === 40));
  assert.equal(created.status, "BUILDING");
  assert.equal(ready.status, "READY");
  assert.equal(ready.immutableUrl, "https://fabric-example.vercel.app");
  assert.match(JSON.stringify(deploymentRequest), /fabricSnapshotId/);
});

test("token deployments send file digests through Vercel REST headers", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  const client = {
    async uploadFile() {
      throw new Error("SDK upload should not be used with token credentials");
    },
    async createDeployment() {
      return {
        id: "dpl_rest",
        readyState: "BUILDING",
        url: "fabric-rest.vercel.app",
      };
    },
    async getDeployment() {
      return { id: "dpl_rest", readyState: "READY", url: "fabric-rest.vercel.app" };
    },
    async cancelDeployment() {
      return {};
    },
  } as unknown as NonNullable<VercelDeploymentProviderOptions["client"]>;
  const provider = createVercelDeploymentProvider({
    token: "test-token",
    teamId: "team_1",
    client,
    fetch: (async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  await provider.create({
    projectId: snapshot.projectId,
    snapshot,
    plan,
    environment: {},
    idempotencyKey: "deploy-rest",
  });

  const uploads = requests.filter((request) => request.url.includes("/v2/files"));
  const publication = requests.find((request) => request.url.includes("/v9/projects/"));
  assert.equal(uploads.length, snapshot.files.length);
  assert(uploads.every((request) => request.url.endsWith("/v2/files?teamId=team_1")));
  assert(uploads.every((request) => request.headers.get("x-vercel-digest")?.length === 40));
  assert(requests.every((request) => request.headers.get("authorization") === "Bearer test-token"));
  assert.equal(publication?.method, "PATCH");
});

test("Vercel provider refuses plaintext deployment environment values", async () => {
  const provider = createVercelDeploymentProvider({
    client: {} as NonNullable<VercelDeploymentProviderOptions["client"]>,
  });
  await assert.rejects(
    provider.create({
      projectId: snapshot.projectId,
      snapshot,
      plan,
      environment: { DATABASE_URL: "secret" },
      idempotencyKey: "deploy-secret",
    }),
    /encrypted project environment variables/,
  );
});

test("Vercel provider applies provider-native function safety limits", async () => {
  let deploymentRequest: unknown;
  const client = {
    async uploadFile() {
      return {};
    },
    async createDeployment(request: unknown) {
      deploymentRequest = request;
      return {
        id: "dpl_safe",
        readyState: "BUILDING",
        url: "fabric-safe.vercel.app",
      };
    },
    async getDeployment() {
      return { id: "dpl_safe", readyState: "READY" };
    },
    async cancelDeployment() {
      return {};
    },
  } as unknown as NonNullable<VercelDeploymentProviderOptions["client"]>;
  const provider = createVercelDeploymentProvider({
    client,
    runtimePolicy: {
      maxDurationMs: 5_000,
      memoryMb: 512,
      maxConcurrency: 3,
      maxRequestsPerMinute: 60,
      maxRequestBytes: 1_024,
      maxResponseBytes: 2_048,
    },
  });
  await provider.create({
    projectId: "prj_flask",
    snapshot: createSnapshot({
      workspaceId: "ws",
      projectId: "prj_flask",
      files: [
        { path: "app.py", content: "from flask import Flask\napp = Flask(__name__)\n" },
        { path: "requirements.txt", content: "flask\n" },
      ],
    }),
    plan: {
      schemaVersion: 1,
      service: "web",
      runtime: "python",
      framework: "flask",
      start: { executable: "python", args: ["app.py"], cwd: "." },
      output: { kind: "function" },
      requirements: {
        protocols: ["http"],
        longLived: false,
        background: false,
      },
    },
    environment: {},
    idempotencyKey: "safe-runtime",
  });
  assert.deepEqual(
    (
      deploymentRequest as {
        requestBody: {
          functions: Record<string, { maxDuration: number; maxConcurrency: number }>;
        };
      }
    ).requestBody.functions,
    {
      "app.py": { maxDuration: 5, maxConcurrency: 3 },
    },
  );
});

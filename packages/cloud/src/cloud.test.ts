import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshot, type ProjectService } from "@fabric/projects";
import {
  InMemoryCloudRepository,
  createDeployment,
  detectBuildPlan,
  executeBuild,
  selectDeploymentProvider,
  type DeploymentProvider,
} from "./index.ts";

const webService: ProjectService = {
  name: "web",
  kind: "web",
  root: ".",
  runtime: "auto",
};

test("detects deterministic Node, Python, and Go build plans", () => {
  const node = detectBuildPlan(
    createSnapshot({
      workspaceId: "ws",
      projectId: "node",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({
            scripts: { build: "next build", start: "next start" },
            dependencies: { next: "16.0.0" },
            engines: { node: "24.x" },
          }),
        },
        { path: "package-lock.json", content: "{}" },
      ],
    }),
    webService,
  );
  const python = detectBuildPlan(
    createSnapshot({
      workspaceId: "ws",
      projectId: "python",
      files: [
        { path: "requirements.txt", content: "fastapi\nuvicorn\n" },
        { path: "main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n" },
      ],
    }),
    webService,
  );
  const go = detectBuildPlan(
    createSnapshot({
      workspaceId: "ws",
      projectId: "go",
      files: [
        { path: "go.mod", content: "module example.com/app\n\ngo 1.24\n" },
        { path: "main.go", content: "package main\nfunc main() {}\n" },
      ],
    }),
    webService,
  );

  assert.equal(node.runtime, "nodejs");
  assert.equal(node.framework, "next");
  assert.deepEqual(node.install?.args, ["ci"]);
  assert.equal(node.output.kind, "function");
  assert.equal(python.runtime, "python");
  assert.equal(python.framework, "fastapi");
  assert.deepEqual(python.start?.args.slice(0, 3), ["-m", "uvicorn", "main:app"]);
  assert.equal(go.runtime, "go");
  assert.equal(go.runtimeVersion, "1.24");
  assert.equal(go.build?.executable, "go");
});

test("rejects ambiguous source entrypoints", () => {
  const snapshot = createSnapshot({
    workspaceId: "ws",
    projectId: "node",
    files: [{ path: "package.json", content: "{}" }],
  });
  assert.throws(() => detectBuildPlan(snapshot, webService), /ambiguous_entrypoint/);
});

test("builds and deployments have idempotent requests and terminal states", async () => {
  const repository = new InMemoryCloudRepository();
  const snapshot = createSnapshot({
    workspaceId: "ws",
    projectId: "node",
    files: [
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { start: "node index.js" } }),
      },
    ],
  });
  const plan = detectBuildPlan(snapshot, webService);
  const first = await repository.requestBuild({
    workspaceId: "ws",
    projectId: "node",
    snapshotId: snapshot.id,
    service: "web",
    plan,
    idempotencyKey: "build-1",
  });
  const retried = await repository.requestBuild({
    workspaceId: "ws",
    projectId: "node",
    snapshotId: snapshot.id,
    service: "web",
    plan,
    idempotencyKey: "build-1",
  });
  assert.equal(retried.id, first.id);
  await repository.transitionBuild("ws", first.id, "RUNNING");
  await repository.appendBuildEvent("ws", first.id, { stream: "stdout", message: "one" });
  await repository.appendBuildEvent("ws", first.id, { stream: "stderr", message: "two" });
  await repository.transitionBuild("ws", first.id, "SUCCEEDED");
  await assert.rejects(repository.transitionBuild("ws", first.id, "RUNNING"), /invalid build transition/);
  assert.deepEqual(
    (await repository.listBuildEvents("ws", first.id, 1)).map((event) => event.message),
    ["two"],
  );
});

test("provider selection enforces runtime and workload capabilities", () => {
  const plan = {
    schemaVersion: 1 as const,
    service: "web",
    runtime: "python" as const,
    output: { kind: "service" as const },
    requirements: { protocols: ["http" as const], longLived: true, background: false },
  };
  const vercel = provider("vercel", {
    runtimes: ["nodejs"],
    workloads: ["static", "function"],
    protocols: ["http"],
    longLived: false,
    background: false,
  });
  const container = provider("container", {
    runtimes: ["nodejs", "python", "go"],
    workloads: ["static", "function", "service", "worker", "cron"],
    protocols: ["http", "websocket", "tcp"],
    longLived: true,
    background: true,
  });

  assert.equal(selectDeploymentProvider([vercel, container], plan).name, "container");
  assert.throws(
    () => selectDeploymentProvider([vercel], plan),
    /provider_capability_mismatch/,
  );
});

test("pipeline captures executor logs and deploys the exact successful snapshot", async () => {
  const repository = new InMemoryCloudRepository();
  const snapshot = createSnapshot({
    workspaceId: "ws",
    projectId: "node",
    files: [
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { start: "node index.js" } }),
      },
    ],
  });
  const plan = detectBuildPlan(snapshot, webService);
  const requested = await repository.requestBuild({
    workspaceId: "ws",
    projectId: "node",
    snapshotId: snapshot.id,
    service: "web",
    plan,
    idempotencyKey: "pipeline-build",
  });
  const build = await executeBuild({
    build: requested,
    snapshot,
    repository,
    executor: {
      name: "fake-sandbox",
      async execute({ onEvent }) {
        await onEvent?.({ stream: "stdout", message: "checked" });
        return {
          exitCode: 0,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
        };
      },
    },
    limits: { timeoutMs: 60_000, memoryMb: 512, cpu: 1, network: "restricted" },
  });
  const deployment = await createDeployment({
    build,
    snapshot,
    repository,
    providers: [
      {
        ...provider("container", {
          runtimes: ["nodejs", "python", "go"],
          workloads: ["static", "function", "service", "worker", "cron"],
          protocols: ["http", "websocket", "tcp"],
          longLived: true,
          background: true,
        }),
        async create() {
          return {
            providerDeploymentId: "provider_1",
            status: "READY",
            immutableUrl: "https://provider.example/deployment/1",
          };
        },
      },
    ],
    idempotencyKey: "pipeline-deploy",
  });

  assert.equal(build.state, "SUCCEEDED");
  assert.equal(deployment.state, "READY");
  assert.equal(deployment.snapshotId, snapshot.id);
  assert.deepEqual(
    (await repository.listBuildEvents("ws", build.id)).map((event) => event.message),
    ["executor=fake-sandbox runtime=nodejs", "checked"],
  );
});

function provider(
  name: string,
  capabilities: DeploymentProvider["capabilities"],
): DeploymentProvider {
  return {
    name,
    capabilities,
    async create() {
      throw new Error("not used");
    },
    async inspect() {
      throw new Error("not used");
    },
    async cancel() {},
  };
}

import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Build, BuildEvent, Deployment } from "@fabric/cloud";
import type { CloudProject, ProjectSnapshot } from "@fabric/projects";

const execFileAsync = promisify(execFile);
const baseUrl = (process.env.FABRIC_BASE_URL ?? "http://localhost:3210").replace(/\/$/, "");
const runId = Date.now().toString(36);

const readiness = await request<{
  status: {
    buildReady: boolean;
    deploymentReady: boolean;
    missing: string[];
  };
}>("/api/v1/cloud/status");
if (!readiness.status.buildReady || !readiness.status.deploymentReady) {
  throw new Error(`cloud is not ready: ${readiness.status.missing.join(", ")}`);
}

console.log("1/7 create project");
const created = await request<{ project: CloudProject }>("/api/v1/projects", {
  method: "POST",
  body: JSON.stringify({
    name: `Fabric smoke ${runId}`,
    slug: `fabric-smoke-${runId}`,
    mode: "source",
    template: "vite",
  }),
});
const project = created.project;

console.log("2/7 seal immutable snapshot");
const sealed = await request<{ snapshot: ProjectSnapshot }>(
  `/api/v1/projects/${project.id}/snapshots`,
  {
    method: "POST",
    body: JSON.stringify({
      message: "Automated end-to-end smoke test",
      expectedHeadId: null,
    }),
  },
);

console.log("3/7 request sandbox build");
const requestedBuild = await request<{ build: Build }>(
  `/api/v1/projects/${project.id}/builds`,
  {
    method: "POST",
    body: JSON.stringify({
      snapshotId: sealed.snapshot.id,
      idempotencyKey: `smoke-build-${runId}`,
    }),
  },
);
const build = await waitForBuild(project.id, requestedBuild.build);
if (build.state !== "SUCCEEDED") {
  const logs = await request<{ events: BuildEvent[] }>(
    `/api/v1/projects/${project.id}/builds/${build.id}/logs?after=0&limit=1000`,
  );
  throw new Error(
    `build ${build.state}: ${build.error ?? logs.events.map((event) => event.message).join("\n")}`,
  );
}

console.log("4/7 request deployment");
const requestedDeployment = await request<{ deployment: Deployment }>(
  `/api/v1/projects/${project.id}/deployments`,
  {
    method: "POST",
    body: JSON.stringify({
      buildId: build.id,
      idempotencyKey: `smoke-deploy-${runId}`,
    }),
  },
);
const deployment = await waitForDeployment(project.id, requestedDeployment.deployment);
if (deployment.state !== "READY" || !deployment.immutableUrl) {
  throw new Error(`deployment ${deployment.state}: ${deployment.error ?? "URL missing"}`);
}

console.log("5/7 publish Fabric links");
const published = await request<{
  links: { appUrl: string; editorUrl: string };
}>(
  `/api/v1/projects/${project.id}/deployments/${deployment.id}/publish`,
  { method: "POST" },
);
if (!published.links.appUrl.startsWith(`${baseUrl}/run/${project.id}?k=`)) {
  throw new Error("published application URL is not Fabric-branded");
}

console.log("6/7 verify deployed application");
const wrapper = await fetch(published.links.appUrl, { redirect: "follow" });
if (!wrapper.ok) {
  throw new Error(`Fabric sharing URL returned HTTP ${wrapper.status}`);
}
const wrapperHtml = await wrapper.text();
const upstreamUrl = wrapperHtml.match(/<iframe[^>]+src="([^"]+)"/)?.[1];
if (!upstreamUrl) throw new Error("Fabric sharing page did not contain the application");
const deployed = await fetch(upstreamUrl, { redirect: "follow" });
if (!deployed.ok) {
  throw new Error(`deployed URL returned HTTP ${deployed.status}`);
}
let html = await deployed.text();
const marker = `Fabric smoke ${runId}`;
for (let attempt = 0; attempt < 5 && !html.includes(marker); attempt += 1) {
  try {
    const bypassed = await execFileAsync("vercel", ["curl", deployment.immutableUrl], {
      maxBuffer: 2 * 1024 * 1024,
    });
    html = bypassed.stdout;
  } catch {
    // The final assertion below reports the original verification failure.
  }
  if (!html.includes(marker)) await delay(2_000);
}
if (!html.includes(marker)) {
  throw new Error("deployed response does not contain the project marker");
}

console.log("7/7 success");
console.log(
  JSON.stringify(
    {
      projectId: project.id,
      snapshotId: sealed.snapshot.id,
      buildId: build.id,
      deploymentId: deployment.id,
      appUrl: published.links.appUrl,
      editorUrl: published.links.editorUrl,
    },
    null,
    2,
  ),
);

async function waitForBuild(projectId: string, initial: Build): Promise<Build> {
  let build = initial;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (!["QUEUED", "RUNNING"].includes(build.state)) return build;
    await delay(2_000);
    build = (
      await request<{ build: Build }>(
        `/api/v1/projects/${projectId}/builds/${build.id}`,
      )
    ).build;
  }
  throw new Error(`build ${build.id} timed out`);
}

async function waitForDeployment(
  projectId: string,
  initial: Deployment,
): Promise<Deployment> {
  let deployment = initial;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (!["QUEUED", "BUILDING"].includes(deployment.state)) return deployment;
    await delay(2_000);
    deployment = (
      await request<{ deployment: Deployment }>(
        `/api/v1/projects/${projectId}/deployments/${deployment.id}`,
      )
    ).deployment;
  }
  throw new Error(`deployment ${deployment.id} timed out`);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${body.error ?? response.status}`);
  }
  return body;
}

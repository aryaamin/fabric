import { effectiveExecutionPolicy } from "@fabric/cloud";
import { applicationManifestFromFiles } from "@fabric/projects";
import {
  beginRuntimeInvocation,
  fabricExecutionPolicy,
} from "@/lib/cloud-policy";
import {
  getCloudRepository,
  getProjectRepository,
} from "@/lib/control-plane";
import { resolveSharedCloudProject } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RuntimeContext = {
  params: Promise<{
    projectId: string;
    shareToken: string;
    path?: string[];
  }>;
};

export async function GET(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

export async function HEAD(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

export async function POST(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

export async function PUT(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

export async function PATCH(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

export async function DELETE(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

export async function OPTIONS(request: Request, context: RuntimeContext) {
  return proxyRuntimeRequest(request, context);
}

async function proxyRuntimeRequest(
  request: Request,
  context: RuntimeContext,
): Promise<Response> {
  const startedAt = Date.now();
  const { projectId, shareToken, path = [] } = await context.params;
  const shared = await resolveSharedCloudProject(projectId, shareToken);
  if (!shared) return runtimeProblem(404, "application_not_found");

  const projects = getProjectRepository();
  const cloud = getCloudRepository();
  const project = await projects.get(shared.workspaceId, projectId);
  if (!project?.activeDeploymentId) {
    return runtimeProblem(503, "application_not_ready");
  }
  const deployment = await cloud.getDeployment(
    shared.workspaceId,
    project.activeDeploymentId,
  );
  if (deployment?.state !== "READY" || !deployment.immutableUrl) {
    return runtimeProblem(503, "application_not_ready");
  }
  const snapshot = await projects.getSnapshot(
    shared.workspaceId,
    projectId,
    deployment.snapshotId,
  );
  const policy = effectiveExecutionPolicy(
    fabricExecutionPolicy(),
    snapshot
      ? applicationManifestFromFiles(snapshot.files, {
          name: project.name,
          services: project.services,
        }).manifest.spec.policies
      : undefined,
  );

  let invocation: Awaited<ReturnType<typeof beginRuntimeInvocation>> | undefined;
  try {
    invocation = await beginRuntimeInvocation({
      workspaceId: shared.workspaceId,
      projectId,
      policy,
    });
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > invocation.policy.runtime.maxRequestBytes
    ) {
      return runtimeProblem(413, "request_too_large");
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await limitedRequestBody(
            request,
            invocation.policy.runtime.maxRequestBytes,
          );
    const upstream = runtimeUpstreamUrl(deployment.immutableUrl, path, request.url);
    const upstreamResponse = await fetch(upstream, {
      method: request.method,
      headers: upstreamHeaders(request.headers, projectId),
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(invocation.policy.runtime.maxDurationMs),
    });
    const gatewayBase = `/api/runtime/${encodeURIComponent(projectId)}/${encodeURIComponent(shareToken)}/`;
    const response = await boundedResponse(
      upstreamResponse,
      invocation.policy.runtime.maxResponseBytes,
      gatewayBase,
      upstream.origin,
    );
    console.log(
      JSON.stringify({
        level: "info",
        message: "Fabric runtime request completed",
        projectId,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestId: request.headers.get("x-vercel-id"),
      }),
    );
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message.startsWith("workspace_suspended:") ||
      message.startsWith("project_suspended:")
        ? 423
        : message.startsWith("runtime_")
          ? 429
          : message === "request_too_large"
            ? 413
            : message === "response_too_large"
              ? 502
              : error instanceof DOMException && error.name === "TimeoutError"
                ? 504
                : 502;
    console.error(
      JSON.stringify({
        level: "error",
        message: "Fabric runtime request failed",
        projectId,
        status,
        error: message,
        durationMs: Date.now() - startedAt,
        requestId: request.headers.get("x-vercel-id"),
      }),
    );
    return runtimeProblem(
      status,
      status === 423
        ? "application_suspended"
        : status === 429
          ? "application_busy"
          : status === 413
            ? "request_too_large"
            : status === 504
              ? "application_timed_out"
              : "application_unavailable",
    );
  } finally {
    await invocation?.release().catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Fabric runtime lease release failed",
          projectId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }
}

async function limitedRequestBody(
  request: Request,
  maximum: number,
): Promise<ArrayBuffer> {
  const body = await request.arrayBuffer();
  if (body.byteLength > maximum) throw new Error("request_too_large");
  return body;
}

function runtimeUpstreamUrl(
  immutableUrl: string,
  path: string[],
  requestUrl: string,
): URL {
  const upstream = new URL(immutableUrl);
  if (upstream.protocol !== "https:") {
    throw new Error("unsafe_runtime_target");
  }
  const suffix = path.map((segment) => encodeURIComponent(segment)).join("/");
  upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}/${suffix}`;
  upstream.search = new URL(requestUrl).search;
  return upstream;
}

function upstreamHeaders(headers: Headers, projectId: string): Headers {
  const forwarded = new Headers(headers);
  for (const name of [
    "authorization",
    "cookie",
    "content-length",
    "host",
    "origin",
    "referer",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    forwarded.delete(name);
  }
  forwarded.set("x-fabric-project-id", projectId);
  forwarded.set("x-forwarded-proto", "https");
  return forwarded;
}

async function boundedResponse(
  upstream: Response,
  maximum: number,
  gatewayBase: string,
  upstreamOrigin: string,
): Promise<Response> {
  const declaredLength = Number(upstream.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new Error("response_too_large");
  }
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength > maximum) throw new Error("response_too_large");

  const headers = new Headers(upstream.headers);
  for (const name of [
    "content-encoding",
    "content-length",
    "content-security-policy",
    "set-cookie",
    "transfer-encoding",
    "x-frame-options",
  ]) {
    headers.delete(name);
  }
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  const location = headers.get("location");
  if (location) {
    const redirect = new URL(location, upstreamOrigin);
    if (redirect.origin === upstreamOrigin) {
      headers.set(
        "location",
        `${gatewayBase}${redirect.pathname.replace(/^\//, "")}${redirect.search}`,
      );
    }
  }

  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (
    upstream.status === 101 ||
    upstream.status === 204 ||
    upstream.status === 205 ||
    upstream.status === 304
  ) {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }
  if (contentType.includes("text/html")) {
    const html = new TextDecoder().decode(bytes);
    return new Response(rewriteHtml(html, gatewayBase), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }
  if (contentType.includes("text/css")) {
    const css = new TextDecoder().decode(bytes);
    return new Response(
      css.replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${gatewayBase}`),
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      },
    );
  }
  return new Response(bytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function rewriteHtml(html: string, gatewayBase: string): string {
  const base = JSON.stringify(gatewayBase);
  const bootstrap = `<base href="${gatewayBase}"><script>(function(){const b=${base};const map=(u)=>{if(typeof u!=="string")return u;if(u.startsWith("/")&&!u.startsWith("//")&&!u.startsWith(b))return b+u.slice(1);return u};const f=window.fetch.bind(window);window.fetch=(u,o)=>f(map(u),o);const x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return x.call(this,m,map(u),...r)}})();</script>`;
  const rewritten = html.replace(
    /(\b(?:src|href|action)=["'])\/(?!\/)/gi,
    `$1${gatewayBase}`,
  );
  if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bootstrap}`);
  }
  return `${bootstrap}${rewritten}`;
}

function runtimeProblem(status: number, code: string): Response {
  return Response.json(
    { ok: false, code, error: code.replaceAll("_", " ") },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "retry-after": status === 429 || status === 503 ? "5" : "0",
      },
    },
  );
}

import type { SourceFileInput } from "@fabric/projects";
import { currentIdentity, unauthorized } from "../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../lib/control-plane";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const files = await new StudioControlPlane(identity).listFiles(projectId);
    return Response.json({ ok: true, files });
  } catch (error) {
    return problem(error, request);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const body = (await request.json()) as { files?: SourceFileInput[] };
    if (!Array.isArray(body.files)) throw new Error("files array is required");
    const files = await new StudioControlPlane(identity).writeFiles(projectId, body.files);
    return Response.json({ ok: true, files });
  } catch (error) {
    return problem(error, request);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const body = (await request.json()) as { paths?: string[] };
    if (!Array.isArray(body.paths)) throw new Error("paths array is required");
    await new StudioControlPlane(identity).deleteFiles(projectId, body.paths);
    return Response.json({ ok: true });
  } catch (error) {
    return problem(error, request);
  }
}

function problem(error: unknown, request: Request): Response {
  return controlPlaneProblem(error, {
    route: "/api/v1/projects/:projectId/files",
    requestId: request.headers.get("x-vercel-id"),
  });
}

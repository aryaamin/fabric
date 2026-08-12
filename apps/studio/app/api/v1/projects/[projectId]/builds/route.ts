import { currentIdentity, unauthorized } from "../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../lib/control-plane";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "25");
    const builds = await new StudioControlPlane(identity).listBuilds(projectId, limit);
    return Response.json({ ok: true, builds });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/builds",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const body = (await request.json()) as {
      snapshotId?: string;
      service?: string;
      idempotencyKey?: string;
    };
    if (!body.idempotencyKey?.trim()) throw new Error("idempotencyKey is required");
    const build = await new StudioControlPlane(identity).requestBuild({
      projectId,
      snapshotId: body.snapshotId,
      service: body.service,
      idempotencyKey: body.idempotencyKey,
    });
    return Response.json({ ok: true, build }, { status: 202 });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/builds",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

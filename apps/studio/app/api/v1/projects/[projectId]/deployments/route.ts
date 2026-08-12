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
    const deployments = await new StudioControlPlane(identity).listDeployments(
      projectId,
      limit,
    );
    return Response.json({ ok: true, deployments });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/deployments",
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
      buildId?: string;
      idempotencyKey?: string;
    };
    if (!body.buildId?.trim()) throw new Error("buildId is required");
    if (!body.idempotencyKey?.trim()) throw new Error("idempotencyKey is required");
    const deployment = await new StudioControlPlane(identity).requestDeployment({
      projectId,
      buildId: body.buildId,
      idempotencyKey: body.idempotencyKey,
    });
    return Response.json({ ok: true, deployment }, { status: 202 });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/deployments",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

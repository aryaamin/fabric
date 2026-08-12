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
    const status = await new StudioControlPlane(identity).getProjectCloudStatus(
      projectId,
    );
    return Response.json({ ok: true, status });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/cloud",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const body = (await request.json()) as {
      suspended?: unknown;
      reason?: unknown;
    };
    if (typeof body.suspended !== "boolean") {
      return Response.json(
        { ok: false, code: "invalid_request", error: "suspended must be a boolean" },
        { status: 400 },
      );
    }
    if (
      body.reason !== undefined &&
      (typeof body.reason !== "string" || body.reason.length > 500)
    ) {
      return Response.json(
        {
          ok: false,
          code: "invalid_request",
          error: "reason must be a string of at most 500 characters",
        },
        { status: 400 },
      );
    }
    const status = await new StudioControlPlane(identity).suspendProject(
      projectId,
      body.suspended,
      typeof body.reason === "string" ? body.reason.trim() || undefined : undefined,
    );
    return Response.json({ ok: true, status });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/cloud",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

import { currentIdentity, unauthorized } from "../../../../../lib/auth";
import { StudioControlPlane, controlPlaneProblem } from "../../../../../lib/control-plane";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const result = await new StudioControlPlane(identity).getProject(projectId);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

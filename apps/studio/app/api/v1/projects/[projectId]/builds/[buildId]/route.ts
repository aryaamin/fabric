import { currentIdentity, unauthorized } from "../../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../../lib/control-plane";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; buildId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId, buildId } = await context.params;
    const build = await new StudioControlPlane(identity).getBuild(projectId, buildId);
    return Response.json({ ok: true, build });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/builds/:buildId",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

import { currentIdentity, unauthorized } from "../../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../../lib/control-plane";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; deploymentId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId, deploymentId } = await context.params;
    const deployment = await new StudioControlPlane(identity).getDeployment(
      projectId,
      deploymentId,
    );
    return Response.json({ ok: true, deployment });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/deployments/:deploymentId",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

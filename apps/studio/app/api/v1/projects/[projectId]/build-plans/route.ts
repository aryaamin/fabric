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
    const snapshotId = new URL(request.url).searchParams.get("snapshotId") ?? undefined;
    const plans = await new StudioControlPlane(identity).inspectBuildPlans(
      projectId,
      snapshotId,
    );
    return Response.json({ ok: true, plans });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/build-plans",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

import { currentIdentity, unauthorized } from "../../../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../../../lib/control-plane";

type RouteContext = {
  params: Promise<{ projectId: string; deploymentId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId, deploymentId } = await context.params;
    const published = await new StudioControlPlane(identity).publishProject(
      projectId,
      deploymentId,
    );
    const origin = new URL(request.url).origin;
    return Response.json({
      ok: true,
      links: {
        appUrl: `${origin}/run/${projectId}?k=${encodeURIComponent(published.shareToken)}`,
        editorUrl: `${origin}/projects/${projectId}`,
      },
    });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/deployments/:deploymentId/publish",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

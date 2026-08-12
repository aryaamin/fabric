import { currentIdentity, unauthorized } from "../../../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../../../lib/control-plane";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; buildId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId, buildId } = await context.params;
    const query = new URL(request.url).searchParams;
    const after = parseInteger(query.get("after"), 0);
    const limit = parseInteger(query.get("limit"), 100);
    const events = await new StudioControlPlane(identity).listBuildEvents(
      projectId,
      buildId,
      after,
      limit,
    );
    return Response.json({
      ok: true,
      events,
      nextCursor: events.at(-1)?.sequence ?? after,
    });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/builds/:buildId/logs",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

function parseInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid log cursor");
  return parsed;
}

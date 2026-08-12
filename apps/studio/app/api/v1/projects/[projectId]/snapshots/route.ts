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
    const snapshots = await new StudioControlPlane(identity).listSnapshots(projectId);
    return Response.json({ ok: true, snapshots });
  } catch (error) {
    return problem(error, request);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const body = (await request.json()) as {
      message?: string;
      parentId?: string;
      expectedHeadId?: string | null;
      setHead?: boolean;
    };
    const snapshot = await new StudioControlPlane(identity).sealSnapshot(projectId, body);
    return Response.json({ ok: true, snapshot }, { status: 201 });
  } catch (error) {
    return problem(error, request);
  }
}

function problem(error: unknown, request: Request): Response {
  return controlPlaneProblem(error, {
    route: "/api/v1/projects/:projectId/snapshots",
    requestId: request.headers.get("x-vercel-id"),
  });
}

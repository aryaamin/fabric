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
    const manifest = await new StudioControlPlane(identity).getApplicationManifest(
      projectId,
      snapshotId,
    );
    return Response.json({ ok: true, ...manifest });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/manifest",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    const body = (await request.json()) as { manifest?: unknown };
    if (body.manifest === undefined) {
      return Response.json(
        { ok: false, code: "invalid_request", error: "manifest is required" },
        { status: 400 },
      );
    }
    const manifest = await new StudioControlPlane(identity).writeApplicationManifest(
      projectId,
      body.manifest,
    );
    return Response.json({ ok: true, ...manifest });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/manifest",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

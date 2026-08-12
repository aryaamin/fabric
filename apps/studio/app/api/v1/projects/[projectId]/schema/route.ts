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
    const query = new URL(request.url).searchParams;
    const snapshotId = query.get("snapshotId") ?? undefined;
    const baselineSnapshotId = query.get("baselineSnapshotId") ?? undefined;
    const controlPlane = new StudioControlPlane(identity);
    const [schema, migration, history] = await Promise.all([
      controlPlane.inspectApplicationSchema(projectId, snapshotId),
      controlPlane.previewSchemaMigration(projectId, baselineSnapshotId),
      controlPlane.listSchemaMigrations(projectId),
    ]);
    return Response.json({ ok: true, schema, migration, history });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/schema",
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
      action?: unknown;
      planId?: unknown;
      runId?: unknown;
      reason?: unknown;
    };
    const action =
      body.action === undefined
        ? "approve"
        : typeof body.action === "string"
          ? body.action
          : "";
    if (!["approve", "apply", "rollback"].includes(action)) {
      return Response.json(
        {
          ok: false,
          code: "invalid_request",
          error: "action must be approve, apply, or rollback",
        },
        { status: 400 },
      );
    }
    if (
      (action === "approve" || action === "apply") &&
      (typeof body.planId !== "string" || !body.planId.trim())
    ) {
      return Response.json(
        { ok: false, code: "invalid_request", error: "planId is required" },
        { status: 400 },
      );
    }
    if (
      action === "rollback" &&
      (typeof body.runId !== "string" || !body.runId.trim())
    ) {
      return Response.json(
        { ok: false, code: "invalid_request", error: "runId is required" },
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
    const controlPlane = new StudioControlPlane(identity);
    if (action === "approve") {
      const migration = await controlPlane.approveSchemaMigration(
        projectId,
        body.planId as string,
        typeof body.reason === "string" ? body.reason.trim() || undefined : undefined,
      );
      return Response.json({ ok: true, migration });
    }
    const run =
      action === "apply"
        ? await controlPlane.applySchemaMigration(projectId, body.planId as string)
        : await controlPlane.rollbackSchemaMigration(projectId, body.runId as string);
    return Response.json({ ok: true, run });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects/:projectId/schema",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

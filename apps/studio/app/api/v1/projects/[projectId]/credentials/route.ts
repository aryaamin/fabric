import {
  issueAgentCredential,
  revokeAgentCredential,
  type AgentScope,
} from "../../../../../../lib/agent-auth";
import { currentIdentity, unauthorized } from "../../../../../../lib/auth";
import {
  StudioControlPlane,
  controlPlaneProblem,
} from "../../../../../../lib/control-plane";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    await new StudioControlPlane(identity).getProject(projectId, "owner");
    const body = (await request.json()) as {
      scopes?: AgentScope[];
      expiresAt?: string;
    };
    const credential = await issueAgentCredential({
      identity,
      projectId,
      scopes: body.scopes ?? [],
      expiresAt: body.expiresAt,
    });
    return Response.json({ ok: true, credential }, { status: 201 });
  } catch (error) {
    return problem(error, request);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const { projectId } = await context.params;
    await new StudioControlPlane(identity).getProject(projectId, "owner");
    const body = (await request.json()) as { credentialId?: string };
    if (!body.credentialId) throw new Error("credentialId is required");
    await revokeAgentCredential(identity.workspaceId, projectId, body.credentialId);
    return Response.json({ ok: true });
  } catch (error) {
    return problem(error, request);
  }
}

function problem(error: unknown, request: Request): Response {
  return controlPlaneProblem(error, {
    route: "/api/v1/projects/:projectId/credentials",
    requestId: request.headers.get("x-vercel-id"),
  });
}

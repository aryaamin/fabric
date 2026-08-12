import type { CreateProjectInput, ProjectTemplate } from "@fabric/projects";
import { currentIdentity, unauthorized } from "../../../../lib/auth";
import { StudioControlPlane, controlPlaneProblem } from "../../../../lib/control-plane";

export async function GET(request: Request) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const projects = await new StudioControlPlane(identity).listProjects();
    return Response.json({ ok: true, projects });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

export async function POST(request: Request) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    const input = (await request.json()) as CreateProjectInput & {
      template?: ProjectTemplate;
    };
    const result = await new StudioControlPlane(identity).createProject(input);
    return Response.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    return controlPlaneProblem(error, {
      route: "/api/v1/projects",
      requestId: request.headers.get("x-vercel-id"),
    });
  }
}

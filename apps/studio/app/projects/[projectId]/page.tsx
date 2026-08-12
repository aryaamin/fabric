import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { CloudShell } from "../../../components/CloudShell";
import { CloudProjectWorkbench } from "../../../components/CloudProjectWorkbench";
import { Badge } from "../../../components/ui/Badge";
import { currentIdentity } from "../../../lib/auth";
import {
  ControlPlaneError,
  StudioControlPlane,
} from "../../../lib/control-plane";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const identity = await currentIdentity();
  if (!identity) redirect("/sign-in");
  const { projectId } = await params;
  const controlPlane = new StudioControlPlane(identity);
  try {
    const [{ project, role }, files, snapshots, builds, deployments, manifest] =
      await Promise.all([
        controlPlane.getProject(projectId),
        controlPlane.listFiles(projectId),
        controlPlane.listSnapshots(projectId),
        controlPlane.listBuilds(projectId),
        controlPlane.listDeployments(projectId),
        controlPlane.getApplicationManifest(projectId),
      ]);
    return (
      <CloudShell
        active="projects"
        title={project.name}
        description={`${project.id} · ${project.slug}`}
        actions={
          <>
            <Badge tone="neutral" className="capitalize">
              {role}
            </Badge>
            <Link
              href="/connect"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-2.5 text-[11.5px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              <Bot className="size-3.5" />
              Agent
            </Link>
            {project.activeDeploymentId ? (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ok/25 bg-ok-dim px-2.5 text-[11.5px] font-medium text-ok">
                <ExternalLink className="size-3.5" />
                Live
              </span>
            ) : null}
          </>
        }
      >
        <CloudProjectWorkbench
          project={project}
          role={role as "owner" | "editor" | "viewer"}
          initialFiles={files}
          initialSnapshots={snapshots}
          initialBuilds={builds}
          initialDeployments={deployments}
          initialManifest={manifest}
        />
      </CloudShell>
    );
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) notFound();
    throw error;
  }
}

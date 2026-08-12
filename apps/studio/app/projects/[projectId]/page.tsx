import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
    const [{ project, role }, files, snapshots, builds, deployments] = await Promise.all([
      controlPlane.getProject(projectId),
      controlPlane.listFiles(projectId),
      controlPlane.listSnapshots(projectId),
      controlPlane.listBuilds(projectId),
      controlPlane.listDeployments(projectId),
    ]);
    return (
      <div className="min-h-screen">
        <header className="border-b border-line bg-base/90">
          <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-6">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="text-[15px] text-accent">▚</span>
              <span className="text-[14px] font-semibold">Fabric</span>
            </Link>
            <span className="text-ink-3">/</span>
            <Link href="/projects" className="text-[13px] text-ink-2 hover:text-ink">
              Projects
            </Link>
            <span className="text-ink-3">/</span>
            <span className="truncate text-[13px] text-ink">{project.name}</span>
            <Badge tone="neutral" className="ml-auto capitalize">
              {role}
            </Badge>
          </div>
        </header>
        <main className="mx-auto max-w-[1480px] px-6 py-6">
          <div className="mb-5">
            <h1 className="text-[21px] font-semibold tracking-[-0.025em]">{project.name}</h1>
            <p className="mt-1 font-mono text-[11px] text-ink-3">
              {project.id} · {project.slug}
            </p>
          </div>
          <CloudProjectWorkbench
            project={project}
            role={role as "owner" | "editor" | "viewer"}
            initialFiles={files}
            initialSnapshots={snapshots}
            initialBuilds={builds}
            initialDeployments={deployments}
          />
        </main>
      </div>
    );
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) notFound();
    throw error;
  }
}

import { notFound } from "next/navigation";
import { getCloudRepository, getProjectRepository } from "../../../lib/control-plane";
import { resolveSharedCloudProject } from "../../../lib/workspace";

export const dynamic = "force-dynamic";

export default async function SharedApplicationPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ k?: string | string[] }>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const token = Array.isArray(query.k) ? query.k[0] : query.k;
  const shared = await resolveSharedCloudProject(projectId, token ?? "");
  if (!shared) notFound();

  const project = await getProjectRepository().get(shared.workspaceId, projectId);
  if (!project?.activeDeploymentId) notFound();
  const deployment = await getCloudRepository().getDeployment(
    shared.workspaceId,
    project.activeDeploymentId,
  );
  if (deployment?.state !== "READY" || !deployment.immutableUrl) notFound();

  return (
    <div className="flex h-screen flex-col bg-base">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-4">
        <span className="text-[13px] font-semibold text-accent">▚ Fabric</span>
        <span className="text-ink-3">/</span>
        <span className="truncate text-[12px] text-ink-2">{project.name}</span>
        <span className="ml-auto rounded-full border border-ok/25 bg-ok-dim px-2 py-0.5 text-[10px] font-medium text-ok">
          Live
        </span>
      </header>
      <iframe
        title={project.name}
            src={`/api/runtime/${encodeURIComponent(projectId)}/${encodeURIComponent(token!)}/`}
        className="min-h-0 flex-1 border-0 bg-white"
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
      />
    </div>
  );
}

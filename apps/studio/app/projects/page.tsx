import Link from "next/link";
import { Bot } from "lucide-react";
import { redirect } from "next/navigation";
import { CloudShell } from "../../components/CloudShell";
import { CloudProjectList } from "../../components/CloudProjectList";
import { currentIdentity } from "../../lib/auth";
import { cloudReadiness } from "../../lib/cloud-readiness";
import { StudioControlPlane } from "../../lib/control-plane";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const identity = await currentIdentity();
  if (!identity) redirect("/sign-in");
  const projects = await new StudioControlPlane(identity).listProjects();

  return (
    <CloudShell
      active="projects"
      title="Projects"
      description="Every application in this workspace. Open one to edit, deploy, share, or inspect it."
      actions={
        <Link
          href="/connect"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/30 bg-accent-dim px-3 text-[12px] font-medium text-accent-hi hover:border-accent/50"
        >
          <Bot className="size-3.5" />
          Connect AI
        </Link>
      }
    >
      <CloudProjectList
        readiness={cloudReadiness()}
        initialProjects={projects.map(({ project, role }) => ({
          project,
          role: role as "owner" | "editor" | "viewer",
        }))}
      />
    </CloudShell>
  );
}

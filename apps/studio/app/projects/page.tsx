import Link from "next/link";
import { redirect } from "next/navigation";
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
    <div className="min-h-screen">
      <header className="border-b border-line bg-base/90">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-3 px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="text-[15px] text-accent">▚</span>
            <span className="text-[14px] font-semibold">Fabric</span>
          </Link>
          <span className="text-ink-3">/</span>
          <span className="text-[13px] text-ink-2">Cloud projects</span>
          <Link
            href="/connect"
            className="ml-auto rounded-md border border-accent/30 bg-accent-dim px-3 py-1.5 text-[12px] font-medium text-accent-hi hover:border-accent/50"
          >
            Connect ChatGPT
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1180px] px-6 py-9">
        <section className="mb-9 max-w-[720px]">
          <BadgeLine />
          <h1 className="mt-3 text-[28px] font-semibold tracking-[-0.03em]">
            Cloud infrastructure, exposed as an agent tool.
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            Any AI can write source files through MCP, seal an immutable snapshot, run an
            isolated build, deploy it, and return a shareable URL.
          </p>
        </section>
        <CloudProjectList
          readiness={cloudReadiness()}
          initialProjects={projects.map(({ project, role }) => ({
            project,
            role: role as "owner" | "editor" | "viewer",
          }))}
        />
      </main>
    </div>
  );
}

function BadgeLine() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent-dim px-2.5 py-1 font-mono text-[11px] text-accent-hi">
      <span className="size-1.5 rounded-full bg-ok" />
      Agent cloud control plane
    </div>
  );
}

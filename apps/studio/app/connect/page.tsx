import { headers } from "next/headers";
import Link from "next/link";
import { Bot, Check, KeyRound } from "lucide-react";
import { CloudShell } from "../../components/CloudShell";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${protocol}://${host}` : "https://fabric-control-plane.vercel.app";
  const mcpUrl = `${origin}/api/mcp`;

  return (
    <CloudShell
      active="connections"
      title="Connections"
      description="Authorize an AI to work with the real projects in this workspace."
      actions={
        <Link
          href="/projects"
          className="inline-flex h-8 items-center rounded-md border border-line bg-panel px-3 text-[11.5px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          Back to projects
        </Link>
      }
    >
      <div className="max-w-[760px] space-y-4">
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex items-center gap-3 border-b border-line px-5 py-4">
            <span className="flex size-9 items-center justify-center rounded-lg border border-accent/25 bg-accent-dim text-accent-hi">
              <Bot className="size-4" />
            </span>
            <div>
              <h2 className="text-[13.5px] font-semibold">ChatGPT</h2>
              <p className="text-[11px] text-ink-3">
                Remote MCP connection secured with Fabric OAuth
              </p>
            </div>
          </div>

          <div className="space-y-4 p-5">
            <p className="text-[12px] leading-relaxed text-ink-2">
              In ChatGPT, enable Developer mode, add a custom MCP server, and use
              this endpoint:
            </p>
            <code className="block overflow-x-auto rounded-md border border-line bg-base p-3 font-mono text-[11px] text-ink">
                {mcpUrl}
            </code>
            <div className="flex items-start gap-2.5 rounded-md border border-line-soft bg-base/50 p-3">
              <KeyRound className="mt-0.5 size-3.5 shrink-0 text-accent-hi" />
              <p className="text-[11px] leading-relaxed text-ink-2">
                Fabric will ask you to sign in and approve workspace access. The
                AI can then create or edit the same projects shown on the Projects
                page.
              </p>
            </div>
          </div>
        </section>

        <div className="flex items-start gap-2.5 rounded-lg border border-ok/20 bg-ok-dim/40 p-4">
          <Check className="mt-0.5 size-3.5 shrink-0 text-ok" />
          <div>
            <div className="text-[11.5px] font-medium text-ok">
              Infrastructure stays private
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-2">
              Connections receive Fabric permissions, never provider credentials
              or database secrets.
            </p>
          </div>
        </div>
      </div>
    </CloudShell>
  );
}

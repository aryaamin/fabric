import { headers } from "next/headers";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${protocol}://${host}` : "https://fabric-control-plane.vercel.app";
  const mcpUrl = `${origin}/api/mcp`;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <Link href="/projects" className="text-[12px] text-ink-3 hover:text-ink">
        ← Projects
      </Link>
      <div className="mt-8 rounded-xl border border-line bg-panel p-7">
        <div className="text-[13px] font-semibold text-accent">▚ Fabric</div>
        <h1 className="mt-4 text-2xl font-semibold tracking-[-0.035em]">
          Connect ChatGPT to Fabric
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-2">
          Connect once, then ask ChatGPT to create, build, deploy, and share software.
          Fabric privately manages the cloud, database, credentials, and build environment.
        </p>

        <ol className="mt-7 space-y-5 text-sm text-ink-2">
          <li>
            <span className="mr-3 font-mono text-accent">01</span>
            In ChatGPT, enable Developer mode under Settings → Security and login.
          </li>
          <li>
            <span className="mr-3 font-mono text-accent">02</span>
            Open ChatGPT Plugins, choose the plus button, and add this MCP server:
            <code className="mt-2 block overflow-x-auto rounded-md border border-line bg-base p-3 font-mono text-[11px] text-ink">
              {mcpUrl}
            </code>
          </li>
          <li>
            <span className="mr-3 font-mono text-accent">03</span>
            ChatGPT opens Fabric. Sign in and approve the connection.
          </li>
          <li>
            <span className="mr-3 font-mono text-accent">04</span>
            Ask: “Create a Python calculator, deploy it on Fabric, and give me the
            application and editor links.”
          </li>
        </ol>

        <div className="mt-7 rounded-lg border border-ok/20 bg-ok-dim p-4 text-[12px] leading-relaxed text-ok">
          ChatGPT receives Fabric permissions—not access to the underlying cloud provider
          or database credentials.
        </div>
      </div>
    </main>
  );
}

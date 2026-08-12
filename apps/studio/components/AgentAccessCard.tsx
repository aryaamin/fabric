"use client";

import { useMemo, useState } from "react";
import { Button } from "./ui/Button";
import { Card, CardBody, CardHeader } from "./ui/Card";

interface IssuedCredential {
  id: string;
  token: string;
}

const FULL_AGENT_SCOPES = [
  "project:read",
  "files:write",
  "snapshot:write",
  "build:create",
  "deployment:create",
  "logs:read",
] as const;

export function AgentAccessCard({ projectId }: { projectId: string }) {
  const [credential, setCredential] = useState<IssuedCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const config = useMemo(() => {
    if (!credential || typeof window === "undefined") return "";
    return JSON.stringify(
      {
        mcpServers: {
          fabric: {
            type: "http",
            url: `${window.location.origin}/api/mcp`,
            headers: { Authorization: `Bearer ${credential.token}` },
          },
        },
      },
      null,
      2,
    );
  }, [credential]);

  async function issue() {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: FULL_AGENT_SCOPES }),
      });
      const payload = (await response.json()) as {
        credential?: IssuedCredential;
        error?: string;
      };
      if (!response.ok || !payload.credential) {
        throw new Error(payload.error ?? "Could not issue agent credential");
      }
      setCredential(payload.credential);
      setNotice("Token issued once. Copy it before leaving this page.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!credential) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/credentials`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentialId: credential.id }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Could not revoke token");
      }
      setCredential(null);
      setNotice("Agent token revoked.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyConfig() {
    await navigator.clipboard.writeText(config);
    setNotice("MCP configuration copied.");
  }

  return (
    <Card>
      <CardHeader
        title="Connect any AI"
        subtitle="Issue a project-scoped MCP token."
        actions={
          credential ? (
            <Button
              type="button"
              size="sm"
              variant="danger"
              onClick={() => void revoke()}
              loading={busy}
            >
              Revoke
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void issue()}
              loading={busy}
            >
              Generate config
            </Button>
          )
        }
      />
      <CardBody className="space-y-2">
        {credential ? (
          <>
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-base p-3 font-mono text-[10px] leading-relaxed text-ink-2">
              {config}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full justify-center"
              onClick={() => void copyConfig()}
            >
              Copy MCP configuration
            </Button>
          </>
        ) : (
          <p className="text-[12px] leading-relaxed text-ink-3">
            The token can read and edit this project, seal snapshots, build, deploy, and
            inspect logs. Fabric stores only its hash.
          </p>
        )}
        {notice ? <p className="text-[11.5px] text-ink-3">{notice}</p> : null}
      </CardBody>
    </Card>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import type { Build, BuildEvent, Deployment } from "@fabric/cloud";
import type { CloudProject, ProjectSnapshot, SourceFile } from "@fabric/projects";
import { AgentAccessCard } from "./AgentAccessCard";
import { ShareDialog } from "./ShareDialog";
import { Badge, toneForValue } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Input, Label, Textarea } from "./ui/Input";

interface WorkbenchProps {
  project: CloudProject;
  role: "owner" | "editor" | "viewer";
  initialFiles: SourceFile[];
  initialSnapshots: ProjectSnapshot[];
  initialBuilds: Build[];
  initialDeployments: Deployment[];
}

export function CloudProjectWorkbench({
  project,
  role,
  initialFiles,
  initialSnapshots,
  initialBuilds,
  initialDeployments,
}: WorkbenchProps) {
  const editable = role !== "viewer";
  const [files, setFiles] = useState(initialFiles);
  const [selectedPath, setSelectedPath] = useState(
    preferredFile(initialFiles)?.path ?? "",
  );
  const selectedFile = files.find((file) => file.path === selectedPath);
  const [content, setContent] = useState(selectedFile?.content ?? "");
  const [newPath, setNewPath] = useState("");
  const [headSnapshotId, setHeadSnapshotId] = useState(project.headSnapshotId);
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [builds, setBuilds] = useState(initialBuilds);
  const [deployments, setDeployments] = useState(initialDeployments);
  const [logs, setLogs] = useState<BuildEvent[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const activeBuild = builds[0];
  const activeDeployment = deployments[0];

  const dirty = selectedFile?.encoding === "utf8" && selectedFile.content !== content;
  const canBuild = Boolean(headSnapshotId) && editable && !busy;
  const canDeploy = activeBuild?.state === "SUCCEEDED" && editable && !busy;

  useEffect(() => {
    const file = files.find((candidate) => candidate.path === selectedPath);
    setContent(file?.content ?? "");
  }, [files, selectedPath]);

  useEffect(() => {
    if (!activeBuild || !["QUEUED", "RUNNING"].includes(activeBuild.state)) return;
    const timer = window.setInterval(() => {
      void refreshBuild(activeBuild.id);
      void refreshLogs(activeBuild.id);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [activeBuild?.id, activeBuild?.state]);

  useEffect(() => {
    if (!activeDeployment || !["QUEUED", "BUILDING"].includes(activeDeployment.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshDeployment(activeDeployment.id);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [activeDeployment?.id, activeDeployment?.state]);

  const status = useMemo(
    () => [
      `${files.length} files`,
      `${snapshots.length} snapshots`,
      activeBuild ? `build ${activeBuild.state.toLowerCase()}` : "not built",
    ],
    [files.length, snapshots.length, activeBuild],
  );

  async function saveFile() {
    if (!selectedFile || selectedFile.encoding !== "utf8") return;
    setBusy("save");
    await run(async () => {
      const payload = await api<{ files: SourceFile[] }>(
        `/api/v1/projects/${project.id}/files`,
        {
          method: "PUT",
          body: JSON.stringify({
            files: [{ path: selectedFile.path, content, encoding: "utf8" }],
          }),
        },
      );
      setFiles((current) =>
        current.map((file) => payload.files.find((saved) => saved.path === file.path) ?? file),
      );
      setNotice(`Saved ${selectedFile.path}`);
    });
  }

  async function addFile() {
    const path = newPath.trim();
    if (!path) return;
    setBusy("add");
    await run(async () => {
      const payload = await api<{ files: SourceFile[] }>(
        `/api/v1/projects/${project.id}/files`,
        {
          method: "PUT",
          body: JSON.stringify({ files: [{ path, content: "", encoding: "utf8" }] }),
        },
      );
      setFiles((current) =>
        [...current.filter((file) => file.path !== path), ...payload.files].toSorted((a, b) =>
          a.path.localeCompare(b.path),
        ),
      );
      setSelectedPath(path);
      setNewPath("");
      setNotice(`Created ${path}`);
    });
  }

  async function deleteFile() {
    if (!selectedFile) return;
    setBusy("delete");
    await run(async () => {
      await api(`/api/v1/projects/${project.id}/files`, {
        method: "DELETE",
        body: JSON.stringify({ paths: [selectedFile.path] }),
      });
      const next = files.filter((file) => file.path !== selectedFile.path);
      setFiles(next);
      setSelectedPath(preferredFile(next)?.path ?? "");
      setNotice(`Deleted ${selectedFile.path}`);
    });
  }

  async function sealSnapshot() {
    setBusy("snapshot");
    await run(async () => {
      const payload = await api<{ snapshot: ProjectSnapshot }>(
        `/api/v1/projects/${project.id}/snapshots`,
        {
          method: "POST",
          body: JSON.stringify({
            message: `Snapshot from Fabric Studio`,
            expectedHeadId: headSnapshotId ?? null,
          }),
        },
      );
      setHeadSnapshotId(payload.snapshot.id);
      setSnapshots((current) => [
        payload.snapshot,
        ...current.filter((item) => item.id !== payload.snapshot.id),
      ]);
      setNotice(`Sealed ${shortId(payload.snapshot.id)}`);
    });
  }

  async function requestBuild() {
    setBusy("build");
    await run(async () => {
      const payload = await api<{ build: Build }>(
        `/api/v1/projects/${project.id}/builds`,
        {
          method: "POST",
          body: JSON.stringify({
            snapshotId: headSnapshotId,
            idempotencyKey: `studio-build-${crypto.randomUUID()}`,
          }),
        },
      );
      setBuilds((current) => [payload.build, ...current]);
      setLogs([]);
      setNotice("Build queued in Fabric");
    });
  }

  async function requestDeployment() {
    if (!activeBuild) return;
    setBusy("deploy");
    await run(async () => {
      const payload = await api<{ deployment: Deployment }>(
        `/api/v1/projects/${project.id}/deployments`,
        {
          method: "POST",
          body: JSON.stringify({
            buildId: activeBuild.id,
            idempotencyKey: `studio-deploy-${crypto.randomUUID()}`,
          }),
        },
      );
      setDeployments((current) => [payload.deployment, ...current]);
      setPublishedUrl("");
      setNotice("Fabric deployment queued");
    });
  }

  async function publishDeployment() {
    if (!activeDeployment) return;
    setBusy("publish");
    await run(async () => {
      const payload = await api<{ links: { appUrl: string } }>(
        `/api/v1/projects/${project.id}/deployments/${activeDeployment.id}/publish`,
        { method: "POST" },
      );
      setPublishedUrl(payload.links.appUrl);
      setNotice("Fabric sharing link is ready");
    });
  }

  async function refreshBuild(buildId: string) {
    try {
      const payload = await api<{ build: Build }>(
        `/api/v1/projects/${project.id}/builds/${buildId}`,
      );
      setBuilds((current) =>
        current.map((build) => (build.id === payload.build.id ? payload.build : build)),
      );
    } catch {
      // Keep the last known state; the next polling tick retries.
    }
  }

  async function refreshLogs(buildId: string) {
    try {
      const payload = await api<{ events: BuildEvent[] }>(
        `/api/v1/projects/${project.id}/builds/${buildId}/logs?after=0&limit=500`,
      );
      setLogs(payload.events);
    } catch {
      // Log polling is best-effort and follows build state polling.
    }
  }

  async function refreshDeployment(deploymentId: string) {
    try {
      const payload = await api<{ deployment: Deployment }>(
        `/api/v1/projects/${project.id}/deployments/${deploymentId}`,
      );
      setDeployments((current) =>
        current.map((deployment) =>
          deployment.id === payload.deployment.id ? payload.deployment : deployment,
        ),
      );
    } catch {
      // Keep polling while the Fabric deployment service is still converging.
    }
  }

  async function run(operation: () => Promise<void>) {
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{project.services[0]?.runtime ?? "auto"}</Badge>
        {status.map((item) => (
          <Badge key={item} tone="neutral" mono>
            {item}
          </Badge>
        ))}
        <span className="ml-auto text-[12px] text-ink-3">{notice}</span>
        {role === "owner" ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setShareOpen(true)}>
            Share
          </Button>
        ) : null}
      </div>

      <div className="grid min-h-[580px] gap-4 xl:grid-cols-[220px_minmax(0,1fr)_340px]">
        <Card className="overflow-hidden">
          <CardHeader title="Files" subtitle="Mutable working tree" />
          <div className="border-b border-line-soft p-2">
            <div className="flex gap-1.5">
              <Input
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder="src/index.ts"
                disabled={!editable}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addFile();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void addFile()}
                disabled={!editable || !newPath.trim()}
                loading={busy === "add"}
              >
                Add
              </Button>
            </div>
          </div>
          <nav aria-label="Project files" className="max-h-[500px] overflow-auto p-1.5">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelectedPath(file.path)}
                className={`block w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] ${
                  file.path === selectedPath
                    ? "bg-accent-dim text-accent-hi"
                    : "text-ink-2 hover:bg-hover hover:text-ink"
                }`}
              >
                {file.path}
              </button>
            ))}
          </nav>
        </Card>

        <Card className="flex min-w-0 flex-col overflow-hidden">
          <CardHeader
            title={selectedFile?.path ?? "Select or create a file"}
            subtitle={
              selectedFile?.encoding === "base64"
                ? "Binary file · editing disabled"
                : dirty
                  ? "Unsaved changes"
                  : "Working tree"
            }
            actions={
              selectedFile ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    onClick={() => void deleteFile()}
                    disabled={!editable}
                    loading={busy === "delete"}
                  >
                    Delete
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => void saveFile()}
                    disabled={!editable || !dirty}
                    loading={busy === "save"}
                  >
                    Save
                  </Button>
                </>
              ) : null
            }
          />
          {selectedFile ? (
            <textarea
              aria-label={`Contents of ${selectedFile.path}`}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              readOnly={!editable || selectedFile.encoding !== "utf8"}
              spellCheck={false}
              className="min-h-[520px] flex-1 resize-none bg-[#09090c] p-4 font-mono text-[12px] leading-[1.65] text-ink outline-none"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-ink-3">
              Add a source file to start.
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Release pipeline" subtitle="Snapshot → isolated build → share link" />
            <CardBody className="space-y-4">
              <PipelineStep
                number="1"
                title="Seal snapshot"
                detail={headSnapshotId ? shortId(headSnapshotId) : "No immutable source yet"}
              >
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void sealSnapshot()}
                  disabled={!editable || files.length === 0 || Boolean(busy) || dirty}
                  loading={busy === "snapshot"}
                >
                  Seal current files
                </Button>
              </PipelineStep>
              <PipelineStep
                number="2"
                title="Build"
                detail={activeBuild ? shortId(activeBuild.id) : "Runtime auto-detected"}
                state={activeBuild?.state}
              >
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void requestBuild()}
                  disabled={!canBuild}
                  loading={busy === "build"}
                >
                  Request build
                </Button>
              </PipelineStep>
              <PipelineStep
                number="3"
                title="Deploy"
                detail={activeDeployment ? shortId(activeDeployment.id) : "Fabric web runtime"}
                state={activeDeployment?.state}
              >
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  onClick={() => void requestDeployment()}
                  disabled={!canDeploy}
                  loading={busy === "deploy"}
                >
                  Deploy build
                </Button>
              </PipelineStep>
              {activeDeployment?.state === "READY" && role === "owner" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full justify-center"
                  onClick={() => void publishDeployment()}
                  loading={busy === "publish"}
                >
                  Publish Fabric link
                </Button>
              ) : null}
              {publishedUrl ? (
                <a
                  href={publishedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate rounded-md border border-ok/25 bg-ok-dim px-3 py-2 font-mono text-[11px] text-ok hover:border-ok/50"
                >
                  {publishedUrl}
                </a>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Build output"
              subtitle={activeBuild ? `${activeBuild.state} · ${activeBuild.plan.runtime}` : "No build"}
              actions={
                activeBuild ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void refreshLogs(activeBuild.id)}
                  >
                    Refresh
                  </Button>
                ) : null
              }
            />
            <pre className="max-h-[250px] min-h-[150px] overflow-auto whitespace-pre-wrap p-3 font-mono text-[10.5px] leading-relaxed text-ink-2">
              {logs.length > 0
                ? logs.map((event) => `[${event.stream}] ${event.message}`).join("\n")
                : "Build logs will stream here."}
            </pre>
          </Card>
          {role === "owner" ? <AgentAccessCard projectId={project.id} /> : null}
        </div>
      </div>
      <ShareDialog
        slug={project.slug}
        name={project.name}
        kind="project"
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </div>
  );
}

function PipelineStep({
  number,
  title,
  detail,
  state,
  children,
}: {
  number: string;
  title: string;
  detail: string;
  state?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-raised font-mono text-[10px] text-ink-2">
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium">{title}</span>
          {state ? (
            <Badge tone={toneForValue(state)} mono>
              {state}
            </Badge>
          ) : null}
        </div>
        <p className="mb-2 mt-0.5 truncate font-mono text-[10.5px] text-ink-3">{detail}</p>
        {children}
      </div>
    </div>
  );
}

async function api<T = Record<string, unknown>>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}

function preferredFile(files: SourceFile[]): SourceFile | undefined {
  return (
    files.find((file) => file.path === "package.json") ??
    files.find((file) => file.path === "README.md") ??
    files[0]
  );
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

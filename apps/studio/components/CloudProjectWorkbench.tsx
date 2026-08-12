"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  CloudCog,
  Code2,
  FileCode2,
  GitBranch,
  Share2,
} from "lucide-react";
import type {
  Build,
  BuildEvent,
  Deployment,
  FabricExecutionPolicy,
  WorkspaceUsage,
} from "@fabric/cloud";
import type {
  ApplicationManifest,
  CloudProject,
  LogicalSchema,
  ManifestSource,
  ProjectSnapshot,
  SchemaMigrationPlan,
  SourceFile,
} from "@fabric/projects";
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
  initialManifest: ManifestSource;
}

interface ProjectCloudStatus {
  policy: FabricExecutionPolicy;
  usage: WorkspaceUsage;
  suspended: boolean;
  suspensionReason?: string;
  projectSuspended: boolean;
  projectReason?: string;
}

interface ProjectSchemaStatus {
  schema: {
    projectId: string;
    snapshotId?: string;
    source: ManifestSource["source"];
    schema: LogicalSchema;
  };
  migration: {
    projectId: string;
    baselineSnapshotId?: string;
    current: LogicalSchema;
    desired: LogicalSchema;
    plan: SchemaMigrationPlan;
    approved: boolean;
  };
  history: {
    reviews: {
      planId: string;
      plan: SchemaMigrationPlan;
      state: "approved" | "sealed";
      sealedSnapshotId?: string;
    }[];
    runs: {
      id: string;
      planId: string;
      targetSnapshotId: string;
      state:
        | "backing_up"
        | "applying"
        | "validating"
        | "succeeded"
        | "failed"
        | "rolled_back";
      changedRecords: number;
      deletedRecords: number;
      issues: { message: string }[];
      error?: string;
    }[];
  };
}

export function CloudProjectWorkbench({
  project,
  role,
  initialFiles,
  initialSnapshots,
  initialBuilds,
  initialDeployments,
  initialManifest,
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
  const [cloudStatus, setCloudStatus] = useState<ProjectCloudStatus | null>(null);
  const [applicationManifest, setApplicationManifest] =
    useState<ManifestSource>(initialManifest);
  const [schemaStatus, setSchemaStatus] = useState<ProjectSchemaStatus | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const activeBuild = builds[0];
  const activeDeployment = deployments[0];

  const dirty = selectedFile?.encoding === "utf8" && selectedFile.content !== content;
  const suspended = Boolean(cloudStatus?.suspended || cloudStatus?.projectSuspended);
  const canBuild = Boolean(headSnapshotId) && editable && !busy && !suspended;
  const canDeploy =
    activeBuild?.state === "SUCCEEDED" && editable && !busy && !suspended;

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

  useEffect(() => {
    void refreshCloudStatus();
    void refreshSchema();
  }, [project.id]);

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
      if (selectedFile.path === "fabric.json") {
        await Promise.all([refreshManifest(), refreshSchema()]);
      }
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
      await refreshSchema();
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

  async function refreshCloudStatus() {
    try {
      const payload = await api<{ status: ProjectCloudStatus }>(
        `/api/v1/projects/${project.id}/cloud`,
      );
      setCloudStatus(payload.status);
    } catch {
      // Safety status is supplementary; regular API errors still surface per action.
    }
  }

  async function refreshManifest() {
    const payload = await api<ManifestSource>(
      `/api/v1/projects/${project.id}/manifest`,
    );
    setApplicationManifest(payload);
  }

  async function refreshManifestAction() {
    setBusy("manifest");
    await run(async () => {
      await Promise.all([refreshManifest(), refreshSchema()]);
    });
  }

  async function refreshSchema() {
    try {
      const payload = await api<ProjectSchemaStatus>(
        `/api/v1/projects/${project.id}/schema`,
      );
      setSchemaStatus(payload);
    } catch {
      // Schema intelligence is supplementary until the manifest declares data.
    }
  }

  async function approveCurrentSchemaMigration() {
    if (role !== "owner" || !schemaStatus?.migration.plan.approvalRequired) return;
    setBusy("schema-approve");
    await run(async () => {
      const payload = await api<{
        migration: ProjectSchemaStatus["migration"];
      }>(`/api/v1/projects/${project.id}/schema`, {
        method: "POST",
        body: JSON.stringify({
          planId: schemaStatus.migration.plan.id,
          reason: "Approved from Fabric project editor",
        }),
      });
      setSchemaStatus((current) =>
        current ? { ...current, migration: payload.migration } : current,
      );
      setNotice("Destructive schema migration approved");
    });
  }

  async function applySchemaMigration(planId: string) {
    if (role !== "owner") return;
    setBusy("schema-apply");
    await run(async () => {
      const payload = await api<{
        run: ProjectSchemaStatus["history"]["runs"][number];
      }>(`/api/v1/projects/${project.id}/schema`, {
        method: "POST",
        body: JSON.stringify({ action: "apply", planId }),
      });
      await refreshSchema();
      setNotice(
        payload.run.state === "succeeded"
          ? "Schema migration applied and validated"
          : "Schema migration stopped before commit",
      );
    });
  }

  async function rollbackSchemaMigration(runId: string) {
    if (role !== "owner") return;
    setBusy("schema-rollback");
    await run(async () => {
      await api(`/api/v1/projects/${project.id}/schema`, {
        method: "POST",
        body: JSON.stringify({ action: "rollback", runId }),
      });
      await refreshSchema();
      setNotice("Schema data restored from backup");
    });
  }

  async function toggleSuspension() {
    if (role !== "owner") return;
    const next = !cloudStatus?.projectSuspended;
    setBusy("suspend");
    await run(async () => {
      const payload = await api<{ status: ProjectCloudStatus }>(
        `/api/v1/projects/${project.id}/cloud`,
        {
          method: "PATCH",
          body: JSON.stringify({
            suspended: next,
            reason: next ? "Paused from Fabric Studio" : undefined,
          }),
        },
      );
      setCloudStatus(payload.status);
      if (next) {
        setBuilds((current) =>
          current.map((build) =>
            build.state === "QUEUED" || build.state === "RUNNING"
              ? { ...build, state: "CANCELLED" }
              : build,
          ),
        );
        setDeployments((current) =>
          current.map((deployment) =>
            deployment.state === "QUEUED" || deployment.state === "BUILDING"
              ? { ...deployment, state: "CANCELLED" }
              : deployment,
          ),
        );
      }
      setNotice(next ? "Application suspended" : "Application resumed");
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

  const latestSchemaRun = schemaStatus?.history.runs[0];
  const pendingSchemaReview = schemaStatus?.history.reviews.find(
    (review) =>
      review.state === "sealed" &&
      review.sealedSnapshotId &&
      !schemaStatus.history.runs.some(
        (migrationRun) =>
          migrationRun.planId === review.planId &&
          migrationRun.targetSnapshotId === review.sealedSnapshotId,
      ),
  );

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-line-soft px-2">
          <WorkbenchNav href="#editor" icon={<Code2 className="size-3.5" />}>
            Editor
          </WorkbenchNav>
          <WorkbenchNav
            href="#cloud-inspector"
            icon={<CloudCog className="size-3.5" />}
          >
            Cloud
          </WorkbenchNav>
          <WorkbenchNav href="#activity" icon={<Activity className="size-3.5" />}>
            Activity
          </WorkbenchNav>
          <div className="ml-auto flex items-center gap-2">
            <span className="max-w-[300px] truncate text-[10.5px] text-ink-3">
              {notice}
            </span>
            {role === "owner" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShareOpen(true)}
              >
                <Share2 className="size-3.5" />
                Share
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 bg-base/45 px-3 py-2">
          <Badge tone="accent">{project.services[0]?.runtime ?? "auto"}</Badge>
          {suspended ? <Badge tone="danger">SUSPENDED</Badge> : null}
          {status.map((item) => (
            <Badge key={item} tone="neutral" mono>
              {item}
            </Badge>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[9.5px] text-ink-3">
            <span
              className={`size-1.5 rounded-full ${
                suspended ? "bg-bad" : activeDeployment?.state === "READY" ? "bg-ok" : "bg-ink-3"
              }`}
            />
            {suspended
              ? "runtime suspended"
              : activeDeployment?.state === "READY"
                ? "runtime healthy"
                : "working environment"}
          </span>
        </div>
      </div>

      <div
        id="editor"
        className="grid min-h-[660px] scroll-mt-20 gap-4 xl:grid-cols-[240px_minmax(420px,1fr)_360px]"
      >
        <Card className="overflow-hidden">
          <CardHeader title="Explorer" subtitle={project.slug} />
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
              className={`flex w-full items-center gap-2 truncate rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] ${
                  file.path === selectedPath
                    ? "bg-accent-dim text-accent-hi"
                    : "text-ink-2 hover:bg-hover hover:text-ink"
                }`}
              >
                <FileCode2 className="size-3 shrink-0 opacity-70" />
                <span className="truncate">{file.path}</span>
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
            <>
              <textarea
                aria-label={`Contents of ${selectedFile.path}`}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                readOnly={!editable || selectedFile.encoding !== "utf8"}
                spellCheck={false}
                className="min-h-[570px] flex-1 resize-none bg-[#09090c] p-5 font-mono text-[12px] leading-[1.65] text-ink outline-none"
              />
              <div className="flex h-7 items-center gap-4 border-t border-line-soft bg-accent-dim/45 px-3 font-mono text-[9.5px] text-ink-3">
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3" />
                  working
                </span>
                <span className="ml-auto">{content.split("\n").length} lines</span>
                <span>UTF-8</span>
                <span>{selectedFile.encoding}</span>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-ink-3">
              Add a source file to start.
            </div>
          )}
        </Card>

        <div id="cloud-inspector" className="scroll-mt-20 space-y-4">
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
              title="Safety & usage"
              subtitle="Fabric-enforced runtime controls"
              actions={
                role === "owner" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={cloudStatus?.projectSuspended ? "outline" : "danger"}
                    onClick={() => void toggleSuspension()}
                    loading={busy === "suspend"}
                    disabled={!cloudStatus}
                  >
                    {cloudStatus?.projectSuspended ? "Resume" : "Suspend"}
                  </Button>
                ) : null
              }
            />
            <CardBody className="space-y-2 font-mono text-[10.5px] text-ink-2">
              {cloudStatus ? (
                <>
                  <SafetyRow
                    label="Request timeout"
                    value={`${cloudStatus.policy.runtime.maxDurationMs / 1_000}s`}
                  />
                  <SafetyRow
                    label="Concurrency"
                    value={`${cloudStatus.policy.runtime.maxConcurrency}`}
                  />
                  <SafetyRow
                    label="Requests / min"
                    value={`${cloudStatus.policy.runtime.maxRequestsPerMinute}`}
                  />
                  <SafetyRow
                    label="Builds this hour"
                    value={`${cloudStatus.usage.buildsLastHour}/${cloudStatus.policy.quota.maxBuildsPerHour}`}
                  />
                  <SafetyRow
                    label="Deploys this hour"
                    value={`${cloudStatus.usage.deploymentsLastHour}/${cloudStatus.policy.quota.maxDeploymentsPerHour}`}
                  />
                  <SafetyRow
                    label="Snapshot storage"
                    value={`${formatBytes(cloudStatus.usage.snapshotBytes)}/${formatBytes(cloudStatus.policy.quota.maxSnapshotBytes)}`}
                  />
                </>
              ) : (
                <span className="text-ink-3">Loading safety policy…</span>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Application topology"
              subtitle={`${applicationManifest.source} · ${applicationManifest.manifest.apiVersion}`}
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void refreshManifestAction()}
                  loading={busy === "manifest"}
                >
                  Refresh
                </Button>
              }
            />
            <CardBody className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <TopologyStat
                  label="Triggers"
                  value={applicationManifest.manifest.spec.triggers?.length ?? 0}
                />
                <TopologyStat
                  label="Resources"
                  value={applicationManifest.manifest.spec.resources?.length ?? 0}
                />
                <TopologyStat
                  label="Models"
                  value={applicationManifest.manifest.spec.data?.models.length ?? 0}
                />
              </div>
              <div className="space-y-1.5">
                {applicationManifest.manifest.spec.workloads.map((workload) => (
                  <div
                    key={workload.name}
                    className="flex items-center gap-2 rounded-md border border-line-soft bg-raised px-2.5 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                      {workload.name}
                    </span>
                    <Badge tone="neutral" mono>
                      {workload.kind}
                    </Badge>
                    <Badge tone="accent" mono>
                      {workload.runtime}
                    </Badge>
                  </div>
                ))}
              </div>
              <ManifestConnections manifest={applicationManifest.manifest} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Data schema"
              subtitle={
                schemaStatus
                  ? shortId(schemaStatus.schema.schema.version)
                  : "Inspecting logical models"
              }
              actions={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void refreshSchema()}
                >
                  Refresh
                </Button>
              }
            />
            <CardBody className="space-y-3">
              {schemaStatus ? (
                <>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral" mono>
                      {schemaStatus.schema.schema.models.length} models
                    </Badge>
                    <Badge
                      tone={
                        schemaStatus.migration.plan.classification === "destructive"
                          ? "danger"
                          : schemaStatus.migration.plan.classification ===
                              "backfill_required"
                            ? "warning"
                            : "success"
                      }
                    >
                      {schemaStatus.migration.plan.changes.length === 0
                        ? "no pending changes"
                        : schemaStatus.migration.plan.classification.replace("_", " ")}
                    </Badge>
                    {schemaStatus.migration.approved ? (
                      <Badge tone="success">approved</Badge>
                    ) : null}
                  </div>
                  {schemaStatus.migration.plan.changes.length > 0 ? (
                    <div className="space-y-1.5">
                      {schemaStatus.migration.plan.changes.slice(0, 4).map((change) => (
                        <div
                          key={change.id}
                          className="rounded-md border border-line-soft bg-raised px-2.5 py-2"
                        >
                          <div className="text-[11px] text-ink">{change.summary}</div>
                          <div className="mt-0.5 truncate font-mono text-[9.5px] text-ink-3">
                            {change.path}
                          </div>
                        </div>
                      ))}
                      {schemaStatus.migration.plan.changes.length > 4 ? (
                        <p className="text-[10px] text-ink-3">
                          +{schemaStatus.migration.plan.changes.length - 4} more changes
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-[11px] text-ink-3">
                      Working schema matches the sealed baseline.
                    </p>
                  )}
                  {schemaStatus.migration.plan.approvalRequired &&
                  !schemaStatus.migration.approved &&
                  role === "owner" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      className="w-full justify-center"
                      onClick={() => void approveCurrentSchemaMigration()}
                      loading={busy === "schema-approve"}
                    >
                      Approve destructive changes
                    </Button>
                  ) : null}
                  {pendingSchemaReview && role === "owner" ? (
                    <div className="rounded-md border border-warn/20 bg-warn-dim/30 p-2.5">
                      <p className="text-[11px] font-medium text-ink">
                        Sealed migration ready
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-ink-3">
                        Fabric will back up records, apply backfills, and validate
                        constraints before deployment.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2 w-full justify-center"
                        onClick={() =>
                          void applySchemaMigration(pendingSchemaReview.planId)
                        }
                        loading={busy === "schema-apply"}
                      >
                        Apply and validate
                      </Button>
                    </div>
                  ) : null}
                  {latestSchemaRun ? (
                    <div className="rounded-md border border-line-soft bg-raised p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-ink">
                          Latest migration
                        </span>
                        <Badge
                          tone={
                            latestSchemaRun.state === "succeeded"
                              ? "success"
                              : latestSchemaRun.state === "failed"
                                ? "danger"
                                : latestSchemaRun.state === "rolled_back"
                                  ? "warning"
                                  : "neutral"
                          }
                          mono
                        >
                          {latestSchemaRun.state.replace("_", " ")}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[10px] text-ink-3">
                        {latestSchemaRun.changedRecords} changed ·{" "}
                        {latestSchemaRun.deletedRecords} deleted · backup retained
                      </p>
                      {latestSchemaRun.error ? (
                        <p className="mt-1 text-[10px] leading-relaxed text-bad">
                          {latestSchemaRun.error}
                        </p>
                      ) : null}
                      {latestSchemaRun.issues.slice(0, 2).map((issue, index) => (
                        <p
                          key={`${latestSchemaRun.id}-issue-${index}`}
                          className="mt-1 text-[10px] leading-relaxed text-bad"
                        >
                          {issue.message}
                        </p>
                      ))}
                      {latestSchemaRun.state === "succeeded" &&
                      role === "owner" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-2 w-full justify-center"
                          onClick={() =>
                            void rollbackSchemaMigration(latestSchemaRun.id)
                          }
                          loading={busy === "schema-rollback"}
                        >
                          Restore backup
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : (
                <span className="text-[11px] text-ink-3">Loading schema preview…</span>
              )}
            </CardBody>
          </Card>

          <Card id="activity" className="scroll-mt-20">
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

function WorkbenchNav({
  href,
  icon,
  children,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
    >
      {icon}
      {children}
    </a>
  );
}

function SafetyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function TopologyStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line-soft bg-raised p-2 text-center">
      <div className="font-mono text-[13px] text-ink">{value}</div>
      <div className="mt-0.5 text-[9.5px] uppercase tracking-wide text-ink-3">
        {label}
      </div>
    </div>
  );
}

function ManifestConnections({ manifest }: { manifest: ApplicationManifest }) {
  const triggers = manifest.spec.triggers ?? [];
  const resources = manifest.spec.resources ?? [];
  if (triggers.length === 0 && resources.length === 0) {
    return (
      <p className="text-[11px] text-ink-3">
        No external triggers or managed resources declared.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {triggers.map((trigger) => (
        <Badge key={`trigger-${trigger.name}`} tone="warning" mono>
          {trigger.type}:{trigger.name}
        </Badge>
      ))}
      {resources.map((resource) => (
        <Badge key={`resource-${resource.name}`} tone="success" mono>
          {resource.type}:{resource.name}
        </Badge>
      ))}
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

function formatBytes(value: number): string {
  if (value < 1_048_576) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(value >= 10 * 1_048_576 ? 0 : 1)} MB`;
}

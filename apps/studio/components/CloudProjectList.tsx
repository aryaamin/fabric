"use client";

import Link from "next/link";
import { ChevronRight, CloudCog, Plus, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { CloudProject } from "@fabric/projects";
import type { ProjectTemplate } from "@fabric/projects";
import type { CloudReadiness } from "../lib/cloud-readiness";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Input, Label, Select } from "./ui/Input";

interface ProjectListItem {
  project: CloudProject;
  role: "owner" | "editor" | "viewer";
}

export function CloudProjectList({
  initialProjects,
  readiness,
}: {
  initialProjects: ProjectListItem[];
  readiness: CloudReadiness;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("vite");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), mode: "source", template }),
      });
      const payload = (await response.json()) as {
        project?: CloudProject;
        error?: string;
      };
      if (!response.ok || !payload.project) {
        throw new Error(payload.error ?? "Could not create project");
      }
      router.push(`/projects/${payload.project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  }

  return (
    <div className="space-y-5">
      {!readiness.buildReady || !readiness.deploymentReady ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/20 bg-warn-dim/35 px-4 py-3">
          <CloudCog className="size-4 text-warn" />
          <span className="text-[11.5px] text-ink-2">
            Some project actions are unavailable.
          </span>
          <span className="ml-auto font-mono text-[10px] text-warn">
            {readiness.missing.join(" · ")}
          </span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
        <section className="overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex h-12 items-center border-b border-line px-4">
            <div>
              <h2 className="text-[12.5px] font-semibold">Workspace projects</h2>
              <p className="text-[10.5px] text-ink-3">
                Real applications created here or through a connected AI
              </p>
            </div>
            <span className="ml-auto font-mono text-[10.5px] text-ink-3">
              {initialProjects.length} total
            </span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_110px_100px_92px_28px] gap-3 border-b border-line-soft bg-base/45 px-4 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 max-sm:hidden">
            <span>Application</span>
            <span>Runtime</span>
            <span>Status</span>
            <span>Updated</span>
            <span />
          </div>
          <div className="divide-y divide-line-soft">
            {initialProjects.map(({ project, role }) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="group grid min-h-16 grid-cols-[minmax(0,1fr)_110px_100px_92px_28px] items-center gap-3 px-4 transition-colors hover:bg-hover max-sm:grid-cols-[minmax(0,1fr)_28px]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-raised text-accent-hi">
                    <Server className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[12.5px] font-medium">
                        {project.name}
                      </h3>
                      <span className="text-[9.5px] capitalize text-ink-3">{role}</span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[9.5px] text-ink-3">
                      {project.id}
                    </p>
                  </div>
                </div>
                <span className="font-mono text-[10.5px] text-ink-2 max-sm:hidden">
                  {project.services[0]?.runtime ?? "auto"}
                </span>
                <span className="max-sm:hidden">
                  <Badge
                    tone={
                      project.activeDeploymentId
                        ? "success"
                        : project.headSnapshotId
                          ? "warning"
                          : "neutral"
                    }
                    dot
                  >
                    {project.activeDeploymentId
                      ? "live"
                      : project.headSnapshotId
                        ? "staged"
                        : "draft"}
                  </Badge>
                </span>
                <span className="font-mono text-[9.5px] text-ink-3 max-sm:hidden">
                  {shortDate(project.updatedAt)}
                </span>
                <ChevronRight className="size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
              </Link>
            ))}
            {initialProjects.length === 0 ? (
              <div className="px-5 py-16 text-center">
                <Server className="mx-auto size-6 text-ink-3" />
                <p className="mt-3 text-[12.5px] font-medium">
                  No projects yet
                </p>
                <p className="mt-1 text-[11px] text-ink-3">
                  Create one here or connect an AI to Fabric.
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <Card className="h-fit overflow-hidden">
          <CardHeader
            title="New project"
            subtitle="Start here or ask a connected AI."
          />
          <CardBody>
            <form onSubmit={createProject} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="project-name">Application name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Email categorizer"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="project-template">Starting runtime</Label>
                <Select
                  id="project-template"
                  value={template}
                  onChange={(event) =>
                    setTemplate(event.target.value as ProjectTemplate)
                  }
                >
                  <option value="vite">Vite web application</option>
                  <option value="nextjs">Next.js full-stack</option>
                  <option value="python">Python service</option>
                  <option value="go">Go service</option>
                  <option value="empty">Agent-defined</option>
                </Select>
              </div>
              {error ? <p className="text-[12px] text-bad">{error}</p> : null}
              <Button
                type="submit"
                variant="primary"
                loading={creating}
                className="w-full justify-center"
              >
                <Plus className="size-3.5" />
                Create project
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function shortDate(value: string): string {
  return value.slice(0, 10);
}

"use client";

import Link from "next/link";
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
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-4 py-3">
        <span className="text-[12px] font-medium text-ink-2">Cloud readiness</span>
        <Badge tone={readiness.buildReady ? "success" : "danger"} dot>
          Builds {readiness.buildReady ? "ready" : "blocked"}
        </Badge>
        <Badge tone={readiness.deploymentReady ? "success" : "warning"} dot>
          Deployments {readiness.deploymentReady ? "ready" : "need setup"}
        </Badge>
        <Badge tone="neutral" mono>
          {readiness.mode}
        </Badge>
        {readiness.missing.length > 0 ? (
          <span className="ml-auto text-[11.5px] text-ink-3">
            Missing: {readiness.missing.join(", ")}
          </span>
        ) : null}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-ink-2">Cloud projects</h2>
          <span className="font-mono text-[11.5px] text-ink-3">
            {initialProjects.length} total
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {initialProjects.map(({ project, role }) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="group rounded-lg border border-line bg-panel p-4 transition hover:-translate-y-px hover:border-accent/40 hover:bg-raised"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-[14px] font-medium">{project.name}</h3>
                  <p className="mt-1 truncate font-mono text-[11px] text-ink-3">
                    {project.id}
                  </p>
                </div>
                <Badge tone={project.headSnapshotId ? "success" : "neutral"} dot>
                  {project.headSnapshotId ? "snapshotted" : "draft"}
                </Badge>
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-line-soft pt-3 text-[11.5px] text-ink-3">
                <span>{project.services.length} service</span>
                <span className="capitalize">{role}</span>
              </div>
            </Link>
          ))}
          {initialProjects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line px-5 py-12 text-center text-[13px] text-ink-3 sm:col-span-2">
              No source projects yet. Create one to give any AI a cloud workspace.
            </div>
          ) : null}
        </div>
      </section>

      <Card className="h-fit">
        <CardHeader
          title="New source project"
          subtitle="Fabric manages files, immutable snapshots, builds, and URLs."
        />
        <CardBody>
          <form onSubmit={createProject} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer portal"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-template">Starter</Label>
              <Select
                id="project-template"
                value={template}
                onChange={(event) => setTemplate(event.target.value as ProjectTemplate)}
              >
                <option value="vite">Vite web app</option>
                <option value="nextjs">Next.js app</option>
                <option value="python">Python API</option>
                <option value="go">Go service</option>
                <option value="empty">Empty project</option>
              </Select>
            </div>
            {error ? <p className="text-[12px] text-bad">{error}</p> : null}
            <Button type="submit" variant="primary" loading={creating} className="w-full justify-center">
              Create project
            </Button>
          </form>
        </CardBody>
      </Card>
      </div>
    </div>
  );
}

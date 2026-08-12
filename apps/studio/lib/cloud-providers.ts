import {
  createVercelDeploymentProvider,
  createVercelSandboxExecutor,
} from "@fabric/integrations";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function createStudioSandboxExecutor() {
  return createVercelSandboxExecutor({
    ...sandboxCredentials(),
    images: {
      ...(process.env.VERCEL_SANDBOX_IMAGE_NODE
        ? { nodejs: process.env.VERCEL_SANDBOX_IMAGE_NODE }
        : {}),
      ...(process.env.VERCEL_SANDBOX_IMAGE_PYTHON
        ? { python: process.env.VERCEL_SANDBOX_IMAGE_PYTHON }
        : {}),
      ...(process.env.VERCEL_SANDBOX_IMAGE_GO
        ? { go: process.env.VERCEL_SANDBOX_IMAGE_GO }
        : {}),
    },
  });
}

export function createStudioDeploymentProvider() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is required by the deployment adapter");
  const link = linkedVercelProject();
  return createVercelDeploymentProvider({
    token,
    teamId: process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID ?? link?.orgId,
    projectNamePrefix: process.env.VERCEL_PROJECT_PREFIX ?? "fabric",
  });
}

export function sandboxProviderConfigured(): boolean {
  const link = linkedVercelProject();
  return (
    process.env.VERCEL === "1" ||
    Boolean(process.env.VERCEL_OIDC_TOKEN) ||
    Boolean(
      process.env.VERCEL_TOKEN &&
        (process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID ?? link?.orgId) &&
        (process.env.VERCEL_PROJECT_ID ?? link?.projectId),
    )
  );
}

export function deploymentProviderConfigured(): boolean {
  return Boolean(process.env.VERCEL_TOKEN);
}

export function shouldRunCloudOperationsInline(): boolean {
  if (process.env.FABRIC_CLOUD_EXECUTION_MODE === "inline") return true;
  if (process.env.FABRIC_CLOUD_EXECUTION_MODE === "queue") return false;
  return process.env.NODE_ENV !== "production";
}

function sandboxCredentials() {
  const token = process.env.VERCEL_TOKEN;
  const link = linkedVercelProject();
  const teamId = process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID ?? link?.orgId;
  const projectId = process.env.VERCEL_PROJECT_ID ?? link?.projectId;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

function linkedVercelProject(): { orgId: string; projectId: string } | null {
  try {
    const value = JSON.parse(
      readFileSync(resolve(process.cwd(), ".vercel/project.json"), "utf8"),
    ) as { orgId?: string; projectId?: string };
    return value.orgId && value.projectId
      ? { orgId: value.orgId, projectId: value.projectId }
      : null;
  } catch {
    return null;
  }
}

import { handleCallback } from "@vercel/queue";
import { createDeployment, effectiveExecutionPolicy } from "@fabric/cloud";
import { applicationManifestFromFiles } from "@fabric/projects";
import {
  getCloudRepository,
  getProjectRepository,
} from "../../../../lib/control-plane";
import {
  createStudioDeploymentProvider,
  deploymentProviderConfigured,
} from "../../../../lib/cloud-providers";
import {
  fabricExecutionPolicy,
  projectSuspensionStatus,
  workspaceCloudStatus,
} from "../../../../lib/cloud-policy";
import type { CloudDeploymentMessage } from "../../../../lib/queue";

export const POST = handleCallback<CloudDeploymentMessage>(
  async (message, metadata) => {
    const cloud = getCloudRepository();
    const projects = getProjectRepository();
    const deployment = await cloud.getDeployment(
      message.workspaceId,
      message.deploymentId,
    );
    if (!deployment) throw new Error(`deployment ${message.deploymentId} not found`);
    if (deployment.state !== "QUEUED") return;
    const [workspace, project] = await Promise.all([
      workspaceCloudStatus(message.workspaceId),
      projectSuspensionStatus(message.workspaceId, message.projectId),
    ]);
    if (workspace.suspended || project.suspended) {
      await cloud.transitionDeployment(
        message.workspaceId,
        deployment.id,
        "CANCELLED",
        { error: "Project is suspended" },
      );
      return;
    }
    const build = await cloud.getBuild(message.workspaceId, message.buildId);
    if (!build) throw new Error(`build ${message.buildId} not found`);
    const snapshot = await projects.getSnapshot(
      message.workspaceId,
      message.projectId,
      message.snapshotId,
    );
    if (!snapshot) throw new Error(`snapshot ${message.snapshotId} not found`);
    const cloudProject = await projects.get(message.workspaceId, message.projectId);
    if (!cloudProject) throw new Error(`project ${message.projectId} not found`);
    const policy = effectiveExecutionPolicy(
      fabricExecutionPolicy(),
      applicationManifestFromFiles(snapshot.files, {
        name: cloudProject.name,
        services: cloudProject.services,
      }).manifest.spec.policies,
    );

    if (!deploymentProviderConfigured()) {
      await cloud.transitionDeployment(
        message.workspaceId,
        message.deploymentId,
        "ERROR",
        { error: "Fabric deployment service is not configured" },
      );
      return;
    }
    await createDeployment({
      build,
      snapshot,
      repository: cloud,
      providers: [
        createStudioDeploymentProvider(policy.runtime),
      ],
      idempotencyKey: message.idempotencyKey,
    });
    console.info(
      JSON.stringify({
        level: "info",
        message: "Fabric cloud deployment dispatched",
        deploymentId: deployment.id,
        deliveryCount: metadata.deliveryCount,
      }),
    );
  },
  {
    visibilityTimeoutSeconds: 300,
    retry: (_error, metadata) =>
      metadata.deliveryCount > 5
        ? { acknowledge: true }
        : { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) },
  },
);

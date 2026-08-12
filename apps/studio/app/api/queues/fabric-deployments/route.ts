import { handleCallback } from "@vercel/queue";
import { createDeployment } from "@fabric/cloud";
import {
  getCloudRepository,
  getProjectRepository,
} from "../../../../lib/control-plane";
import {
  createStudioDeploymentProvider,
  deploymentProviderConfigured,
} from "../../../../lib/cloud-providers";
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
    const build = await cloud.getBuild(message.workspaceId, message.buildId);
    if (!build) throw new Error(`build ${message.buildId} not found`);
    const snapshot = await projects.getSnapshot(
      message.workspaceId,
      message.projectId,
      message.snapshotId,
    );
    if (!snapshot) throw new Error(`snapshot ${message.snapshotId} not found`);

    if (!deploymentProviderConfigured()) {
      await cloud.transitionDeployment(
        message.workspaceId,
        message.deploymentId,
        "ERROR",
        { error: "Vercel deployment adapter is not configured" },
      );
      return;
    }
    await createDeployment({
      build,
      snapshot,
      repository: cloud,
      providers: [
        createStudioDeploymentProvider(),
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

import { handleCallback } from "@vercel/queue";
import { executeBuild } from "@fabric/cloud";
import {
  getCloudRepository,
  getProjectRepository,
} from "../../../../lib/control-plane";
import { createStudioSandboxExecutor } from "../../../../lib/cloud-providers";
import type { CloudBuildMessage } from "../../../../lib/queue";

export const POST = handleCallback<CloudBuildMessage>(
  async (message, metadata) => {
    const cloud = getCloudRepository();
    const projects = getProjectRepository();
    const build = await cloud.getBuild(message.workspaceId, message.buildId);
    if (!build) throw new Error(`build ${message.buildId} not found`);
    if (build.projectId !== message.projectId || build.snapshotId !== message.snapshotId) {
      throw new Error("queued build identity mismatch");
    }
    if (build.state !== "QUEUED") return;
    const snapshot = await projects.getSnapshot(
      message.workspaceId,
      message.projectId,
      message.snapshotId,
    );
    if (!snapshot) throw new Error(`snapshot ${message.snapshotId} not found`);

    await executeBuild({
      build,
      snapshot,
      repository: cloud,
      executor: createStudioSandboxExecutor(),
      limits: {
        timeoutMs: 290_000,
        memoryMb: 2_048,
        cpu: 1,
        network: "restricted",
      },
    });
    console.info(
      JSON.stringify({
        level: "info",
        message: "Fabric cloud build processed",
        buildId: build.id,
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

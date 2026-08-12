import {
  deploymentProviderConfigured,
  sandboxProviderConfigured,
  shouldRunCloudOperationsInline,
} from "./cloud-providers";
import { hasDurableDatabase } from "./database";
import { hasDurableQueue } from "./queue";

export interface CloudReadiness {
  mode: "queue" | "inline" | "unavailable";
  database: boolean;
  queue: boolean;
  sandbox: boolean;
  deployment: boolean;
  buildReady: boolean;
  deploymentReady: boolean;
  missing: string[];
}

export function cloudReadiness(): CloudReadiness {
  const database = hasDurableDatabase();
  const queue = hasDurableQueue();
  const sandbox = sandboxProviderConfigured();
  const deployment = deploymentProviderConfigured();
  const inline = !queue && shouldRunCloudOperationsInline();
  const mode = queue ? "queue" : inline ? "inline" : "unavailable";
  const buildReady = queue || (inline && sandbox);
  const deploymentReady = deployment && (queue || inline);
  const missing = [
    ...(!database && mode === "queue" ? ["Fabric durable storage"] : []),
    ...(!queue && !inline ? ["Fabric task runner"] : []),
    ...(!sandbox && inline ? ["Fabric build executor"] : []),
    ...(!deployment ? ["Fabric deployment service"] : []),
  ];
  return {
    mode,
    database,
    queue,
    sandbox,
    deployment,
    buildReady,
    deploymentReady,
    missing,
  };
}

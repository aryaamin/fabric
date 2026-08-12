import type { ExecutionLimits } from "./index.ts";

/**
 * Provider-neutral safety policy. Provider adapters translate this contract
 * into their native function/container controls; the Fabric gateway enforces
 * request and concurrency limits independently of generated application code.
 */
export interface RuntimePolicy {
  maxDurationMs: number;
  memoryMb: number;
  maxConcurrency: number;
  maxRequestsPerMinute: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

export interface WorkspaceQuota {
  maxBuildsPerHour: number;
  maxDeploymentsPerHour: number;
  maxConcurrentBuilds: number;
  maxSnapshotBytes: number;
}

export interface WorkspaceUsage {
  buildsLastHour: number;
  deploymentsLastHour: number;
  concurrentBuilds: number;
  snapshotBytes: number;
}

export interface FabricExecutionPolicy {
  build: ExecutionLimits;
  runtime: RuntimePolicy;
  quota: WorkspaceQuota;
}

export interface ApplicationPolicyOverrides {
  runtime?: Partial<RuntimePolicy>;
  budget?: {
    maxBuildsPerHour?: number;
    maxDeploymentsPerHour?: number;
  };
}

export type QuotaOperation = "build" | "deployment" | "snapshot";

export interface QuotaViolation {
  operation: QuotaOperation;
  limit: keyof WorkspaceQuota;
  used: number;
  maximum: number;
}

export const DEFAULT_EXECUTION_POLICY: FabricExecutionPolicy = {
  build: {
    timeoutMs: 290_000,
    memoryMb: 2_048,
    cpu: 1,
    network: "restricted",
  },
  runtime: {
    maxDurationMs: 10_000,
    memoryMb: 1_024,
    maxConcurrency: 10,
    maxRequestsPerMinute: 120,
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 2_097_152,
  },
  quota: {
    maxBuildsPerHour: 10,
    maxDeploymentsPerHour: 10,
    maxConcurrentBuilds: 2,
    maxSnapshotBytes: 100 * 1_048_576,
  },
};

export function quotaViolation(
  policy: WorkspaceQuota,
  usage: WorkspaceUsage,
  operation: QuotaOperation,
  additionalUnits = 1,
): QuotaViolation | null {
  if (!Number.isFinite(additionalUnits) || additionalUnits < 0) {
    throw new Error("additional quota units must be a non-negative number");
  }
  if (operation === "build") {
    if (usage.buildsLastHour + additionalUnits > policy.maxBuildsPerHour) {
      return {
        operation,
        limit: "maxBuildsPerHour",
        used: usage.buildsLastHour,
        maximum: policy.maxBuildsPerHour,
      };
    }
    if (usage.concurrentBuilds + additionalUnits > policy.maxConcurrentBuilds) {
      return {
        operation,
        limit: "maxConcurrentBuilds",
        used: usage.concurrentBuilds,
        maximum: policy.maxConcurrentBuilds,
      };
    }
  }
  if (
    operation === "deployment" &&
    usage.deploymentsLastHour + additionalUnits > policy.maxDeploymentsPerHour
  ) {
    return {
      operation,
      limit: "maxDeploymentsPerHour",
      used: usage.deploymentsLastHour,
      maximum: policy.maxDeploymentsPerHour,
    };
  }
  if (
    operation === "snapshot" &&
    usage.snapshotBytes + additionalUnits > policy.maxSnapshotBytes
  ) {
    return {
      operation,
      limit: "maxSnapshotBytes",
      used: usage.snapshotBytes,
      maximum: policy.maxSnapshotBytes,
    };
  }
  return null;
}

export function parseExecutionPolicy(
  environment: Record<string, string | undefined>,
): FabricExecutionPolicy {
  const defaults = DEFAULT_EXECUTION_POLICY;
  return {
    build: {
      timeoutMs: boundedInteger(
        environment.FABRIC_BUILD_TIMEOUT_MS,
        defaults.build.timeoutMs,
        1_000,
        300_000,
      ),
      memoryMb: boundedInteger(
        environment.FABRIC_BUILD_MEMORY_MB,
        defaults.build.memoryMb,
        256,
        8_192,
      ),
      cpu: boundedInteger(environment.FABRIC_BUILD_CPU, defaults.build.cpu, 1, 8),
      network:
        environment.FABRIC_BUILD_NETWORK === "none"
          ? "none"
          : defaults.build.network,
    },
    runtime: {
      maxDurationMs: boundedInteger(
        environment.FABRIC_RUNTIME_MAX_DURATION_MS,
        defaults.runtime.maxDurationMs,
        1_000,
        300_000,
      ),
      memoryMb: boundedInteger(
        environment.FABRIC_RUNTIME_MEMORY_MB,
        defaults.runtime.memoryMb,
        128,
        4_096,
      ),
      maxConcurrency: boundedInteger(
        environment.FABRIC_RUNTIME_MAX_CONCURRENCY,
        defaults.runtime.maxConcurrency,
        1,
        1_000,
      ),
      maxRequestsPerMinute: boundedInteger(
        environment.FABRIC_RUNTIME_REQUESTS_PER_MINUTE,
        defaults.runtime.maxRequestsPerMinute,
        1,
        100_000,
      ),
      maxRequestBytes: boundedInteger(
        environment.FABRIC_RUNTIME_MAX_REQUEST_BYTES,
        defaults.runtime.maxRequestBytes,
        1_024,
        100 * 1_048_576,
      ),
      maxResponseBytes: boundedInteger(
        environment.FABRIC_RUNTIME_MAX_RESPONSE_BYTES,
        defaults.runtime.maxResponseBytes,
        1_024,
        100 * 1_048_576,
      ),
    },
    quota: {
      maxBuildsPerHour: boundedInteger(
        environment.FABRIC_QUOTA_BUILDS_PER_HOUR,
        defaults.quota.maxBuildsPerHour,
        1,
        10_000,
      ),
      maxDeploymentsPerHour: boundedInteger(
        environment.FABRIC_QUOTA_DEPLOYMENTS_PER_HOUR,
        defaults.quota.maxDeploymentsPerHour,
        1,
        10_000,
      ),
      maxConcurrentBuilds: boundedInteger(
        environment.FABRIC_QUOTA_CONCURRENT_BUILDS,
        defaults.quota.maxConcurrentBuilds,
        1,
        100,
      ),
      maxSnapshotBytes: boundedInteger(
        environment.FABRIC_QUOTA_SNAPSHOT_BYTES,
        defaults.quota.maxSnapshotBytes,
        1_048_576,
        100 * 1_073_741_824,
      ),
    },
  };
}

/**
 * Applications may voluntarily request stricter limits, but can never loosen
 * the operator-owned Fabric policy.
 */
export function effectiveExecutionPolicy(
  platform: FabricExecutionPolicy,
  requested?: ApplicationPolicyOverrides,
): FabricExecutionPolicy {
  if (!requested) return structuredClone(platform);
  return {
    build: { ...platform.build },
    runtime: {
      maxDurationMs: stricter(
        platform.runtime.maxDurationMs,
        requested.runtime?.maxDurationMs,
      ),
      memoryMb: stricter(platform.runtime.memoryMb, requested.runtime?.memoryMb),
      maxConcurrency: stricter(
        platform.runtime.maxConcurrency,
        requested.runtime?.maxConcurrency,
      ),
      maxRequestsPerMinute: stricter(
        platform.runtime.maxRequestsPerMinute,
        requested.runtime?.maxRequestsPerMinute,
      ),
      maxRequestBytes: stricter(
        platform.runtime.maxRequestBytes,
        requested.runtime?.maxRequestBytes,
      ),
      maxResponseBytes: stricter(
        platform.runtime.maxResponseBytes,
        requested.runtime?.maxResponseBytes,
      ),
    },
    quota: {
      ...platform.quota,
      maxBuildsPerHour: stricter(
        platform.quota.maxBuildsPerHour,
        requested.budget?.maxBuildsPerHour,
      ),
      maxDeploymentsPerHour: stricter(
        platform.quota.maxDeploymentsPerHour,
        requested.budget?.maxDeploymentsPerHour,
      ),
    },
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`policy value must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function stricter(platform: number, requested: number | undefined): number {
  return requested === undefined ? platform : Math.min(platform, requested);
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EXECUTION_POLICY,
  effectiveExecutionPolicy,
  parseExecutionPolicy,
  quotaViolation,
} from "./policy.ts";

test("workspace quotas reject hourly and concurrent overages", () => {
  const quota = DEFAULT_EXECUTION_POLICY.quota;
  const usage = {
    buildsLastHour: quota.maxBuildsPerHour,
    deploymentsLastHour: 0,
    concurrentBuilds: 0,
    snapshotBytes: 0,
  };
  assert.deepEqual(quotaViolation(quota, usage, "build"), {
    operation: "build",
    limit: "maxBuildsPerHour",
    used: quota.maxBuildsPerHour,
    maximum: quota.maxBuildsPerHour,
  });
  assert.equal(
    quotaViolation(
      quota,
      { ...usage, buildsLastHour: 0, concurrentBuilds: quota.maxConcurrentBuilds },
      "build",
    )?.limit,
    "maxConcurrentBuilds",
  );
});

test("application policies can tighten but never loosen platform limits", () => {
  const policy = effectiveExecutionPolicy(DEFAULT_EXECUTION_POLICY, {
    runtime: {
      maxDurationMs: 2_000,
      maxConcurrency: 999,
    },
    budget: {
      maxBuildsPerHour: 3,
      maxDeploymentsPerHour: 999,
    },
  });
  assert.equal(policy.runtime.maxDurationMs, 2_000);
  assert.equal(
    policy.runtime.maxConcurrency,
    DEFAULT_EXECUTION_POLICY.runtime.maxConcurrency,
  );
  assert.equal(policy.quota.maxBuildsPerHour, 3);
  assert.equal(
    policy.quota.maxDeploymentsPerHour,
    DEFAULT_EXECUTION_POLICY.quota.maxDeploymentsPerHour,
  );
});

test("execution policy accepts bounded operator overrides", () => {
  const policy = parseExecutionPolicy({
    FABRIC_RUNTIME_MAX_DURATION_MS: "5000",
    FABRIC_QUOTA_BUILDS_PER_HOUR: "4",
    FABRIC_BUILD_NETWORK: "none",
  });
  assert.equal(policy.runtime.maxDurationMs, 5_000);
  assert.equal(policy.quota.maxBuildsPerHour, 4);
  assert.equal(policy.build.network, "none");
  assert.throws(
    () => parseExecutionPolicy({ FABRIC_RUNTIME_MAX_DURATION_MS: "999999" }),
    /policy value/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  claimWorkspaceQuota,
  setWorkspaceSuspended,
  workspaceCloudStatus,
} from "./cloud-policy.ts";

test("usage claims are idempotent and enforce workspace quotas", async () => {
  const workspaceId = `ws_policy_${Date.now()}`;
  await claimWorkspaceQuota({
    workspaceId,
    operation: "build",
    idempotencyKey: "same-build",
  });
  await claimWorkspaceQuota({
    workspaceId,
    operation: "build",
    idempotencyKey: "same-build",
  });
  assert.equal((await workspaceCloudStatus(workspaceId)).usage.buildsLastHour, 1);

  for (let index = 1; index < 10; index += 1) {
    await claimWorkspaceQuota({
      workspaceId,
      operation: "build",
      idempotencyKey: `build-${index}`,
    });
  }
  await assert.rejects(
    claimWorkspaceQuota({
      workspaceId,
      operation: "build",
      idempotencyKey: "over-limit",
    }),
    /quota_exceeded/,
  );
});

test("suspended workspaces reject cloud operations", async () => {
  const workspaceId = `ws_suspend_${Date.now()}`;
  await setWorkspaceSuspended({
    workspaceId,
    suspended: true,
    principalId: "usr_owner",
    reason: "manual kill switch",
  });
  await assert.rejects(
    claimWorkspaceQuota({
      workspaceId,
      operation: "deployment",
      idempotencyKey: "blocked",
    }),
    /workspace_suspended/,
  );
  await setWorkspaceSuspended({
    workspaceId,
    suspended: false,
    principalId: "usr_owner",
  });
  await claimWorkspaceQuota({
    workspaceId,
    operation: "deployment",
    idempotencyKey: "allowed",
  });
});

test("application build budgets are scoped per project", async () => {
  const workspaceId = `ws_project_budget_${Date.now()}`;
  const base = (await workspaceCloudStatus(workspaceId)).policy;
  const policy = {
    ...base,
    quota: { ...base.quota, maxBuildsPerHour: 1 },
  };
  await claimWorkspaceQuota({
    workspaceId,
    projectId: "prj_a",
    operation: "build",
    idempotencyKey: "a-1",
    policy,
  });
  await claimWorkspaceQuota({
    workspaceId,
    projectId: "prj_b",
    operation: "build",
    idempotencyKey: "b-1",
    policy,
  });
  await assert.rejects(
    claimWorkspaceQuota({
      workspaceId,
      projectId: "prj_a",
      operation: "build",
      idempotencyKey: "a-2",
      policy,
    }),
    /project maxBuildsPerHour/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationManifestFromFiles,
  defineApplicationManifest,
  manifestProjectServices,
  parseApplicationManifest,
  serializeApplicationManifest,
} from "./manifest.ts";
import { createSnapshot } from "./index.ts";

test("application manifests describe UI and headless cloud topology", () => {
  const manifest = defineApplicationManifest({
    metadata: {
      name: "mail-categorizer",
      description: "Categorize incoming mail without a user interface.",
    },
    spec: {
      workloads: [
        {
          name: "categorizer",
          kind: "worker",
          runtime: "python",
          root: ".",
          entry: "main.py",
          startCommand: ["python", "main.py"],
        },
      ],
      resources: [
        { name: "jobs", type: "durable_queue" },
        { name: "mail", type: "connector" },
        { name: "records", type: "relational_database" },
      ],
      triggers: [
        {
          name: "new-mail",
          type: "event",
          workload: "categorizer",
          source: "mail",
          event: "message.received",
        },
      ],
      data: {
        models: [
          {
            name: "Message",
            fields: [
              { name: "subject", type: "string", required: true },
              { name: "category", type: "enum", enum: ["work", "personal", "other"] },
            ],
          },
        ],
      },
      secrets: [
        { name: "MAIL_OAUTH", required: true, workloads: ["categorizer"] },
      ],
      permissions: {
        roles: [{ name: "owner" }, { name: "reviewer" }],
        default: "deny",
        rules: [
          {
            effect: "allow",
            roles: ["reviewer"],
            actions: ["read"],
            resources: ["data.Message"],
          },
        ],
      },
      policies: {
        runtime: { maxDurationMs: 30_000, maxConcurrency: 2 },
        budget: { maxMonthlySpendUsd: 20 },
      },
    },
  });

  assert.equal(parseApplicationManifest(serializeApplicationManifest(manifest)).metadata.name, "mail-categorizer");
  assert.deepEqual(manifestProjectServices(manifest), [
    {
      name: "categorizer",
      kind: "worker",
      runtime: "python",
      root: ".",
      startCommand: ["python", "main.py"],
    },
  ]);
});

test("manifest validation rejects broken topology references", () => {
  const base = {
    apiVersion: "fabric.dev/v1alpha1",
    kind: "Application",
    metadata: { name: "broken" },
    spec: {
      workloads: [{ name: "web", kind: "web", runtime: "nodejs", root: "." }],
      triggers: [
        {
          name: "missing-worker",
          type: "manual",
          workload: "does-not-exist",
        },
      ],
    },
  };
  assert.throws(
    () => parseApplicationManifest(base),
    /references unknown workload/,
  );
  assert.throws(
    () =>
      parseApplicationManifest({
        ...base,
        spec: {
          workloads: [
            { name: "web", kind: "web", runtime: "nodejs", root: "../unsafe" },
          ],
        },
      }),
    /safe project-relative path/,
  );
});

test("legacy projects receive an inferred manifest", () => {
  const result = applicationManifestFromFiles([], {
    name: "Existing App",
    services: [{ name: "web", kind: "web", root: ".", runtime: "auto" }],
  });
  assert.equal(result.source, "inferred");
  assert.equal(result.manifest.spec.workloads[0]?.name, "web");
  assert.equal(result.manifest.spec.triggers?.[0]?.type, "http");
});

test("snapshot sealing rejects an invalid declared manifest", () => {
  assert.throws(
    () =>
      createSnapshot({
        workspaceId: "ws",
        projectId: "prj",
        files: [
          {
            path: "fabric.json",
            content: JSON.stringify({
              apiVersion: "fabric.dev/v1alpha1",
              kind: "Application",
              metadata: { name: "Broken" },
              spec: { workloads: [] },
            }),
          },
        ],
      }),
    /workloads must not be empty/,
  );
});

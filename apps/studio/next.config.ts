import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * The @fabric/* packages ship TypeScript source directly (exports map to
 * `src/index.ts`), so Next must transpile them rather than expecting built
 * JS. In a production monorepo these would be built with tsup; for the
 * foundation we keep source-only to stay zero-build.
 */
const config: NextConfig = {
  // Pin the workspace root so Next doesn't infer it from an unrelated parent
  // lockfile (this app lives in a monorepo under /home/arya/Fabric).
  turbopack: {
    root: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  },
  transpilePackages: [
    "@fabric/ir",
    "@fabric/runtime",
    "@fabric/storage",
    "@fabric/interpreter",
    "@fabric/orchestrator",
    "@fabric/workspace",
    "@fabric/capabilities",
    "@fabric/registry",
    "@fabric/permissions",
    "@fabric/events",
    "@fabric/connections",
    "@fabric/versioning",
    "@fabric/projects",
    "@fabric/cloud",
    "@fabric/mcp",
    "@fabric/validator",
    "@fabric/benchmark",
  ],
};

export default config;

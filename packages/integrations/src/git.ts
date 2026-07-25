import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AppDocument } from "@fabric/ir";
import { validateApp, type CapabilityManifestLite } from "@fabric/validator";

export interface GitMirrorEntry {
  appId: string;
  version: string;
  path: string;
}

export interface GitMirror {
  generatedAt: string;
  authority: "fabric";
  apps: GitMirrorEntry[];
}

export async function writeGitMirror(
  repoRoot: string,
  apps: { document: AppDocument; version: string }[],
): Promise<GitMirror> {
  const root = resolve(repoRoot);
  const entries: GitMirrorEntry[] = [];
  for (const app of apps) {
    const relative = join("fabric", "apps", app.document.id, "app.fabric.json");
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(app.document, null, 2)}\n`, "utf8");
    entries.push({ appId: app.document.id, version: app.version, path: relative });
  }
  const mirror: GitMirror = {
    generatedAt: new Date().toISOString(),
    authority: "fabric",
    apps: entries,
  };
  await mkdir(join(root, "fabric"), { recursive: true });
  await writeFile(join(root, "fabric", "mirror.json"), `${JSON.stringify(mirror, null, 2)}\n`);
  return mirror;
}

export async function readGitProposal(
  path: string,
  capabilities: CapabilityManifestLite[] = [],
): Promise<AppDocument> {
  const document = JSON.parse(await readFile(path, "utf8")) as AppDocument;
  const result = validateApp(document, { capabilities });
  if (!result.ok) {
    throw new Error(
      `invalid Fabric proposal:\n${result.diagnostics
        .filter((item) => item.level === "error")
        .map((item) => `${item.path}: ${item.message}`)
        .join("\n")}`,
    );
  }
  return document;
}

export async function commitGitMirror(
  repoRoot: string,
  message: string,
  paths: string[] = ["fabric"],
): Promise<void> {
  await runGit(repoRoot, ["add", "--", ...paths]);
  await runGit(repoRoot, ["commit", "-m", message]);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`));
    });
  });
}

export function githubValidationWorkflow(): string {
  return `name: Validate Fabric apps
on:
  pull_request:
    paths:
      - "fabric/apps/**/*.fabric.json"
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run fabric -- validate fabric/apps/*/app.fabric.json
`;
}

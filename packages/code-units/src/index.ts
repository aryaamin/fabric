import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import type { CodeUnitRef } from "@fabric/ir";

export interface CodeUnitInvocation {
  unit: CodeUnitRef;
  input: Record<string, unknown>;
  appId: string;
  workspaceId: string;
  codeRoot: string;
  signal?: AbortSignal;
}

export interface CodeUnitRunner {
  run(invocation: CodeUnitInvocation): Promise<unknown>;
}

export interface CodeUnitContext {
  appId: string;
  workspaceId: string;
  signal?: AbortSignal;
}

export type NodeCodeUnit = (
  input: Record<string, unknown>,
  context: CodeUnitContext,
) => unknown | Promise<unknown>;

export function digestCode(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export async function digestFile(path: string): Promise<string> {
  return digestCode(await readFile(path));
}

/**
 * Trusted-development runner.
 *
 * It verifies the content pin before every invocation and constrains entries to
 * codeRoot. It is intentionally not a security sandbox: production hosts should
 * inject a CodeUnitRunner backed by an isolated worker or microVM.
 */
export class LocalCodeUnitRunner implements CodeUnitRunner {
  async run(invocation: CodeUnitInvocation): Promise<unknown> {
    const entry = safeEntry(invocation.codeRoot, invocation.unit.entry);
    const actual = await digestFile(entry);
    if (actual !== invocation.unit.digest) {
      throw new Error(
        `code unit "${invocation.unit.name}" digest mismatch: expected ${invocation.unit.digest}, got ${actual}`,
      );
    }

    if (invocation.unit.runtime === "node") {
      return this.runNode(entry, invocation);
    }
    return this.runPython(entry, invocation);
  }

  private async runNode(entry: string, invocation: CodeUnitInvocation): Promise<unknown> {
    const url = `${pathToFileURL(entry).href}?digest=${encodeURIComponent(invocation.unit.digest)}`;
    const mod = (await import(url)) as { default?: unknown; run?: unknown };
    const fn = mod.run ?? mod.default;
    if (typeof fn !== "function") {
      throw new Error(`node code unit "${invocation.unit.name}" must export run() or default`);
    }
    const value = await (fn as NodeCodeUnit)(invocation.input, {
      appId: invocation.appId,
      workspaceId: invocation.workspaceId,
      signal: invocation.signal,
    });
    return jsonBoundary(value, invocation.unit.name);
  }

  private runPython(entry: string, invocation: CodeUnitInvocation): Promise<unknown> {
    const timeoutMs = invocation.unit.timeoutMs ?? 30_000;
    const harness = [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('fabric_unit',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "payload=json.load(sys.stdin)",
      "out=mod.run(payload['input'],payload['context'])",
      "print(json.dumps(out))",
    ].join(";");

    return new Promise((resolvePromise, reject) => {
      const child = spawn("python3", ["-c", harness, entry], {
        stdio: ["pipe", "pipe", "pipe"],
        signal: invocation.signal,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`python code unit "${invocation.unit.name}" failed: ${stderr.trim()}`));
          return;
        }
        try {
          resolvePromise(jsonBoundary(JSON.parse(stdout), invocation.unit.name));
        } catch {
          reject(new Error(`python code unit "${invocation.unit.name}" returned invalid JSON`));
        }
      });
      child.stdin.end(
        JSON.stringify({
          input: invocation.input,
          context: { appId: invocation.appId, workspaceId: invocation.workspaceId },
        }),
      );
    });
  }
}

function jsonBoundary(value: unknown, unit: string): unknown {
  if (value === undefined) throw new Error(`code unit "${unit}" returned undefined, not JSON`);
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw new Error(`code unit "${unit}" returned a non-JSON value`);
  }
}

function safeEntry(codeRoot: string, entry: string): string {
  const root = resolve(codeRoot);
  const target = resolve(root, entry);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`code unit entry escapes code root: ${entry}`);
  }
  if (target === dirname(target)) throw new Error(`invalid code unit entry: ${entry}`);
  return target;
}

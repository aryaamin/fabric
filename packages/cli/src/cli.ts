#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AppDocument } from "@fabric/ir";
import { Runtime, aiCapabilityFactory, notificationsCapabilityFactory } from "@fabric/runtime";
import { storageCapabilityFactory } from "@fabric/storage";
import { validateApp } from "@fabric/validator";
import { LocalCodeUnitRunner, digestFile } from "@fabric/code-units";
import { FabricHost } from "@fabric/host";
import { createNodeServer } from "@fabric/host/node";
import { FabricMcpServer } from "@fabric/mcp";
import {
  openApiCapabilityFactory,
  writeGitMirror,
  type OpenApiDocument,
} from "@fabric/integrations";

const [, , command = "help", ...args] = process.argv;

try {
  switch (command) {
    case "run":
      await run(args);
      break;
    case "mcp":
      await mcp(args);
      break;
    case "validate":
      await validate(args);
      break;
    case "digest":
      await digest(args);
      break;
    case "git-export":
      await gitExport(args);
      break;
    case "openapi-inspect":
      await openapiInspect(args);
      break;
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      throw new Error(`unknown command "${command}"`);
  }
} catch (error) {
  console.error(`fabric: ${(error as Error).message}`);
  process.exitCode = 1;
}

async function run(args: string[]): Promise<void> {
  const paths = positional(args);
  if (paths.length === 0) throw new Error("run needs at least one app.fabric.json");
  const firstPath = paths[0]!;
  const port = Number(option(args, "--port") ?? process.env.PORT ?? 7777);
  const workspaceId = option(args, "--workspace") ?? "local";
  const codeRoot = resolve(option(args, "--code-root") ?? dirname(resolve(firstPath)));
  const host = await createHost(paths, workspaceId, codeRoot);
  const server = createNodeServer(host);
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
  console.log(`Fabric host listening on http://localhost:${port}`);
  console.log(`  GET  /apps`);
  console.log(`  GET  /apps/:id/views/:view`);
  console.log(`  POST /apps/:id/actions/:action`);
}

async function mcp(args: string[]): Promise<void> {
  const paths = positional(args);
  if (paths.length === 0) throw new Error("mcp needs at least one app.fabric.json");
  const firstPath = paths[0]!;
  const workspaceId = option(args, "--workspace") ?? "local";
  const codeRoot = resolve(option(args, "--code-root") ?? dirname(resolve(firstPath)));
  const host = await createHost(paths, workspaceId, codeRoot);
  await new FabricMcpServer({ host }).serveStdio();
}

async function validate(args: string[]): Promise<void> {
  const paths = positional(args);
  if (paths.length === 0) throw new Error("validate needs at least one app.fabric.json");
  for (const path of paths) {
    const document = await readJson<AppDocument>(path);
    const result = validateApp(document);
    for (const diagnostic of result.diagnostics) {
      console.log(`${diagnostic.level.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}`);
    }
    if (!result.ok) throw new Error(`${path} is invalid`);
    console.log(`✓ ${path}`);
  }
}

async function digest(args: string[]): Promise<void> {
  const path = positional(args)[0];
  if (!path) throw new Error("digest needs a code-unit file");
  console.log(await digestFile(path));
}

async function gitExport(args: string[]): Promise<void> {
  const paths = positional(args);
  const repo = paths.shift();
  if (!repo || paths.length === 0) {
    throw new Error("git-export usage: fabric git-export <repo> <app.fabric.json...>");
  }
  const apps = await Promise.all(
    paths.map(async (path) => {
      const document = await readJson<AppDocument>(path);
      return { document, version: "working-tree" };
    }),
  );
  const mirror = await writeGitMirror(repo, apps);
  console.log(`Wrote ${mirror.apps.length} app(s) to ${resolve(repo, "fabric")}`);
}

async function openapiInspect(args: string[]): Promise<void> {
  const path = positional(args)[0];
  if (!path) throw new Error("openapi-inspect needs an OpenAPI JSON file");
  const document = await readJson<OpenApiDocument>(path);
  const factory = openApiCapabilityFactory(document);
  console.log(JSON.stringify(factory.manifest, null, 2));
}

async function createHost(
  paths: string[],
  workspaceId: string,
  codeRoot: string,
): Promise<FabricHost> {
  const runtime = new Runtime({
    codeUnitRunner: new LocalCodeUnitRunner(),
    codeRoot,
  });
  runtime.registry.register(storageCapabilityFactory());
  runtime.registry.register(notificationsCapabilityFactory());
  runtime.registry.register(aiCapabilityFactory());
  const host = new FabricHost({ runtime, workspaceId });
  for (const path of paths) {
    host.install(
      { document: await readJson<AppDocument>(path), message: `loaded from ${path}` },
      { id: "cli", roles: ["owner"] },
    );
  }
  return host;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.startsWith("--")) i++;
    else if (args[i]) out.push(args[i]!);
  }
  return out;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function help(): void {
  console.log(`Fabric CLI

  fabric run <app.fabric.json...> [--port 7777] [--code-root .]
  fabric mcp <app.fabric.json...> [--code-root .]
  fabric validate <app.fabric.json...>
  fabric digest <code-file>
  fabric git-export <repo> <app.fabric.json...>
  fabric openapi-inspect <openapi.json>
`);
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryProjectRepository,
  createSnapshot,
  normalizeSourceFiles,
  projectTemplateFiles,
  verifySnapshot,
} from "./index.ts";

test("source snapshots are canonical and content addressed", () => {
  const input = {
    workspaceId: "ws_1",
    projectId: "prj_1",
    parentId: "snap_parent",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [
      { path: "src/index.ts", content: "console.log('ok')\r\n" },
      { path: "package.json", content: "{}\n" },
    ],
  };
  const first = createSnapshot(input);
  const second = createSnapshot({ ...input, files: [...input.files].reverse() });

  assert.equal(first.id, second.id);
  assert.equal(first.treeDigest, second.treeDigest);
  assert.deepEqual(
    first.files.map((file) => file.path),
    ["package.json", "src/index.ts"],
  );
  assert.equal(first.files[1]?.content, "console.log('ok')\n");
  assert.doesNotThrow(() => verifySnapshot(first));
});

test("snapshot verification rejects modified content", () => {
  const snapshot = createSnapshot({
    workspaceId: "ws_1",
    projectId: "prj_1",
    files: [{ path: "main.py", content: "print('safe')\n" }],
  });
  snapshot.files[0]!.content = "print('changed')\n";

  assert.throws(() => verifySnapshot(snapshot), /digest mismatch/);
});

test("normalization rejects traversal and case collisions", () => {
  assert.throws(
    () => normalizeSourceFiles([{ path: "../secret", content: "x" }]),
    /unsafe project path/,
  );
  assert.throws(
    () =>
      normalizeSourceFiles([
        { path: "README.md", content: "one" },
        { path: "readme.md", content: "two" },
      ]),
    /case-colliding/,
  );
  assert.throws(
    () => normalizeSourceFiles([{ path: ".env.local", content: "TOKEN=secret" }]),
    /cannot be snapshotted/,
  );
  assert.throws(
    () => normalizeSourceFiles([{ path: ".git/config", content: "unsafe" }]),
    /reserved project path/,
  );
});

test("repository seals atomically and enforces head compare-and-swap", async () => {
  const repository = new InMemoryProjectRepository();
  const project = await repository.create("ws_1", { id: "prj_1", name: "Example" });
  await repository.writeFiles("ws_1", project.id, [
    { path: "package.json", content: '{"scripts":{"start":"node index.js"}}' },
    { path: "index.js", content: "console.log('v1')\n" },
  ]);
  const first = await repository.sealSnapshot("ws_1", project.id, {
    expectedHeadId: null,
    message: "initial",
  });

  await repository.writeFiles("ws_1", project.id, [
    { path: "index.js", content: "console.log('v2')\n" },
  ]);
  await assert.rejects(
    repository.sealSnapshot("ws_1", project.id, { expectedHeadId: null }),
    /head changed/,
  );
  const second = await repository.sealSnapshot("ws_1", project.id, {
    expectedHeadId: first.id,
    message: "update",
  });

  assert.equal(second.parentId, first.id);
  assert.equal((await repository.get("ws_1", project.id))?.headSnapshotId, second.id);
  assert.equal((await repository.listSnapshots("ws_1", project.id)).length, 2);
});

test("language starter templates are safe snapshot inputs", () => {
  for (const template of ["vite", "nextjs", "python", "go"] as const) {
    const files = projectTemplateFiles(template, `Example <${template}>`);
    assert(files.length > 0);
    assert.doesNotThrow(() => normalizeSourceFiles(files));
    assert.equal(files.some((file) => file.path.startsWith(".env")), false);
  }
  assert.deepEqual(projectTemplateFiles("empty", "Empty"), []);
});

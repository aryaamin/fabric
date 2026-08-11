import assert from "node:assert/strict";
import test from "node:test";
import {
  createObject,
  createShareLink,
  createWorkspace,
  disableShareLink,
  resolveAccess,
  surfaceForAccess,
} from "./index.ts";

test("explicit grants take precedence over bearer links", () => {
  const workspace = createWorkspace("ws", "Workspace");
  const object = createObject(workspace, {
    kind: "app",
    name: "Tracker",
    ownerId: "owner",
    appId: "tracker",
  });
  createShareLink("https://fabric.test", workspace, object, "editor");

  assert.equal(resolveAccess(object, { principalId: "owner", token: object.shareToken }), "owner");
  assert.equal(resolveAccess(object, { token: object.shareToken }), "editor");
  assert.equal(surfaceForAccess("editor"), "studio");
  assert.equal(surfaceForAccess("editor", { embed: true }), "run");
});

test("rotating a share token invalidates the previous link", () => {
  const workspace = createWorkspace("ws", "Workspace");
  const object = createObject(workspace, {
    kind: "app",
    name: "Tracker",
    ownerId: "owner",
    appId: "tracker",
  });
  createShareLink("https://fabric.test", workspace, object, "viewer");
  const previous = object.shareToken;

  disableShareLink(object, true);
  createShareLink("https://fabric.test", workspace, object, "viewer");

  assert.notEqual(object.shareToken, previous);
  assert.equal(resolveAccess(object, { token: previous }), undefined);
  assert.equal(resolveAccess(object, { token: object.shareToken }), "viewer");
});

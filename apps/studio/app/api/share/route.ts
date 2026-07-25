import {
  createShareLink,
  disableShareLink,
  setPublic,
  share,
  appUrl,
  embedSnippet,
  type ShareRole,
  type WorkspaceObject,
} from "@fabric/workspace";
import { getWorkspace, objectBySlug } from "../../../lib/workspace";

/**
 * The sharing endpoint — the server side of the Share dialog.
 *
 * It mutates the workspace object's sharing state (the Google-Docs model:
 * Restricted / Anyone-with-link[viewer|editor] / Published) and returns the
 * canonical link + embed snippet to display. All state changes go through the
 * same `@fabric/workspace` functions the preview server and demos use, so there
 * is exactly one implementation of "sharing."
 */

/** The four dialog modes, flattened for the wire. */
export type ShareMode = "restricted" | "link-viewer" | "link-editor" | "published";

interface ShareResponse {
  mode: ShareMode;
  link: string;
  embed: string;
}

function currentMode(obj: WorkspaceObject): ShareMode {
  if (obj.public) return "published";
  if (obj.linkRole === "editor") return "link-editor";
  if (obj.linkRole === "viewer") return "link-viewer";
  return "restricted";
}

function describe(base: string, slug: string, obj: WorkspaceObject): ShareResponse {
  const ws = getWorkspace();
  // The link carries the token only while "anyone with the link" is on.
  const token = obj.linkRole ? obj.shareToken : undefined;
  return {
    mode: currentMode(obj),
    link: appUrl(base, ws, obj, token),
    embed: embedSnippet(base, ws, obj, token),
  };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const base = url.origin;
  const body = (await req.json()) as {
    slug: string;
    mode?: ShareMode;
    invite?: { principalId: string; role: ShareRole };
  };

  const obj = objectBySlug(body.slug);
  if (!obj) return Response.json({ ok: false, error: `no object for slug ${body.slug}` }, { status: 404 });
  const ws = getWorkspace();

  // Invite a specific person (like typing an email in Google Docs).
  if (body.invite) {
    share(obj, body.invite.principalId, body.invite.role);
    return Response.json({ ok: true, ...describe(base, body.slug, obj) });
  }

  // Switch the link-sharing mode.
  switch (body.mode) {
    case "restricted":
      disableShareLink(obj);
      setPublic(obj, false);
      break;
    case "link-viewer":
      setPublic(obj, false);
      createShareLink(base, ws, obj, "viewer");
      break;
    case "link-editor":
      setPublic(obj, false);
      createShareLink(base, ws, obj, "editor");
      break;
    case "published":
      disableShareLink(obj);
      setPublic(obj, true);
      break;
    // no mode → just report current state (used when the dialog opens).
  }

  return Response.json({ ok: true, ...describe(base, body.slug, obj) });
}

import { getRuntime, ensureRuntime, WORKSPACE_ID } from "../../../lib/runtime";
import { resolveWorkspaceVisit, visitorFromUrl } from "../../../lib/workspace";
import { currentIdentity } from "../../../lib/auth";

/**
 * The submit endpoint — how data gets *into* an app from its own UI.
 *
 * The client posts { slug, view, action, form }: raw field values and the name
 * of the action being submitted. It does NOT post action arguments. The runtime
 * looks the handler up in the installed document, keeps only the keys that
 * document declares as Fields, and evaluates the handler's `args` Exprs itself
 * under { form, user, app, now }. So `submittedBy: {$:"user.id"}` and a
 * hard-coded `status: "pending"` cannot be overridden by a crafted request.
 *
 * Two planes of authorization, in order:
 *   1. Object access — may this visitor open the app at all? (workspace)
 *   2. Action permission — may this principal run this action? (runtime)
 * We never conflate them: a link viewer may legitimately be allowed to submit
 * to a form if the app's own permission spec says guests can.
 */
export async function POST(req: Request) {
  const identity = await currentIdentity();
  const workspaceId =
    identity?.workspaceId ?? new URL(req.url).searchParams.get("w") ?? WORKSPACE_ID;
  await ensureRuntime(workspaceId, identity?.id);

  const body = (await req.json()) as {
    slug: string;
    view: string;
    action: string;
    form: Record<string, unknown>;
  };

  const visit = await resolveWorkspaceVisit(
    workspaceId,
    identity?.id ?? "u_owner",
    body.slug,
    visitorFromUrl(req.url, identity?.id, workspaceId),
  );
  if (visit.surface === "denied") {
    return Response.json({ ok: false, error: "no access to this app" }, { status: 403 });
  }
  const appId = visit.object?.appId ?? body.slug;

  const started = performance.now();
  try {
    const { result, view } = await getRuntime(workspaceId).submit(
      appId,
      body.view,
      body.action,
      body.form ?? {},
      visit.principal,
    );
    return Response.json({ ok: true, result, view, ms: round(performance.now() - started) });
  } catch (e) {
    const message = (e as Error).message;
    // A permission failure is a 403, not a 400: the client asked a legitimate
    // question and the answer is "you may not".
    const denied = /permission|cannot run/i.test(message);
    return Response.json({ ok: false, error: message }, { status: denied ? 403 : 400 });
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

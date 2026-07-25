import { Orchestrator } from "@fabric/orchestrator";
import { ensureRuntime, getRuntime, primaryView, WORKSPACE_ID } from "../../../lib/runtime";
import { resolveVisit, visitorFromUrl } from "../../../lib/workspace";
import { choosePlanner, EXAMPLE_PROMPTS } from "../../../lib/planner";
import { summarizePatches, type DiffChip } from "../../../lib/patch-summary";

/**
 * The editing endpoint — one prompt, one version, one re-render.
 *
 * Two shapes of request share it because they are two sides of the same loop:
 *   { prompt } → an EDIT: plan patches → validate → install a new version →
 *                return the re-rendered view and the patches as a semantic diff.
 *   { action } → a USE: invoke an app action (a button firing).
 *
 * The response carries `ms`: the measured server-side cost of the whole edit,
 * shown next to the message in the chat. It is the demo's most quietly
 * persuasive number, because the equivalent line in a codegen product is a
 * build log.
 *
 * Runs on the Node.js runtime because it hosts the runtime and calls capabilities.
 */
export interface EditResponse {
  ok: boolean;
  error?: string;
  /** patches rendered as readable sentences, not source diff. */
  chips?: DiffChip[];
  view?: unknown;
  versionId?: string;
  ms?: number;
  /** which planner answered, so the UI can be honest about it. */
  planner?: string;
  /** offered when nothing matched, so a dead end is still a next step. */
  suggestions?: string[];
}

export async function POST(req: Request) {
  await ensureRuntime();

  const body = (await req.json()) as {
    slug: string;
    prompt?: string;
    action?: string;
    args?: Record<string, unknown>;
  };

  const visit = resolveVisit(body.slug, visitorFromUrl(req.url));
  if (visit.surface === "denied") {
    return Response.json({ ok: false, error: "no access to this app" }, { status: 403 });
  }

  const rt = getRuntime();

  // A button firing. Allowed on the read-only surface too: whether a guest may
  // run it is the app's own permission decision, made inside invokeAction.
  if (body.action) {
    try {
      const result = await rt.invokeAction(body.slug, body.action, body.args ?? {}, visit.principal);
      const viewName = primaryView(rt.installed(body.slug)!);
      const view = viewName ? await rt.renderView(body.slug, viewName, visit.principal) : undefined;
      return Response.json({ ok: true, result, view });
    } catch (e) {
      const message = (e as Error).message;
      return Response.json({ ok: false, error: message }, { status: /permission|cannot run/i.test(message) ? 403 : 400 });
    }
  }

  // Editing the document requires edit authority on the object.
  if (visit.surface !== "studio") {
    return Response.json({ ok: false, error: "view-only access cannot edit this app" }, { status: 403 });
  }

  const doc = rt.installed(body.slug);
  if (!doc) return Response.json({ ok: false, error: `app ${body.slug} is not installed` }, { status: 404 });

  const { planner, label } = choosePlanner();
  const started = performance.now();

  try {
    const orchestrator = new Orchestrator(planner);
    const edit = await orchestrator.edit(body.prompt ?? "", doc, rt.registry.manifests());

    if (edit.patches.length === 0) {
      // No patches is a different outcome from a rejected edit, and it has two
      // causes we cannot tell apart from here: the request wasn't understood, or
      // the document already satisfies it. Say both rather than assert the wrong one.
      return Response.json({
        ok: false,
        error: "No change was made — either that isn't something I can express yet, or the document already says it.",
        planner: label,
        suggestions: [...EXAMPLE_PROMPTS],
      } satisfies EditResponse);
    }

    if (!edit.ok || !edit.next) {
      // The validator refused. This is the gate working: a bad edit never
      // reaches a running app, and the reason is specific.
      return Response.json(
        {
          ok: false,
          error: edit.diagnostics
            .filter((d) => d.level === "error")
            .map((d) => `${d.path ? `${d.path}: ` : ""}${d.message}`)
            .join("; "),
          chips: summarizePatches(edit.patches),
          planner: label,
        } satisfies EditResponse,
        { status: 400 },
      );
    }

    const installed = rt.install(edit.next, {
      workspaceId: WORKSPACE_ID,
      author: visit.principal.id,
      message: body.prompt ?? "edit",
    });
    const viewName = primaryView(edit.next)!;
    const view = await rt.renderView(body.slug, viewName, visit.principal);

    return Response.json({
      ok: true,
      chips: summarizePatches(edit.patches),
      view,
      versionId: installed.version,
      ms: Math.round((performance.now() - started) * 1000) / 1000,
      planner: label,
    } satisfies EditResponse);
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message, planner: label }, { status: 400 });
  }
}

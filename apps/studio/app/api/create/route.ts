import { Orchestrator } from "@fabric/orchestrator";
import {
  ensureRuntime,
  getRuntime,
  persistVersion,
  STUDIO_INSTANCE_ID,
} from "../../../lib/runtime";
import { createWorkspaceObject } from "../../../lib/workspace";
import { currentIdentity, unauthorized } from "../../../lib/auth";
import { choosePlanner } from "../../../lib/planner";
import { summarizePatches, type DiffChip } from "../../../lib/patch-summary";
import { SEED_DOCS } from "../../../lib/seed-apps";

/**
 * Create an app from a sentence.
 *
 * HONESTY about what this does: a from-scratch document needs a model, and the
 * scripted planner cannot invent one. So creation starts from the closest
 * *template* — a fork of an existing document, which costs microseconds because
 * a fork is a copy of JSON — and then applies the description as a normal
 * conversational edit. The response says which template was used and the UI
 * shows it, so nobody is led to believe a model wrote the document when none
 * was configured. With a model configured the same endpoint still forks a
 * template first, because starting from a valid document is simply a better
 * prior than starting from an empty one.
 *
 * What is NOT a simplification: the URL is live the instant this returns. There
 * is no build, no deploy and no provisioning between "create" and "open".
 */

const TEMPLATES: { match: RegExp; appId: string; icon: string }[] = [
  { match: /(expense|spend|reimburse|receipt|cost)/i, appId: "expense-tracker", icon: "🧾" },
  { match: /(leave|time off|holiday|vacation|absence|pto)/i, appId: "leave-requests", icon: "🏖" },
  { match: /(revenue|dashboard|sales|metric|chart|kpi|forecast)/i, appId: "revenue-dashboard", icon: "📊" },
  { match: /(ledger|accounting|book|invoice|finance)/i, appId: "accounting", icon: "📒" },
];

export async function POST(req: Request) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  await ensureRuntime(identity.workspaceId, identity.id);

  const body = (await req.json()) as { prompt?: string; template?: string; name?: string };
  const prompt = (body.prompt ?? "").trim();

  const template =
    TEMPLATES.find((t) => t.appId === body.template) ??
    TEMPLATES.find((t) => t.match.test(prompt)) ??
    TEMPLATES[0]!;

  const rt = getRuntime(identity.workspaceId);
  const started = performance.now();

  // The template's own head version is the fork point.
  const head = rt.versions.head(template.appId);
  const base = head?.doc ?? SEED_DOCS.find((d) => d.id === template.appId);
  if (!base) return Response.json({ ok: false, error: "template unavailable" }, { status: 500 });

  const name = body.name ?? titleFrom(prompt) ?? `New ${base.name}`;
  const appId = uniqueId(slugify(name), (id) => rt.installed(id) !== undefined);

  let doc = { ...structuredClone(base), id: appId, name };
  let chips: DiffChip[] = [];
  let plannerLabel: string | undefined;
  let editNote: string | undefined;

  if (prompt) {
    const { planner, label } = choosePlanner();
    plannerLabel = label;
    const edit = await new Orchestrator(planner).edit(prompt, doc, rt.registry.manifests());
    if (edit.ok && edit.next) {
      doc = edit.next;
      chips = summarizePatches(edit.patches);
    } else if (edit.patches.length === 0) {
      editNote = "Started from the template — the description didn't map to a change yet.";
    } else {
      editNote = "Started from the template — the described change didn't validate, so it wasn't applied.";
    }
  }

  try {
    rt.install(doc, {
      workspaceId: identity.workspaceId,
      instanceId: STUDIO_INSTANCE_ID,
      author: identity.id,
      message: prompt || `created ${name}`,
    });
    await persistVersion(identity.workspaceId, {
      appId,
      doc,
      author: identity.id,
      message: prompt || `created ${name}`,
    });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }

  const obj = await createWorkspaceObject(
    identity.workspaceId,
    identity.id,
    appId,
    name,
    template.icon,
  );

  return Response.json({
    ok: true,
    slug: obj.slug,
    name,
    template: base.name,
    chips,
    ...(plannerLabel ? { planner: plannerLabel } : {}),
    ...(editNote ? { note: editNote } : {}),
    ms: Math.round((performance.now() - started) * 1000) / 1000,
  });
}

/** "Track team expenses with approvals" → "Track Team Expenses". */
function titleFrom(prompt: string): string | undefined {
  const words = prompt.replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return undefined;
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
}

function uniqueId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

import type { AppDocument, Patch } from "@fabric/ir";
import { applyPatches } from "@fabric/ir";
import type { CapabilityManifest } from "@fabric/capabilities";
import { validateApp, type CapabilityManifestLite, type Diagnostic } from "@fabric/validator";

/**
 * AI Orchestration.
 *
 * The AI never writes code and never returns a whole application. It returns a
 * list of IR patches for a single turn. The orchestrator is the deterministic
 * spine around that fallible model:
 *
 *   prompt + current IR + capability manifests
 *        │            (planner: LLM or mock)
 *        ▼
 *   Patch[]  ──►  apply  ──►  validate  ──►  accept (new version) or reject
 *
 * WHY this shape:
 *  - Patches are the diff shown in version history — the AI's edit IS the
 *    changelog entry, for free.
 *  - Validation is a hard gate: a hallucinated capability or dangling
 *    reference is rejected before it can reach a user's running app.
 *  - The planner is an injected dependency, so the same pipeline runs with a
 *    real model (Vercel AI SDK + AI Gateway) in production and a deterministic
 *    mock in tests/offline — no code path diverges.
 */

export interface Planner {
  /**
   * Produce IR patches for one edit turn. A real implementation calls an LLM
   * with tools: listCapabilities(), getIR(), proposePatches(), validate().
   */
  plan(input: PlanInput): Promise<Patch[]>;
}

export interface PlanInput {
  prompt: string;
  doc: AppDocument;
  capabilities: CapabilityManifest[];
}

export interface EditResult {
  ok: boolean;
  patches: Patch[];
  next?: AppDocument;
  diagnostics: Diagnostic[];
}

export class Orchestrator {
  private planner: Planner;
  constructor(planner: Planner) {
    this.planner = planner;
  }

  async edit(prompt: string, doc: AppDocument, capabilities: CapabilityManifest[]): Promise<EditResult> {
    const patches = await this.planner.plan({ prompt, doc, capabilities });
    let next: AppDocument;
    try {
      next = applyPatches(doc, patches);
    } catch (e) {
      return { ok: false, patches, diagnostics: [{ level: "error", code: "patch.apply", message: (e as Error).message, path: "" }] };
    }
    const lite: CapabilityManifestLite[] = capabilities.map((c) => ({
      name: c.name,
      methods: c.methods.map((m) => ({ name: m.name, ...(m.permission ? { permission: m.permission } : {}) })),
    }));
    const result = validateApp(next, { capabilities: lite });
    return result.ok
      ? { ok: true, patches, next, diagnostics: result.diagnostics }
      : { ok: false, patches, diagnostics: result.diagnostics };
  }
}

/**
 * A tiny deterministic planner. It recognizes a few phrasings so the platform
 * is demonstrable with no network or model. It is intentionally dumb — its
 * only job is to prove the pipeline. Swap in `AiSdkPlanner` for real use.
 */
export class MockPlanner implements Planner {
  async plan({ prompt, doc }: PlanInput): Promise<Patch[]> {
    const p = prompt.toLowerCase();

    const addField = /add (?:an? )?(\w+) field(?: called (\w+))? to (\w+)/.exec(p);
    if (addField) {
      const [, t, name, model] = addField;
      const modelExists = doc.models.some((m) => m.name.toLowerCase() === model);
      if (modelExists) {
        const realModel = doc.models.find((m) => m.name.toLowerCase() === model)!.name;
        const type = ["text", "number", "boolean", "datetime"].includes(t!) ? t! : "string";
        return [{ op: "insert", path: `models.name(${realModel}).fields`, value: { name: name ?? t, type } }];
      }
    }

    const addRole = /add (?:an? )?(\w+) role/.exec(p);
    if (addRole) {
      const role = addRole[1]!;
      if (!doc.permissions.roles.includes(role)) {
        return [{ op: "insert", path: "permissions.roles", value: role }];
      }
    }

    const makePublic = /make (?:it |this )?public/.test(p);
    if (makePublic) return [{ op: "set", path: "permissions.default", value: "allow" }];

    return [];
  }
}

/**
 * ScriptedPlanner is the richer offline planner: it understands multi-part
 * edits (a new field touches the model, the action, the write step, the form and
 * the table) so the pipeline can be demonstrated and tested without a model.
 */
export * from "./scripted.ts";

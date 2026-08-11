import { ScriptedPlanner, type Planner } from "@fabric/orchestrator";

export { EXAMPLE_PROMPTS } from "@fabric/orchestrator";

/**
 * Which planner is answering, and an honest label for the UI.
 *
 * WHY a scripted planner exists at all: the demo must work on a laptop with no
 * gateway credentials and no network, and "the AI errored" is not a thing a
 * founder should discover on stage. So the pipeline — plan → apply → validate →
 * version → re-render — is exercised by a deterministic planner that maps a set
 * of recognised sentences onto real IR patches.
 *
 * It is NOT an AI and the studio says so in the chat header. That honesty is
 * cheap because the interesting claim was never "our model is better" — it is
 * that an edit is a validated patch to a document instead of regenerated code,
 * and a scripted planner demonstrates exactly that property.
 */
export type PlannerKind = "model" | "scripted";

export interface PlannerChoice {
  planner: Planner;
  kind: PlannerKind;
  label: string;
}

/**
 * Use a real model when the environment can reach one, otherwise the scripted
 * planner. When a model IS configured we still fall back per-request if the
 * call fails, because a demo that dies on a flaky network is worse than a demo
 * that quietly degrades and tells you it did.
 */
export function choosePlanner(): PlannerChoice {
  const hasModel = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  if (!hasModel) {
    return { planner: new ScriptedPlanner(), kind: "scripted", label: "scripted planner · no model configured" };
  }
  const model = process.env.FABRIC_MODEL ?? "anthropic/claude-sonnet-5";
  const fallback = new ScriptedPlanner();
  return {
    planner: {
      async plan(input) {
        try {
          // Imported lazily so the AI SDK stays out of the module graph (and out
          // of a plain `node` run of this file) unless a model is configured.
          const { createAiPlanner } = await import("./ai-planner");
          const patches = await createAiPlanner(model).plan(input);
          if (patches.length > 0) return patches;
        } catch (error) {
          console.warn("[fabric-ai] model planner failed; using scripted fallback", {
            model,
            error: error instanceof Error ? error.message : String(error),
          });
          // fall through to the scripted planner
        }
        return fallback.plan(input);
      },
    },
    kind: "model",
    label: `${model} · via AI Gateway`,
  };
}

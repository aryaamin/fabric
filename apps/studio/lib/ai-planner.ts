import type { Planner, PlanInput } from "@fabric/orchestrator";
import type { Patch } from "@fabric/ir";

/**
 * The production Planner: turns a user's message into IR patches using the
 * Vercel AI SDK routed through the AI Gateway.
 *
 * WHY the model returns patches, not code and not a whole document:
 *  - patches are small, so edits are cheap and fast;
 *  - patches ARE the version-history entry;
 *  - the orchestrator validates the patched document before it is accepted, so
 *    a hallucinated capability or dangling reference can never reach a user.
 *
 * The model is given three things and nothing else: the current IR, the
 * capability manifests (its entire menu of possible powers), and the IR
 * grammar. It cannot invent infrastructure because infrastructure is not in
 * its vocabulary — only capabilities are.
 *
 * NOTE: This module imports the AI SDK; it only runs inside the Next.js app
 * where those deps are installed (see apps/studio/package.json). The core
 * packages remain dependency-free.
 */
export function createAiPlanner(model = "anthropic/claude-sonnet-4.6"): Planner {
  return {
    async plan(input: PlanInput): Promise<Patch[]> {
      // Lazy import keeps the AI SDK out of any non-studio consumer.
      const { generateText, Output } = await import("ai");
      const { z } = await import("zod");

      const patchSchema = z.object({
        patches: z
          .array(
            z.object({
              op: z.enum(["set", "remove", "insert"]),
              path: z.string().describe("dotted IR path, e.g. models.name(Expense).fields"),
              index: z.number().optional(),
              value: z.unknown().optional(),
            }),
          )
          .describe("Minimal set of IR edits that satisfy the user's request."),
      });

      const { experimental_output } = await generateText({
        model,
        experimental_output: Output.object({ schema: patchSchema }),
        system: SYSTEM_PROMPT,
        prompt: [
          `# Capabilities available (the ONLY powers apps may use)`,
          JSON.stringify(input.capabilities, null, 2),
          `# Current application IR`,
          JSON.stringify(input.doc, null, 2),
          `# User request`,
          input.prompt,
        ].join("\n\n"),
      });

      return (experimental_output?.patches ?? []) as Patch[];
    },
  };
}

const SYSTEM_PROMPT = `You edit applications expressed as Fabric IR (a JSON document).
Rules:
- Return the MINIMAL list of patches to satisfy the request. Do not rewrite the document.
- Apps may only use the listed capabilities. Never reference a capability that is not installed.
- Logic is expressed as declarative steps and the Fabric expression AST ({$:"path"}, {$op},{$fn}); never emit code.
- Every action referenced by a view/subscription must exist. Every model referenced by a field/binding must exist.
- Prefer adding to arrays (insert) over replacing them (set).`;

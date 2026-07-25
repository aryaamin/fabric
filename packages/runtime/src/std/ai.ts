import type {
  Capability,
  CapabilityContext,
  CapabilityFactory,
  CapabilityManifest,
} from "@fabric/capabilities";
import { BaseCapability } from "@fabric/capabilities";

const manifest: CapabilityManifest = {
  name: "ai",
  version: "0.1.0",
  description: "Language + reasoning as a capability. Apps ask for text/answers, not for a model or API key.",
  methods: [
    {
      name: "complete",
      permission: "ai.use",
      input: { prompt: { type: "string", required: true }, context: { type: "json" } },
      output: { type: "string" },
    },
    {
      name: "classify",
      permission: "ai.use",
      input: { text: { type: "string", required: true }, labels: { type: "array", required: true } },
      output: { type: "string" },
    },
  ],
};

/**
 * The AI capability abstracts the model provider entirely. In production its
 * `create` selects a provider through the Vercel AI Gateway (model strings
 * like "anthropic/claude-sonnet-4.6") using runtime-held credentials. The
 * reference implementation is deterministic so the demo runs fully offline.
 */
class AiCapability extends BaseCapability {
  readonly manifest = manifest;
  private complete: (prompt: string) => Promise<string>;
  constructor(complete: (prompt: string) => Promise<string>) {
    super();
    this.complete = complete;
  }
  protected handlers = {
    complete: async (a: { prompt: string }, ctx: CapabilityContext) => {
      ctx.logger.debug("ai.complete", a.prompt);
      return this.complete(a.prompt);
    },
    classify: async (a: { text: string; labels: string[] }) => classify(a.text, a.labels ?? []),
  };
}

/**
 * The offline reference classifier: exact label mention first, then a tiny
 * keyword lexicon, then the first label. In production `classify` is a model
 * call; this stub exists so every demo runs deterministically with no network,
 * and it is intentionally the *only* place in the platform that guesses.
 */
const LEXICON: Record<string, string[]> = {
  positive: ["love", "great", "awesome", "excellent", "thanks", "nice", "good", "perfect"],
  negative: ["broken", "bad", "hate", "terrible", "slow", "crash", "fail", "error", "wrong", "annoying"],
  neutral: ["okay", "fine", "question", "wondering"],
  bug: ["broken", "crash", "error", "fail", "bug", "wrong", "doesn't", "not working"],
  feature: ["add", "would like", "wish", "could you", "support for", "please add", "request"],
  praise: ["love", "great", "awesome", "thanks", "excellent", "amazing"],
  question: ["how", "what", "why", "when", "where", "?"],
  urgent: ["asap", "urgent", "immediately", "blocking", "down"],
};

function classify(text: string, labels: string[]): string {
  const t = String(text ?? "").toLowerCase();
  const mentioned = labels.find((l) => t.includes(l.toLowerCase()));
  if (mentioned) return mentioned;
  let best = labels[0] ?? "unknown";
  let bestScore = 0;
  for (const label of labels) {
    const words = LEXICON[label.toLowerCase()] ?? [];
    const score = words.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

export function aiCapabilityFactory(
  complete: (prompt: string) => Promise<string> = async (p) => `(«ai» stub) ${p.slice(0, 80)}`,
): CapabilityFactory {
  return { manifest, create: () => new AiCapability(complete) as Capability };
}

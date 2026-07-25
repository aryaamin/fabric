import type { Patch } from "@fabric/ir";
import type { Change } from "@fabric/versioning";

/**
 * Patches → human sentences.
 *
 * This is the differentiator made visible. A codegen platform's answer to
 * "what did the AI just change?" is a diff of regenerated source. Ours is a
 * handful of IR patches, and an IR patch is close enough to intent that it can
 * be read back as a sentence: `+ field category on Expense`, not 400 changed
 * lines across six files. The mapping below is deliberately explicit rather
 * than clever — a wrong guess would be worse than a generic fallback.
 */

export type ChipKind = "added" | "changed" | "removed";

export interface DiffChip {
  kind: ChipKind;
  /** the sentence, with `code spans` marked by backticks. */
  text: string;
  /** the raw IR path, shown in mono on hover/expand. */
  path: string;
}

const SIGIL: Record<ChipKind, string> = { added: "+", changed: "~", removed: "−" };

export function chipSigil(kind: ChipKind): string {
  return SIGIL[kind];
}

interface Seg {
  key: string;
  selector?: string;
}

function segments(path: string): Seg[] {
  if (!path) return [];
  return path.split(".").map((raw) => {
    const m = /^([A-Za-z0-9_]+)\(([^)]*)\)$/.exec(raw);
    return m ? { key: m[1]!, selector: m[2]! } : { key: raw };
  });
}

function named(value: unknown): string | undefined {
  if (value && typeof value === "object" && "name" in (value as Record<string, unknown>)) {
    const n = (value as Record<string, unknown>).name;
    if (typeof n === "string") return n;
  }
  return undefined;
}

function short(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : named(v) ?? "…")).join(", ");
  const n = named(value);
  if (n) return n;
  const json = JSON.stringify(value) ?? "";
  return json.length > 44 ? `${json.slice(0, 41)}…` : json;
}

export function summarizePatch(patch: Patch): DiffChip {
  const segs = segments(patch.path);
  const top = segs[0]?.key ?? "";
  const kind: ChipKind = patch.op === "insert" ? "added" : patch.op === "remove" ? "removed" : "changed";
  const value = "value" in patch ? patch.value : undefined;
  const chip = (text: string): DiffChip => ({ kind, text, path: patch.path });

  // models.name(Expense).fields → a field on a model
  if (top === "models") {
    const model = segs[1]?.selector ?? segs[1]?.key;
    if (segs[2]?.key === "fields") {
      const field = named(value) ?? segs[3]?.selector ?? "field";
      const type = value && typeof value === "object" ? (value as Record<string, unknown>).type : undefined;
      const suffix = typeof type === "string" ? ` (\`${type}\`)` : "";
      if (kind === "added") return chip(`added field \`${field}\`${suffix} to \`${model}\``);
      if (kind === "removed") return chip(`removed field \`${field}\` from \`${model}\``);
      return chip(`changed field \`${field}\` on \`${model}\``);
    }
    if (model && kind === "added") return chip(`added data model \`${named(value) ?? model}\``);
    return chip(`${kind} in data model \`${model ?? short(value)}\``);
  }

  if (top === "permissions") {
    if (segs[1]?.key === "roles") {
      if (kind === "added") return chip(`added role \`${short(value)}\``);
      if (kind === "removed") return chip(`removed a role`);
      return chip(`changed roles → \`${short(value)}\``);
    }
    if (segs[1]?.key === "actions") {
      const action = segs[2]?.selector ?? segs[2]?.key ?? "an action";
      const roles = short(value);
      return chip(roles ? `only \`${roles}\` may run \`${action}\`` : `nobody may run \`${action}\``);
    }
    if (segs[1]?.key === "models") {
      const model = segs[2]?.selector ?? segs[2]?.key ?? "a model";
      const op = segs[3]?.key ?? "access";
      const who = short(value);
      return chip(who ? `\`${model}\` ${op}: \`${who}\`` : `changed \`${model}\` ${op} policy`);
    }
    if (segs[1]?.key === "default") return chip(`changed default policy to \`${short(value)}\``);
    return chip(`changed permissions`);
  }

  if (top === "actions") {
    // The action being edited is addressed by the selector; `named(value)` is the
    // name of whatever is being inserted INTO it (a param, a step), so the two
    // must never be conflated — that is how you get "added changed logic of X".
    const action = segs[1]?.selector ?? "an action";

    // actions.name(submitExpense).params → the action's input surface
    if (segs[2]?.key === "params") {
      const param = named(value) ?? segs[3]?.selector ?? "a parameter";
      if (kind === "added") return chip(`\`${action}\` now accepts \`${param}\``);
      if (kind === "removed") return chip(`\`${action}\` no longer accepts \`${param}\``);
      return chip(`changed the \`${param}\` parameter of \`${action}\``);
    }

    // actions.name(submitExpense).steps.0.args.data.vendor → what gets persisted
    if (segs[2]?.key === "steps") {
      const dataAt = segs.findIndex((s) => s.key === "data");
      const field = dataAt >= 0 ? segs[dataAt + 1]?.key : undefined;
      if (field) {
        if (kind === "removed") return chip(`\`${action}\` no longer saves \`${field}\``);
        return chip(`\`${action}\` now saves \`${field}\``);
      }
      if (kind === "added") return chip(`added a step to \`${action}\``);
      if (kind === "removed") return chip(`removed a step from \`${action}\``);
      return chip(`changed a step in \`${action}\``);
    }

    if (segs.length === 1) {
      const created = named(value) ?? action;
      if (kind === "added") return chip(`added action \`${created}\``);
      if (kind === "removed") return chip(`removed action \`${created}\``);
    }
    if (segs[2]?.key === "permission") return chip(`changed who may run \`${action}\``);
    if (kind === "removed") return chip(`removed action \`${action}\``);
    return chip(`changed logic of \`${action}\``);
  }

  if (top === "capabilities") {
    const cap =
      value && typeof value === "object"
        ? String((value as Record<string, unknown>).capability ?? short(value))
        : short(value);
    if (kind === "added") return chip(`granted the \`${cap}\` capability`);
    if (kind === "removed") return chip(`revoked a capability`);
    return chip(`reconfigured \`${cap}\``);
  }

  if (top === "subscriptions") {
    const on = value && typeof value === "object" ? String((value as Record<string, unknown>).on ?? "") : "";
    if (kind === "added") return chip(`connected to \`${on || "an event"}\``);
    if (kind === "removed") return chip(`disconnected an event`);
    return chip(`changed a connection`);
  }

  if (top === "events") {
    const ev = named(value) ?? segs[1]?.selector ?? "an event";
    return kind === "added" ? chip(`declared event \`${ev}\``) : chip(`${kind} event \`${ev}\``);
  }

  if (top === "views") {
    const last = segs[segs.length - 1]?.key;
    const prev = segs[segs.length - 2]?.key;
    const nodeType =
      value && typeof value === "object" && "type" in (value as Record<string, unknown>)
        ? String((value as Record<string, unknown>).type)
        : undefined;
    const nodeName =
      value && typeof value === "object"
        ? String(((value as { props?: Record<string, unknown> }).props?.name ?? "") || "")
        : "";

    // A UI node was inserted: say WHAT, not the JSON.
    if (last === "children") {
      if (kind === "removed") return chip(`removed a component from the view`);
      if (nodeType === "Field") return chip(`added a \`${nodeName || "new"}\` input to the form`);
      if (nodeType) return chip(`added a \`${nodeType}\` to the view`);
      return chip(`added a component to the view`);
    }

    // A form handler learned to pass a new value to its action.
    const argsAt = segs.findIndex((s) => s.key === "args");
    if (argsAt > 0 && segs[argsAt - 2]?.key === "on") {
      const event = segs[argsAt - 1]?.key ?? "submit";
      const field = segs[argsAt + 1]?.key;
      return chip(field ? `\`${field}\` is now sent on ${event}` : `changed what the form sends on ${event}`);
    }

    if (prev === "props") {
      if (last === "columns") return chip(`added a \`${short(value)}\` column to the table`);
      if (last === "badgeColumn") return chip(`\`${short(value)}\` now renders as a status badge`);
      if (last === "title") return chip(`retitled the page to \`${short(value)}\``);
      if (last === "required") return chip(value === false ? `made an input optional` : `made an input required`);
      if (last === "submitLabel") return chip(`changed the submit button to \`${short(value)}\``);
      if (last === "options") return chip(`changed the choices to \`${short(value)}\``);
      return chip(`changed \`${last}\` on a component`);
    }
    if (last === "columns" && kind === "added") return chip(`added a \`${short(value)}\` column to the table`);

    if (kind === "added") return chip(`added \`${nodeType ?? "a component"}\` to the view`);
    if (kind === "removed") return chip(`removed a component from the view`);
    return chip(`changed the view`);
  }

  if (top === "name" || top === "description" || top === "icon") {
    return chip(`renamed ${top} → \`${short(value)}\``);
  }

  return chip(`${kind} \`${patch.path}\``);
}

export function summarizePatches(patches: Patch[]): DiffChip[] {
  return patches.map(summarizePatch);
}

/**
 * A version's one-line diff summary, from the structural diff of two documents.
 * Grouped by top-level IR section, because "4 changes in permissions" is what a
 * person wants from a history row; the chips above are for the detail view.
 */
export function summarizeChanges(changes: Change[]): string {
  if (changes.length === 0) return "no structural change";
  const counts = new Map<string, number>();
  for (const c of changes) {
    const top = c.path.split(".")[0] ?? "app";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([section, n]) => `${n} in ${section}`);
  const rest = counts.size > 3 ? ` +${counts.size - 3} more` : "";
  return parts.join(" · ") + rest;
}

/** Render a chip's backtick spans as plain text (for titles/aria labels). */
export function plainText(text: string): string {
  return text.replace(/`/g, "");
}

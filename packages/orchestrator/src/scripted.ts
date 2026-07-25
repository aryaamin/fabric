import type { AppDocument, FieldType, Node, Patch, View } from "@fabric/ir";
import type { Planner, PlanInput } from "./index.ts";

/**
 * ScriptedPlanner — a deterministic Planner that maps recognised sentences onto
 * real IR patches.
 *
 * WHY this belongs in the platform and not in a demo script: the Planner port
 * is the seam where a fallible model meets a validated pipeline, and it must be
 * possible to exercise that pipeline with no network, no credentials and no
 * nondeterminism — in tests, in CI, and on a laptop on a stage. It is not an
 * AI and callers are expected to say so in their UI.
 *
 * It supersedes MockPlanner (kept for backwards compatibility) by understanding
 * multi-part edits: "add a vendor field" is not one patch but six coordinated
 * ones, because a field that is stored but never collected, or collected but
 * never stored, is a half-edit.
 */

/* ------------------------------------------------------------------ */
/* The scripted planner                                                */
/* ------------------------------------------------------------------ */

/** Sentences the scripted planner understands, shown in the UI as chips. */
export const EXAMPLE_PROMPTS = [
  "Add a vendor field",
  "Add a notes field",
  "Only managers can approve",
  "Finance can only view",
  "Show status as a badge",
  "Rename the title to Team Expenses",
  "Make amount required",
] as const;

export class ScriptedPlanner implements Planner {
  async plan({ prompt, doc }: PlanInput): Promise<Patch[]> {
    const text = prompt.trim();
    for (const rule of RULES) {
      const m = rule.match.exec(text);
      if (m) {
        const patches = rule.plan(m, doc);
        if (patches.length > 0) return patches;
      }
    }
    return [];
  }
}

interface Rule {
  match: RegExp;
  plan: (m: RegExpExecArray, doc: AppDocument) => Patch[];
}

const RULES: Rule[] = [
  /* ---- add a field, end to end -------------------------------------- */
  {
    // "add a vendor field to Expense", "add a notes field", "add vendor to Expense"
    match: /\badd\s+(?:an?\s+)?(\w+)(?:\s+field)?(?:\s+(?:called|named)\s+(\w+))?(?:\s+to\s+(?:the\s+)?(\w+))?/i,
    plan: (m, doc) => addFieldEndToEnd(doc, (m[2] ?? m[1] ?? "").toLowerCase(), m[3]),
  },

  /* ---- who may run an action ---------------------------------------- */
  {
    // "only managers can approveExpense", "only manager may approve"
    match: /\bonly\s+(\w+?)s?\s+(?:can|may|should)\s+(\w+)/i,
    plan: (m, doc) => {
      const role = m[1]!.toLowerCase();
      const action = findAction(doc, m[2]!);
      if (!action) return [];
      const patches: Patch[] = [];
      if (!doc.permissions.roles.includes(role)) {
        patches.push({ op: "insert", path: "permissions.roles", value: role });
      }
      patches.push({ op: "set", path: `permissions.actions.${action.name}`, value: [role] });
      return patches;
    },
  },

  /* ---- a role that may only read ------------------------------------ */
  {
    // "finance can only view", "make auditors read-only"
    match: /\b(?:make\s+)?(\w+?)s?\s+(?:can\s+only\s+(?:view|read)|(?:is|are)?\s*read[- ]only)/i,
    plan: (m, doc) => {
      const role = m[1]!.toLowerCase();
      if (["it", "this", "everyone", "anyone"].includes(role)) return [];
      const patches: Patch[] = [];
      if (!doc.permissions.roles.includes(role)) {
        patches.push({ op: "insert", path: "permissions.roles", value: role });
      }
      for (const model of doc.models) {
        const policy = doc.permissions.models?.[model.name];
        const read = policy?.read;
        const allow = Array.isArray(read) ? read : read?.allow;
        const next = allow ? [...new Set([...allow, role])] : [role];
        // Preserve a row-level rule if there is one: widening who may read must
        // not silently drop the predicate that limits WHAT they read.
        const value = Array.isArray(read) || !read ? next : { ...read, allow: next };
        patches.push({ op: "set", path: `permissions.models.${model.name}.read`, value });
      }
      return patches;
    },
  },

  /* ---- render a column as a status badge ---------------------------- */
  {
    match: /\bshow\s+(\w+)\s+as\s+a?\s*(?:badge|pill|chip|status)/i,
    plan: (m, doc) => {
      const column = m[1]!;
      const table = findNode(doc, (n) => n.type === "Table" && columnsOf(n).includes(column));
      if (!table) return [];
      return [{ op: "set", path: `${table.path}.props.badgeColumn`, value: column }];
    },
  },

  /* ---- retitle the page --------------------------------------------- */
  {
    match: /\b(?:rename|retitle|call|change)\s+(?:the\s+)?(?:title|page|app|it)\s*(?:to|as)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    plan: (m, doc) => {
      const title = m[1]!.trim();
      if (!title) return [];
      const page = findNode(doc, (n) => n.type === "Page");
      const patches: Patch[] = [{ op: "set", path: "name", value: title }];
      if (page) patches.push({ op: "set", path: `${page.path}.props.title`, value: title });
      return patches;
    },
  },

  /* ---- make a field required ---------------------------------------- */
  {
    match: /\bmake\s+(\w+)\s+(required|optional)\b/i,
    plan: (m, doc) => {
      const name = m[1]!.toLowerCase();
      const required = m[2]!.toLowerCase() === "required";
      const patches: Patch[] = [];
      for (const model of doc.models) {
        if (model.fields.some((f) => f.name === name)) {
          patches.push({ op: "set", path: `models.name(${model.name}).fields.name(${name}).required`, value: required });
        }
      }
      const field = findNode(doc, (n) => n.type === "Field" && String(n.props?.name) === name);
      if (field) patches.push({ op: "set", path: `${field.path}.props.required`, value: required });
      return patches;
    },
  },

  /* ---- publish ------------------------------------------------------ */
  {
    match: /\bmake\s+(?:it|this|the app)\s+public\b/i,
    plan: () => [{ op: "set", path: "permissions.default", value: "allow" }],
  },
];

/* ------------------------------------------------------------------ */
/* "Add a field" — the edit worth showing                              */
/* ------------------------------------------------------------------ */

/**
 * One sentence, up to six coordinated patches: the model gains a field, the
 * submitting action gains a parameter, the step that writes the row learns to
 * store it, the form gains an input, the handler maps the input to the param,
 * and the table gains a column.
 *
 * This is the demo's sharpest contrast with code generation. There, the same
 * request rewrites a schema file, a migration, a form component, a server
 * action and a table component — hundreds of regenerated lines to review, then
 * a rebuild. Here it is six typed edits to one document that the validator can
 * check before anyone sees them.
 */
function addFieldEndToEnd(doc: AppDocument, rawName: string, modelHint?: string): Patch[] {
  const name = rawName.replace(/[^a-z0-9_]/gi, "");
  if (!name || RESERVED.has(name)) return [];

  const model =
    (modelHint ? doc.models.find((m) => m.name.toLowerCase() === modelHint.toLowerCase()) : undefined) ??
    doc.models[0];
  if (!model || model.fields.some((f) => f.name === name)) return [];

  const type = inferType(name);
  const patches: Patch[] = [
    { op: "insert", path: `models.name(${model.name}).fields`, value: { name, type, label: titleCase(name) } },
  ];

  // The form that writes this model, if the app has one.
  const form = findNode(doc, (n) => n.type === "Form" && Boolean(n.on?.submit));
  const action = form ? findAction(doc, String(form.node.on!.submit!.action)) : undefined;

  if (action) {
    patches.push({ op: "insert", path: `actions.name(${action.name}).params`, value: { name, type } });

    // Teach the write step to persist it. Without this the field would exist
    // and be collected and then silently dropped — the kind of half-edit that
    // makes generated apps feel haunted.
    const stepIndex = action.steps.findIndex(
      (s) =>
        s.kind === "call" &&
        String((s as { call?: string }).call ?? "").endsWith("storage.create") &&
        (s as { args?: Record<string, unknown> }).args?.model === model.name,
    );
    if (stepIndex >= 0) {
      patches.push({
        op: "set",
        path: `actions.name(${action.name}).steps.${stepIndex}.args.data.${name}`,
        value: { $: `input.${name}` },
      });
    }

    patches.push({
      op: "set",
      path: `${form!.path}.on.submit.args.${name}`,
      value: { $: `form.${name}` },
    });
    patches.push({
      op: "insert",
      path: `${form!.path}.children`,
      value: {
        type: "Field",
        props: { name, label: titleCase(name), kind: kindForType(type) },
      },
    });
  }

  const table = findNode(doc, (n) => n.type === "Table" && bindModel(n) === model.name);
  if (table) patches.push({ op: "insert", path: `${table.path}.props.columns`, value: name });

  return patches;
}

const RESERVED = new Set(["a", "an", "the", "new", "field", "form", "table", "chart", "role", "it", "this"]);

function inferType(name: string): FieldType {
  if (/(amount|total|price|cost|qty|quantity|count|hours|days|rate|number|score|budget)/.test(name)) return "number";
  if (/(date|when|due|start|end|deadline|at)$/.test(name) || /^(date|start|end)/.test(name)) return "datetime";
  if (/(notes?|comments?|description|reason|summary|details?|message)/.test(name)) return "text";
  if (/^(is|has|should|can)[A-Z_]?/.test(name)) return "boolean";
  return "string";
}

function kindForType(type: FieldType): string {
  if (type === "number") return "number";
  if (type === "datetime") return "date";
  if (type === "text") return "textarea";
  return "text";
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Document introspection                                             */
/* ------------------------------------------------------------------ */

interface Located {
  node: Node;
  /** an IR patch path addressing this node, e.g. views.name(list).root.children.1 */
  path: string;
}

function findAction(doc: AppDocument, nameish: string) {
  const want = nameish.toLowerCase();
  return (
    doc.actions.find((a) => a.name.toLowerCase() === want) ??
    doc.actions.find((a) => a.name.toLowerCase().includes(want))
  );
}

/** Depth-first search across every view, returning the first match with a path. */
function findNode(doc: AppDocument, pred: (n: Node) => boolean): Located | undefined {
  for (const view of doc.views) {
    const hit = walk(view, view.root, `views.name(${view.name}).root`, pred);
    if (hit) return hit;
  }
  return undefined;
}

function walk(view: View, node: Node, path: string, pred: (n: Node) => boolean): Located | undefined {
  if (pred(node)) return { node, path };
  const kids = node.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    const hit = walk(view, kids[i]!, `${path}.children.${i}`, pred);
    if (hit) return hit;
  }
  return undefined;
}

function columnsOf(n: Node): string[] {
  const cols = n.props?.columns;
  return Array.isArray(cols) ? cols.map(String) : [];
}

function bindModel(n: Node): string | undefined {
  const bind = (n as { bind?: { query?: { model?: string } } }).bind;
  return bind?.query?.model;
}

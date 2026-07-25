/**
 * IR patches — how the AI (and users) edit an application.
 *
 * WHY structured patches instead of regenerating the whole document:
 *  - Precision: a "add a comments field" edit touches one node, not the world.
 *  - Diffable: patches ARE the semantic diff shown in version history.
 *  - Safe: each patch is validated before it is applied; a bad patch is a
 *    no-op, never a corrupt app.
 *  - Cheap: small edits are small payloads, ideal for conversational editing.
 *
 * Paths use a simple dotted syntax with numeric segments for arrays and
 * `name(x)` selectors for addressing array members by their `name` field,
 * e.g. `models.name(Expense).fields` or `actions.name(submitExpense)`.
 */

export type Patch =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "insert"; path: string; index?: number; value: unknown };

export interface PathSegment {
  key: string;
  /** when set, select an array element whose `[selectorKey] === key`. */
  selectorKey?: string;
}

export function parsePath(path: string): PathSegment[] {
  if (path === "") return [];
  return path.split(".").map((raw) => {
    const m = /^([A-Za-z0-9_]+)\(([^)]*)\)$/.exec(raw);
    if (m) return { key: m[2] as string, selectorKey: m[1] as string };
    return { key: raw };
  });
}

function resolveContainer(
  root: unknown,
  segs: PathSegment[],
): { parent: any; key: string | number } {
  let node: any = root;
  for (let i = 0; i < segs.length - 1; i++) {
    node = descend(node, segs[i]!);
    if (node === undefined) throw new Error(`patch path not found at segment ${i}`);
  }
  const last = segs[segs.length - 1]!;
  return locate(node, last);
}

function descend(node: any, seg: PathSegment): any {
  const { parent, key } = locate(node, seg);
  return key === undefined ? undefined : parent[key as any];
}

function locate(node: any, seg: PathSegment): { parent: any; key: string | number } {
  if (seg.selectorKey !== undefined) {
    if (!Array.isArray(node)) throw new Error(`selector on non-array`);
    const idx = node.findIndex((el) => el && el[seg.selectorKey!] === seg.key);
    if (idx < 0) throw new Error(`no element where ${seg.selectorKey}=${seg.key}`);
    return { parent: node, key: idx };
  }
  if (Array.isArray(node) && /^\d+$/.test(seg.key)) {
    return { parent: node, key: Number(seg.key) };
  }
  return { parent: node, key: seg.key };
}

/** Apply a single patch to a deep copy; the input is never mutated. */
export function applyPatch<T>(doc: T, patch: Patch): T {
  const next = structuredClone(doc);
  const segs = parsePath(patch.path);
  if (segs.length === 0) {
    if (patch.op === "set") return patch.value as T;
    throw new Error("cannot remove/insert at root");
  }
  const { parent, key } = resolveContainer(next, segs);
  if (patch.op === "set") {
    parent[key] = patch.value;
  } else if (patch.op === "remove") {
    if (Array.isArray(parent) && typeof key === "number") parent.splice(key, 1);
    else delete parent[key];
  } else {
    const arr = parent[key];
    if (!Array.isArray(arr)) throw new Error(`insert target is not an array`);
    const at = patch.index ?? arr.length;
    arr.splice(at, 0, patch.value);
  }
  return next;
}

export function applyPatches<T>(doc: T, patches: Patch[]): T {
  return patches.reduce<T>((d, p) => applyPatch(d, p), doc);
}

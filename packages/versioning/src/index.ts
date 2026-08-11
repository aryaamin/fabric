import type { AppDocument } from "@fabric/ir";

/**
 * Versioning.
 *
 * WHY content-addressed snapshots forming a DAG: every conversational edit
 * produces a new immutable version. Because the IR is plain JSON, a version is
 * just a hashed document plus a parent pointer. That yields, for free:
 *   - Restore  = point head at an older version
 *   - Fork     = start a new app whose root parent is another app's version
 *   - Duplicate= fork within the same workspace
 *   - Compare  = structural diff of two documents
 * All the ergonomics of Git, none of the exposure. Users see "history", never
 * "commits" or "branches".
 */

export interface Version {
  id: string;
  parent?: string;
  appId: string;
  createdAt: string;
  /** "ai", "system", or a user id. */
  author: string;
  /** the prompt or a human summary of the change. */
  message: string;
  doc: AppDocument;
}

export interface CommitInput {
  appId: string;
  doc: AppDocument;
  parent?: string;
  author?: string;
  message?: string;
}

export class VersionStore {
  private versions = new Map<string, Version>();
  private heads = new Map<string, string>();

  commit(input: CommitInput): Version {
    const id = hashDoc(input.doc);
    const existing = this.versions.get(id);
    const version: Version =
      existing ?? {
        id,
        appId: input.appId,
        createdAt: new Date().toISOString(),
        author: input.author ?? "ai",
        message: input.message ?? "edit",
        doc: input.doc,
        ...(input.parent ? { parent: input.parent } : {}),
      };
    this.versions.set(id, version);
    this.heads.set(input.appId, id);
    return version;
  }

  get(id: string): Version | undefined {
    return this.versions.get(id);
  }

  head(appId: string): Version | undefined {
    const id = this.heads.get(appId);
    return id ? this.versions.get(id) : undefined;
  }

  /** move head (restore). Returns the version now at head. */
  restore(appId: string, versionId: string): Version {
    const v = this.versions.get(versionId);
    if (!v || v.appId !== appId) throw new Error(`version ${versionId} not in app ${appId}`);
    this.heads.set(appId, versionId);
    return v;
  }

  /** history from head back to root, newest first. */
  history(appId: string): Version[] {
    const out: Version[] = [];
    let cur = this.heads.get(appId);
    while (cur) {
      const v = this.versions.get(cur);
      if (!v) break;
      out.push(v);
      cur = v.parent;
    }
    return out;
  }

  /**
   * every version of an app, oldest first.
   *
   * history() walks the parent chain from head, so restoring an older version
   * hides everything committed after it. Timelines want the whole DAG.
   */
  all(appId: string): Version[] {
    const out: Version[] = [];
    for (const v of this.versions.values()) if (v.appId === appId) out.push(v);
    return out;
  }

  /** create a new app rooted at an existing version. */
  fork(versionId: string, newAppId: string, author = "user"): Version {
    const src = this.versions.get(versionId);
    if (!src) throw new Error(`version ${versionId} not found`);
    const doc: AppDocument = { ...structuredClone(src.doc), id: newAppId };
    return this.commit({
      appId: newAppId,
      doc,
      parent: src.id,
      author,
      message: `forked from ${src.appId}@${src.id.slice(0, 8)}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Structural diff                                                     */
/* ------------------------------------------------------------------ */

export interface Change {
  kind: "added" | "removed" | "changed";
  path: string;
  detail?: string;
}

/** Human-legible diff between two IR documents. Powers "Compare versions". */
export function diff(a: AppDocument, b: AppDocument): Change[] {
  const changes: Change[] = [];
  walk(a as unknown, b as unknown, "");
  return changes;

  function walk(x: unknown, y: unknown, path: string) {
    if (deepEqual(x, y)) return;
    if (!isObj(x) || !isObj(y)) {
      changes.push({ kind: "changed", path: path || "(root)", detail: `${short(x)} → ${short(y)}` });
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in x)) changes.push({ kind: "added", path: p });
      else if (!(k in y)) changes.push({ kind: "removed", path: p });
      else walk((x as any)[k], (y as any)[k], p);
    }
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 40 ? s.slice(0, 37) + "..." : String(s);
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/* ------------------------------------------------------------------ */
/* Stable content hash (zero-dep, deterministic across runs)           */
/* ------------------------------------------------------------------ */

export function hashDoc(doc: AppDocument): string {
  const json = JSON.stringify(canonical(doc));
  return "v_" + fnv1a(json);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export * from "./repository.ts";

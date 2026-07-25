import type { CapabilityFactory, CapabilityManifest } from "@fabric/capabilities";

/**
 * The Capability Registry.
 *
 * WHY a registry rather than hardcoded capabilities: the platform's power is
 * defined by what it can do, and that set must grow without editing the
 * runtime. Capabilities are plugins keyed by name+version. The AI browses the
 * registry to learn what apps can be built; the runtime resolves factories to
 * serve calls. This is the single extension point of the whole platform.
 */

interface Entry {
  factory: CapabilityFactory;
  version: string;
}

export class CapabilityRegistry {
  private byName = new Map<string, Entry[]>();

  register(factory: CapabilityFactory): this {
    const { name, version } = factory.manifest;
    const list = this.byName.get(name) ?? [];
    if (list.some((e) => e.version === version)) {
      throw new Error(`capability ${name}@${version} already registered`);
    }
    list.push({ factory, version });
    list.sort((a, b) => compareSemver(b.version, a.version));
    this.byName.set(name, list);
    return this;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Resolve a factory by name and optional exact/range version. */
  resolve(name: string, versionRange?: string): CapabilityFactory {
    const list = this.byName.get(name);
    if (!list || list.length === 0) throw new Error(`capability "${name}" not installed`);
    if (!versionRange) return list[0]!.factory; // highest version
    const exact = list.find((e) => e.version === versionRange);
    if (exact) return exact.factory;
    const compat = list.find((e) => satisfiesCaret(e.version, versionRange));
    if (!compat) throw new Error(`no ${name} matching "${versionRange}"`);
    return compat.factory;
  }

  /** All manifests — the catalog the AI reads to plan applications. */
  manifests(): CapabilityManifest[] {
    return [...this.byName.values()].map((l) => l[0]!.factory.manifest);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }
}

function parseSemver(v: string): [number, number, number] {
  const [a = "0", b = "0", c = "0"] = v.split("-")[0]!.split(".");
  return [Number(a), Number(b), Number(c)];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/** minimal caret range: "^1.2.0" matches same major, >= minor.patch. */
function satisfiesCaret(version: string, range: string): boolean {
  if (!range.startsWith("^")) return version === range;
  const want = parseSemver(range.slice(1));
  const have = parseSemver(version);
  if (have[0] !== want[0]) return false;
  return compareSemver(version, range.slice(1)) >= 0;
}

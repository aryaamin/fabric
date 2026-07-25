/**
 * Minimal class-name joiner. We do not pull in clsx/tailwind-merge: the
 * primitives below are hand-written and never receive conflicting utilities,
 * so a 6-line join is the honest amount of machinery for the job.
 */
export type ClassValue = string | number | null | false | undefined | ClassValue[];

export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const v of values) {
    if (!v && v !== 0) continue;
    if (Array.isArray(v)) {
      const nested = cn(...v);
      if (nested) out.push(nested);
    } else {
      out.push(String(v));
    }
  }
  return out.join(" ");
}

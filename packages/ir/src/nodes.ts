/**
 * The UI vocabulary — the closed set of node types every Fabric renderer must
 * understand.
 *
 * WHY a fixed vocabulary instead of arbitrary components: the IR is authored by
 * an AI and rendered by several independent renderers (React in the studio,
 * server-side HTML on the preview host, and eventually native/embed targets).
 * If the vocabulary were open, a document that renders in one surface would
 * silently degrade in another. Keeping it small and closed makes "one document,
 * many renderers" a checkable property — the validator can reject unknown types
 * and every renderer has a finite switch to satisfy.
 *
 * The contract (props are Exprs; `data` always comes from a `bind` query):
 *
 *   Page    { title, subtitle? }                       children
 *   Card    { title?, subtitle? }                      children
 *   Stack   { gap? }                                   children (vertical)
 *   Row     { gap? }                                   children (horizontal)
 *   Heading { text, level? }
 *   Text    { text, muted? }
 *   Badge   { text, tone? }
 *   Stat    { label, value, hint? }                    dashboard metric card
 *   Table   { columns, rows, badgeColumn? }            data from bind
 *   Chart   { kind: "bar", labelField, valueField, title? }   data from bind
 *   Button  { label, variant? }                        on.click
 *   Form    { submitLabel? }                           children = Field[], on.submit
 *   Field   { name, label, kind, options?, placeholder?, required? }
 *   Empty   { text }
 */

export const NODE_TYPES = [
  "Page",
  "Card",
  "Stack",
  "Row",
  "Heading",
  "Text",
  "Badge",
  "Stat",
  "Table",
  "Chart",
  "Button",
  "Form",
  "Field",
  "Empty",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** Input kinds a `Field` may declare. */
export const FIELD_KINDS = ["text", "number", "textarea", "date", "select"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Semantic colours a `Badge` may carry. Renderers map these to their palette. */
export const BADGE_TONES = ["neutral", "success", "warning", "danger"] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

export type ButtonVariant = "primary" | "ghost";
export type ChartKind = "bar";

export function isNodeType(t: string): t is NodeType {
  return (NODE_TYPES as readonly string[]).includes(t);
}

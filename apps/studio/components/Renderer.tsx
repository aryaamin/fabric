"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { RenderNode } from "@fabric/interpreter";
import { cn } from "../lib/cn";
import { Badge, toneForValue, type BadgeTone } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardHeader } from "./ui/Card";
import { EmptyState } from "./ui/Empty";
import { Input, Label, Select, Textarea } from "./ui/Input";

/**
 * The React renderer.
 *
 * It consumes the exact same RenderNode tree the HTML renderer in apps/server
 * consumes. That equivalence is the proof that views in the IR are truly
 * renderer-agnostic: the interpreter decides *what* to show, a renderer decides
 * *how*. Swapping renderers (React, HTML, native, an embeddable web component)
 * never touches an application — which is also why an app can be embedded
 * anywhere without a second implementation to keep in sync.
 *
 * The node vocabulary here is the contract shared with apps/server's renderer:
 * Page Card Stack Row Heading Text Badge Stat Table Chart Button Form Field Empty.
 */

export interface RendererProps {
  node: RenderNode;
  /** A button fired. */
  onAction?: (action: string, args: Record<string, unknown>) => Promise<void> | void;
  /**
   * A form was submitted. Raw field values only — never evaluated arguments.
   * The runtime evaluates the handler's `args` Exprs itself, from the installed
   * document, so the browser cannot invent arguments the program never declared.
   */
  onSubmit?: (action: string, values: Record<string, unknown>) => Promise<void>;
  /** Read-only visitors see inputs and buttons, disabled, not a missing UI. */
  readOnly?: boolean;
}

export function Renderer(props: RendererProps) {
  return <Node {...props} depth={0} />;
}

function Node({ node, onAction, onSubmit, readOnly, depth }: RendererProps & { depth: number }) {
  const kids = node.children.map((c, i) => (
    <Node key={i} node={c} onAction={onAction} onSubmit={onSubmit} readOnly={readOnly} depth={depth + 1} />
  ));
  const p = node.props;
  const str = (k: string, fallback = "") => (p[k] === undefined || p[k] === null ? fallback : String(p[k]));

  switch (node.type) {
    case "Page":
      return (
        <div className="animate-rise mx-auto w-full max-w-[880px] px-8 py-9">
          <header className="mb-7">
            <h1 className="text-[25px] font-semibold tracking-[-0.022em] text-ink">{str("title")}</h1>
            {p.subtitle !== undefined && (
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">{str("subtitle")}</p>
            )}
          </header>
          <div className="flex flex-col gap-5">{kids}</div>
        </div>
      );

    case "Card":
      return (
        <Card>
          <CardHeader title={p.title !== undefined ? str("title") : undefined} subtitle={p.subtitle !== undefined ? str("subtitle") : undefined} />
          <div className="flex flex-col gap-4 p-4">{kids}</div>
        </Card>
      );

    case "Stack":
      return <div className={cn("flex flex-col", gapClass(p.gap))}>{kids}</div>;

    case "Row":
      return <div className={cn("flex flex-wrap items-start", gapClass(p.gap))}>{kids}</div>;

    case "Heading": {
      const level = Number(p.level ?? 2);
      return (
        <h2
          className={cn(
            "font-semibold tracking-[-0.015em] text-ink",
            level <= 1 ? "text-[21px]" : level === 2 ? "text-[16px]" : "text-[14px]",
          )}
        >
          {str("text")}
        </h2>
      );
    }

    case "Text":
      return (
        <p className={cn("text-[13.5px] leading-relaxed", p.muted ? "text-ink-3" : "text-ink-2")}>{str("text")}</p>
      );

    case "Badge":
      return <Badge tone={badgeTone(p.tone)}>{str("text")}</Badge>;

    case "Stat":
      return (
        <div className="min-w-[150px] flex-1 rounded-lg border border-line bg-panel px-4 py-3.5">
          <div className="text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">{str("label")}</div>
          <div className="mt-1.5 font-mono text-[26px] font-medium leading-none tracking-[-0.02em] text-ink">
            {str("value", "—")}
          </div>
          {p.hint !== undefined && <div className="mt-1.5 text-[12px] text-ink-3">{str("hint")}</div>}
        </div>
      );

    case "Table":
      return <TableNode node={node} />;

    case "Chart":
      return <ChartNode node={node} />;

    case "Button": {
      const h = node.handlers.click;
      return (
        <ActionButton
          label={str("label", "Action")}
          variant={p.variant === "primary" ? "primary" : "ghost"}
          disabled={readOnly || !h}
          onRun={h && onAction ? () => onAction(h.action, {}) : undefined}
        />
      );
    }

    case "Form":
      return <FormNode node={node} onSubmit={onSubmit} readOnly={readOnly} />;

    case "Field":
      // Fields are rendered by their Form (it owns the values). A stray Field
      // outside a Form is a document bug, so say so rather than render nothing.
      return (
        <div className="rounded-md border border-warn/25 bg-warn-dim px-3 py-2 text-[12.5px] text-warn">
          Field <code className="font-mono">{str("name")}</code> is not inside a Form.
        </div>
      );

    case "Empty":
      return <EmptyState title={str("text", "Nothing here yet")} />;

    default:
      // Unknown node types must degrade, never throw: a document may be newer
      // than this renderer, and the app still has to be usable.
      return (
        <div data-type={node.type} className="flex flex-col gap-3">
          {kids}
        </div>
      );
  }
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

function TableNode({ node }: { node: RenderNode }) {
  const cols = (node.props.columns as string[] | undefined) ?? [];
  const rows = node.data ?? [];
  const badgeColumn = node.props.badgeColumn === undefined ? undefined : String(node.props.badgeColumn);

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line">
              {cols.map((c) => (
                <th
                  key={c}
                  className="whitespace-nowrap px-4 py-2.5 text-left text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(cols.length, 1)} className="px-4 py-10 text-center text-[13px] text-ink-3">
                  {String(node.props.empty ?? "No rows yet — add the first one above.")}
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr
                  key={i}
                  className="animate-rise border-b border-line-soft transition-colors duration-150 last:border-0 hover:bg-hover/60"
                  style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
                >
                  {cols.map((c) => {
                    const raw = (r as Record<string, unknown>)[c];
                    return (
                      <td key={c} className={cn("px-4 py-2.5 align-middle", isNumeric(raw) && "font-mono tabular-nums")}>
                        {c === badgeColumn ? (
                          <Badge tone={toneForValue(raw)} dot>
                            {String(raw ?? "")}
                          </Badge>
                        ) : (
                          cellText(raw)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Chart                                                               */
/* ------------------------------------------------------------------ */

function ChartNode({ node }: { node: RenderNode }) {
  const rows = node.data ?? [];
  const labelField = String(node.props.labelField ?? "label");
  const valueField = String(node.props.valueField ?? "value");
  const title = node.props.title === undefined ? undefined : String(node.props.title);

  const bars = useMemo(
    () =>
      rows.map((r) => ({
        label: String((r as Record<string, unknown>)[labelField] ?? ""),
        value: Number((r as Record<string, unknown>)[valueField] ?? 0),
      })),
    [rows, labelField, valueField],
  );
  const max = Math.max(1, ...bars.map((b) => b.value));

  return (
    <Card>
      <CardHeader title={title} subtitle={bars.length ? undefined : "No data yet"} />
      <div className="p-4">
        {bars.length === 0 ? (
          <EmptyState title="Nothing to plot yet" hint="Add a row and the chart fills in immediately." />
        ) : (
          <div className="flex flex-col gap-2.5">
            {bars.map((b, i) => (
              <div key={`${b.label}-${i}`} className="flex items-center gap-3">
                <div className="w-16 shrink-0 truncate text-right text-[12px] text-ink-3">{b.label}</div>
                <div className="relative h-6 flex-1 overflow-hidden rounded-sm bg-raised">
                  <div
                    className="animate-grow-x h-full rounded-sm bg-gradient-to-r from-accent/70 to-accent"
                    style={{ width: `${(b.value / max) * 100}%`, animationDelay: `${i * 45}ms` }}
                  />
                </div>
                <div className="w-20 shrink-0 font-mono text-[12.5px] tabular-nums text-ink-2">
                  {b.value.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Form — the write path a non-technical user actually touches          */
/* ------------------------------------------------------------------ */

function FormNode({
  node,
  onSubmit,
  readOnly,
}: {
  node: RenderNode;
  onSubmit?: RendererProps["onSubmit"];
  readOnly?: boolean;
}) {
  const fields = node.children.filter((c) => c.type === "Field");
  const handler = node.handlers.submit;
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [justSaved, setJustSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || readOnly || !handler || !onSubmit) return;

    const blank = fields
      .filter((f) => f.props.required && !String(values[String(f.props.name)] ?? "").trim())
      .map((f) => String(f.props.name));
    setMissing(blank);
    if (blank.length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await onSubmit(handler.action, values);
      // The parent swaps in a freshly rendered tree, which remounts this form;
      // resetting here keeps the reset honest even when it does not.
      setValues(initialValues(fields));
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1400);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // No Card wrapper: documents place their forms inside a Card when they want
  // one (see the Expense Tracker's "New expense" card), and nesting a second
  // card inside it would double the chrome.
  return (
    <div>
      {node.props.title !== undefined && (
        <h3 className="mb-3 text-[15px] font-semibold tracking-[-0.015em] text-ink">{String(node.props.title)}</h3>
      )}
      {!handler && (
        <div className="mb-3 rounded-md border border-warn/25 bg-warn-dim px-3 py-2 text-[12.5px] text-warn">
          This form declares no submit action.
        </div>
      )}
      <form onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {fields.map((f) => {
            const name = String(f.props.name);
            const kind = String(f.props.kind ?? "text");
            const label = String(f.props.label ?? name);
            const id = `f-${name}`;
            const invalid = missing.includes(name);
            const wide = kind === "textarea";
            return (
              <div key={name} className={cn("flex flex-col gap-1.5", wide && "sm:col-span-2")}>
                <Label htmlFor={id} hint={f.props.required ? "required" : undefined}>
                  {label}
                </Label>
                <FieldControl
                  id={id}
                  kind={kind}
                  node={f}
                  value={values[name] ?? ""}
                  invalid={invalid}
                  disabled={busy || readOnly}
                  onChange={(v) => setValues((s) => ({ ...s, [name]: v }))}
                />
              </div>
            );
          })}
        </div>

        {error && <div className="mt-3 text-[12.5px] text-bad">{error}</div>}
        {missing.length > 0 && !error && (
          <div className="mt-3 text-[12.5px] text-warn">Fill in the required fields to continue.</div>
        )}

        <div className="mt-4 flex items-center gap-2.5">
          <Button type="submit" variant="primary" loading={busy} disabled={readOnly || !handler}>
            {String(node.props.submitLabel ?? "Submit")}
          </Button>
          {readOnly && <span className="text-[12.5px] text-ink-3">You have view-only access.</span>}
          {justSaved && !readOnly && (
            <span className="animate-fade text-[12.5px] text-ok">Saved — no rebuild, no redeploy.</span>
          )}
        </div>
      </form>
    </div>
  );
}

function FieldControl({
  id,
  kind,
  node,
  value,
  invalid,
  disabled,
  onChange,
}: {
  id: string;
  kind: string;
  node: RenderNode;
  value: string;
  invalid: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const placeholder = node.props.placeholder === undefined ? undefined : String(node.props.placeholder);
  const common = { id, value, invalid, disabled, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };

  if (kind === "textarea") return <Textarea {...common} placeholder={placeholder} rows={3} />;
  if (kind === "select") {
    const options = (node.props.options as string[] | undefined) ?? [];
    return (
      <Select {...common}>
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      {...common}
      type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
      step={kind === "number" ? "any" : undefined}
      placeholder={placeholder}
    />
  );
}

/** A button that shows its own pending state, so a click always feels answered. */
function ActionButton({
  label,
  variant,
  disabled,
  onRun,
}: {
  label: string;
  variant: "primary" | "ghost";
  disabled?: boolean;
  onRun?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      loading={busy}
      disabled={disabled}
      onClick={async () => {
        if (!onRun) return;
        setBusy(true);
        try {
          await onRun();
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function initialValues(fields: RenderNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[String(f.props.name)] = "";
  return out;
}

function gapClass(gap: unknown): string {
  const n = Number(gap);
  if (!Number.isFinite(n)) return "gap-4";
  if (n <= 1) return "gap-1.5";
  if (n === 2) return "gap-2.5";
  if (n === 3) return "gap-3.5";
  if (n >= 6) return "gap-7";
  return "gap-5";
}

function badgeTone(tone: unknown): BadgeTone {
  const t = String(tone ?? "neutral");
  return t === "success" || t === "warning" || t === "danger" || t === "accent" ? (t as BadgeTone) : "neutral";
}

function isNumeric(v: unknown): boolean {
  return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)));
}

function cellText(v: unknown): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-ink-3">—</span>;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return <span className="font-mono text-[12px]">{JSON.stringify(v)}</span>;
  return String(v);
}

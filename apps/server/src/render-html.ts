import type { RenderNode } from "@fabric/interpreter";

/**
 * A reference HTML renderer for the RenderNode tree.
 *
 * This proves a central claim: the interpreter output is renderer-agnostic. The
 * studio consumes the same tree with React; here one pure function turns it into
 * a server-rendered page for URLs and embeds. Neither app's IR changes when the
 * renderer changes — the two renderers only have to agree on the *vocabulary*
 * (see `@fabric/ir`'s node contract), never on implementation.
 *
 * Forms are the interesting case: this renderer emits a plain
 * `<form method="POST">` that posts raw field values to the server, which
 * evaluates the handler's arguments from the IR (see `Runtime.submit`). The
 * result is a data-entry UI that works with zero client JavaScript.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface RenderOptions {
  /** Where `<form>`s post to, e.g. "/submit/ws_acme/expense-tracker-1". */
  submitUrl?: string;
  /** The view being rendered; posted back so the server re-resolves the same one. */
  viewName?: string;
  /** Query string (access token, role) to carry through the POST redirect. */
  submitQuery?: string;
  /** Same-origin path to redirect back to after a successful submit. */
  returnTo?: string;
  /** False for read-only visitors: forms render disabled with an explanation. */
  canSubmit?: boolean;
}

export function renderNode(node: RenderNode, opts: RenderOptions = {}): string {
  const kids = node.children.map((c) => renderNode(c, opts)).join("");
  const p = node.props;

  switch (node.type) {
    case "Page":
      return `<main class="page"><header class="page-head"><h1>${esc(p.title)}</h1>${
        p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ""
      }</header>${kids}</main>`;

    case "Card":
      return `<section class="card">${
        p.title ? `<div class="card-head"><h3>${esc(p.title)}</h3>${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ""}</div>` : ""
      }<div class="card-body">${kids}</div></section>`;

    case "Stack":
      return `<div class="stack"${gap(p.gap)}>${kids}</div>`;

    case "Row":
      return `<div class="row"${gap(p.gap)}>${kids}</div>`;

    case "Heading": {
      const level = Math.min(Math.max(Number(p.level ?? 2), 1), 4);
      return `<h${level} class="hd hd-${level}">${esc(p.text)}</h${level}>`;
    }

    case "Text":
      return `<p class="${p.muted ? "sub" : "txt"}">${esc(p.text)}</p>`;

    case "Badge":
      return badge(p.text, p.tone);

    case "Stat":
      return `<div class="stat"><span class="stat-label">${esc(p.label)}</span><span class="stat-value">${esc(
        group(p.value),
      )}</span>${p.hint ? `<span class="stat-hint">${esc(p.hint)}</span>` : ""}</div>`;

    case "Table":
      return renderTable(node);

    case "Chart":
      return renderChart(node);

    case "Button":
      return `<button class="btn${p.variant === "ghost" ? " btn-ghost" : ""}" type="button">${esc(
        p.label ?? "Action",
      )}</button>`;

    case "Form":
      return renderForm(node, opts);

    case "Field":
      return renderField(node);

    case "Empty":
      return `<div class="empty-box">${esc(p.text)}</div>`;

    default:
      return `<div data-type="${esc(node.type)}">${kids}</div>`;
  }
}

/**
 * Thousands separators for numeric metrics, including a leading currency mark.
 * Presentation belongs to the renderer, so documents keep writing plain sums.
 */
function group(v: unknown): string {
  const s = String(v ?? "");
  const m = /^([^\d]?)(\d+)(\.\d+)?$/.exec(s);
  if (!m) return s;
  const int = m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${m[1] ?? ""}${int}${m[3] ? Number(`0${m[3]}`).toFixed(2).slice(1) : ""}`;
}

function gap(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? ` style="gap:${Math.min(n, 64)}px"` : "";
}

const TONES = new Set(["neutral", "success", "warning", "danger"]);

function badge(text: unknown, tone: unknown): string {
  const t = typeof tone === "string" && TONES.has(tone) ? tone : toneForValue(text);
  return `<span class="badge badge-${t}">${esc(text)}</span>`;
}

/**
 * Sensible default tone from a status-like value, so a table can render a
 * `status` column as a Badge without the document restating the colour of every
 * possible value.
 */
function toneForValue(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  if (["approved", "done", "paid", "active", "positive", "success"].includes(s)) return "success";
  if (["pending", "review", "waiting", "neutral"].includes(s)) return "warning";
  if (["rejected", "failed", "overdue", "negative", "bug"].includes(s)) return "danger";
  return "neutral";
}

function renderTable(node: RenderNode): string {
  const cols = (node.props.columns as string[]) ?? [];
  const badgeCol = typeof node.props.badgeColumn === "string" ? node.props.badgeColumn : undefined;
  const rows = node.data ?? [];
  const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join("");
  const body = rows
    .map((r) => {
      const cells = cols
        .map((c) => {
          const v = (r as Record<string, unknown>)[c];
          return `<td>${c === badgeCol ? badge(v, undefined) : esc(v)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${
    body || `<tr><td colspan="${cols.length || 1}" class="empty">Nothing here yet</td></tr>`
  }</tbody></table></div>`;
}

/** Bar chart as styled divs: no client JS, no charting dependency. */
function renderChart(node: RenderNode): string {
  const labelField = String(node.props.labelField ?? "label");
  const valueField = String(node.props.valueField ?? "value");
  const rows = node.data ?? [];
  const points = rows.map((r) => ({
    label: String((r as Record<string, unknown>)[labelField] ?? ""),
    value: Number((r as Record<string, unknown>)[valueField] ?? 0),
  }));
  const max = points.reduce((m, x) => Math.max(m, x.value), 0) || 1;
  const bars = points
    .map(
      (pt) =>
        `<div class="bar-col" title="${esc(pt.label)}: ${esc(pt.value)}"><div class="bar-val">${esc(
          fmtNum(pt.value),
        )}</div><div class="bar" style="height:${Math.max(2, Math.round((pt.value / max) * 100))}%"></div><div class="bar-label">${esc(
          pt.label,
        )}</div></div>`,
    )
    .join("");
  return `<figure class="chart">${
    node.props.title ? `<figcaption>${esc(node.props.title)}</figcaption>` : ""
  }${points.length ? `<div class="bars">${bars}</div>` : `<div class="empty-box">No data to chart yet</div>`}</figure>`;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * A real HTML form. The POST body carries ONLY the field values plus which view
 * and action are being submitted; the server resolves the handler's arguments
 * from the installed IR, so nothing here is trusted as an argument.
 */
function renderForm(node: RenderNode, opts: RenderOptions): string {
  const action = node.handlers.submit?.action;
  const fields = node.children.map((c) => renderNode(c, opts)).join("");
  const submitLabel = esc(node.props.submitLabel ?? "Submit");

  if (!action) {
    return `<form class="form"><div class="form-fields">${fields}</div><p class="sub">This form has no submit handler.</p></form>`;
  }
  if (opts.canSubmit === false) {
    return `<form class="form" onsubmit="return false"><fieldset disabled><div class="form-fields">${fields}</div><button class="btn" type="submit">${submitLabel}</button></fieldset><p class="sub">🔒 Read-only access — ask for edit access to submit.</p></form>`;
  }

  const url = `${opts.submitUrl ?? ""}${opts.submitQuery ? `?${opts.submitQuery}` : ""}`;
  return `<form class="form" method="POST" action="${esc(url)}">
<input type="hidden" name="__view" value="${esc(opts.viewName ?? "")}"/>
<input type="hidden" name="__action" value="${esc(action)}"/>
${opts.returnTo ? `<input type="hidden" name="__return" value="${esc(opts.returnTo)}"/>` : ""}
<div class="form-fields">${fields}</div>
<button class="btn" type="submit">${submitLabel}</button>
</form>`;
}

function renderField(node: RenderNode): string {
  const p = node.props;
  const name = String(p.name ?? "");
  const kind = String(p.kind ?? "text");
  const id = `f_${name}`;
  const required = p.required === true ? " required" : "";
  const ph = p.placeholder ? ` placeholder="${esc(p.placeholder)}"` : "";
  const control =
    kind === "textarea"
      ? `<textarea id="${esc(id)}" name="${esc(name)}" rows="3"${ph}${required}></textarea>`
      : kind === "select"
        ? `<select id="${esc(id)}" name="${esc(name)}"${required}>${((p.options as unknown[]) ?? [])
            .map((o) => `<option value="${esc(o)}">${esc(label(String(o)))}</option>`)
            .join("")}</select>`
        : `<input id="${esc(id)}" name="${esc(name)}" type="${
            kind === "number" ? "number" : kind === "date" ? "date" : "text"
          }"${kind === "number" ? ` step="any"` : ""}${ph}${required}/>`;
  return `<div class="field"><label for="${esc(id)}">${esc(p.label ?? label(name))}${
    required ? `<span class="req">*</span>` : ""
  }</label>${control}</div>`;
}

/** "submittedBy" → "Submitted by". Column and field names become human labels. */
function label(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * The read-only "use" surface a *viewer* sees: the running app wrapped in a
 * light banner announcing it is read-only, plus a "Fork a copy" affordance so a
 * viewer can turn a shared app into one they own. (Fork is a no-op link for now.)
 */
export function readOnlyChrome(bodyHtml: string, forkUrl: string): string {
  return `<div class="ro-bar"><span>👁 Read-only — you're viewing a shared app.</span><a class="btn btn-sm" href="${esc(forkUrl)}">Fork a copy</a></div>${bodyHtml}`;
}

/**
 * What an *editor/owner* sees on the preview server: the server is not the
 * editor, so it points them at the studio (the make surface) rather than
 * rendering an editing UI it does not have.
 */
export function studioBanner(title: string, studioUrl: string): string {
  return `<main class="page"><header class="page-head"><h1>✏️ ${esc(title)}</h1></header><p class="txt">You have edit access to this app. The preview server only <em>runs</em> apps — open it in Studio to edit.</p><p><a class="btn" href="${esc(studioUrl)}">Open in Studio to edit →</a></p></main>`;
}

/** A dismissible confirmation banner shown after a successful submit. */
export function submittedBanner(message: string): string {
  return `<div class="flash">✓ ${esc(message)}</div>`;
}

export function page(title: string, bodyHtml: string, embed = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(title)}</title>
<style>${CSS(embed)}</style></head>
<body>${embed ? "" : `<div class="chrome">▚ Fabric · ${esc(title)}</div>`}${bodyHtml}</body></html>`;
}

/**
 * One stylesheet, deliberately hand-written: a zinc dark palette with a single
 * violet accent. Apps get a good default look without ever describing style in
 * their IR — appearance is a property of the renderer, not of the document.
 */
const CSS = (embed: boolean) => `
:root{
  color-scheme:dark;
  --bg:#09090b; --panel:#111113; --panel-2:#18181b; --line:#27272a;
  --fg:#fafafa; --muted:#a1a1aa; --faint:#71717a;
  --accent:#8b5cf6; --accent-soft:#8b5cf620;
  --ok:#34d399; --warn:#fbbf24; --bad:#fb7185;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
${embed ? "" : `.chrome{padding:14px 24px;border-bottom:1px solid var(--line);color:var(--faint);font-size:13px;letter-spacing:.02em}`}
.page{max-width:940px;margin:0 auto;padding:40px 24px 72px}
.page-head{margin:0 0 28px}
h1{font-size:26px;line-height:1.25;margin:0;letter-spacing:-.02em;font-weight:650}
.hd{margin:0;letter-spacing:-.01em;font-weight:600}
.hd-1{font-size:24px}.hd-2{font-size:18px}.hd-3{font-size:16px}.hd-4{font-size:14px}
.txt{margin:0;color:var(--fg)}
.sub{margin:6px 0 0;color:var(--muted);font-size:14px}
.stack{display:flex;flex-direction:column;gap:20px}
.row{display:flex;flex-wrap:wrap;gap:16px;align-items:stretch}
.row > *{flex:1 1 200px;min-width:0}

.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.card-head{padding:16px 20px 0}
.card-head h3{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.card-body{padding:16px 20px 20px;display:flex;flex-direction:column;gap:16px}

.stat{display:flex;flex-direction:column;gap:4px;background:var(--panel);
  border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.stat-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.stat-value{font-size:30px;font-weight:650;letter-spacing:-.03em;line-height:1.15}
.stat-hint{color:var(--faint);font-size:13px}

.tbl-wrap{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--panel)}
.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{text-align:left;color:var(--muted);font-weight:500;font-size:12px;
  text-transform:uppercase;letter-spacing:.06em;background:var(--panel-2);
  border-bottom:1px solid var(--line);padding:10px 16px}
.tbl td{border-bottom:1px solid #1c1c20;padding:12px 16px;vertical-align:middle}
.tbl tbody tr:last-child td{border-bottom:0}
.tbl tbody tr:hover{background:#15151a}
.empty{color:var(--faint);text-align:center;padding:32px}
.empty-box{color:var(--faint);text-align:center;padding:28px;border:1px dashed var(--line);border-radius:12px}

.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  font-size:12px;font-weight:500;border:1px solid transparent;text-transform:capitalize}
.badge-neutral{background:#27272a;color:#d4d4d8;border-color:#3f3f46}
.badge-success{background:#34d39918;color:var(--ok);border-color:#34d39940}
.badge-warning{background:#fbbf2418;color:var(--warn);border-color:#fbbf2440}
.badge-danger{background:#fb718518;color:var(--bad);border-color:#fb718540}

.chart{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.chart figcaption{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px}
.bars{display:flex;align-items:flex-end;gap:10px;height:190px}
.bar-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:6px;min-width:0}
.bar-val{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.bar{width:100%;max-width:56px;border-radius:6px 6px 2px 2px;
  background:linear-gradient(180deg,var(--accent),#6d38d9);min-height:2px}
.bar-label{font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}

.form{display:flex;flex-direction:column;gap:16px}
.form fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:16px}
.form-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.field{display:flex;flex-direction:column;gap:6px;min-width:0}
.field label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.req{color:var(--accent);margin-left:3px}
.field input,.field select,.field textarea{
  font:inherit;color:var(--fg);background:var(--panel-2);border:1px solid var(--line);
  border-radius:10px;padding:10px 12px;width:100%;transition:border-color .15s,box-shadow .15s}
.field textarea{resize:vertical;min-height:76px}
.field input:focus,.field select:focus,.field textarea:focus{
  outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.field input::placeholder,.field textarea::placeholder{color:#52525b}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;align-self:flex-start;
  background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 18px;
  font:inherit;font-weight:550;cursor:pointer;text-decoration:none;transition:filter .15s}
.btn:hover{filter:brightness(1.1)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn-sm{padding:5px 12px;font-size:13px}

.ro-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:10px 24px;background:var(--panel);border-bottom:1px solid var(--line);
  color:var(--muted);font-size:13px}
.flash{padding:10px 24px;background:#34d39912;border-bottom:1px solid #34d39930;color:var(--ok);font-size:13px}
`;

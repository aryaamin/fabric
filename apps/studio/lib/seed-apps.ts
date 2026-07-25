import { defineApp, ref, op, fn, type AppDocument, type Expr } from "@fabric/ir";

/**
 * An object literal used as an expression.
 *
 * The evaluator's disambiguation rule says "any object without a reserved `$*`
 * key is an object literal of Exprs", but the published `Expr` union does not
 * yet include that case, so `data: { amount: ref("input.amount") }` fails to
 * typecheck even though it is the documented idiom. This helper states the
 * intent once instead of scattering casts. (Flagged for @fabric/ir.)
 */
const lit = (o: Record<string, Expr>): Expr => o as unknown as Expr;

/** Sort clause as an expression, for capability call arguments. */
const sortBy = (field: string, dir: "asc" | "desc"): Expr => lit({ field, dir });

/**
 * The apps the studio ships with, authored as IR.
 *
 * WHY they live here rather than being imported from `examples/`: the studio is
 * a bundled Next.js app and these documents are its *seed data* — the state a
 * fresh workspace starts in. In the product they are produced by the AI from a
 * sentence; hand-authoring them lets the demo boot with something real to look
 * at, exercise every node type in the renderer contract, and — crucially —
 * form a three-app event chain so the connection graph has wires to pulse:
 *
 *   expense-tracker ──expenseApproved──► accounting ──entryRecorded──► revenue-dashboard
 *
 * Every app declares a `guest` role with read-only model access. That is how
 * the two permission planes stay orthogonal: the *workspace object's* access
 * decides which surface you land on (studio / run / denied), while the app's
 * own roles decide what you may do once you are there. A shared-link viewer is
 * a `guest`: they can read the app's data and cannot invoke a single action.
 */

const STATUS = ["pending", "approved", "rejected"] as const;

/* ------------------------------------------------------------------ */
/* 1. Expense Tracker — forms, approvals, events                       */
/* ------------------------------------------------------------------ */

export const expenseTracker: AppDocument = defineApp({
  id: "expense-tracker",
  name: "Expense Tracker",
  icon: "🧾",
  description: "Employees submit expenses, managers approve, finance watches the spend.",

  capabilities: [{ capability: "storage" }, { capability: "notifications" }, { capability: "ai" }],

  models: [
    {
      name: "Expense",
      fields: [
        { name: "description", type: "string", required: true },
        { name: "amount", type: "number", required: true },
        { name: "category", type: "enum", enum: ["travel", "meals", "software", "other"], default: "other" },
        { name: "status", type: "enum", enum: [...STATUS], default: "pending" },
        { name: "submittedBy", type: "string" },
      ],
    },
  ],

  events: [
    {
      name: "expenseSubmitted",
      payload: [
        { name: "expenseId", type: "string" },
        { name: "amount", type: "number" },
      ],
    },
    {
      name: "expenseApproved",
      payload: [
        { name: "expenseId", type: "string" },
        { name: "amount", type: "number" },
        { name: "description", type: "string" },
      ],
    },
  ],

  actions: [
    {
      name: "submitExpense",
      permission: "submitExpense",
      params: [
        { name: "amount", type: "number", required: true },
        { name: "description", type: "string", required: true },
        { name: "category", type: "string" },
        { name: "submittedBy", type: "string" },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "Expense",
            // `status` is hard-coded in the document, so no crafted request can
            // submit an already-approved expense.
            data: lit({
              description: ref("input.description"),
              amount: ref("input.amount"),
              category: fn("coalesce", ref("input.category"), "other"),
              status: "pending",
              submittedBy: fn("coalesce", ref("input.submittedBy"), ref("user.id")),
            }),
          },
        },
        {
          kind: "call",
          call: "notifications.send",
          args: {
            to: "manager",
            title: op("concat", "New expense: ", ref("input.description")),
            body: op("concat", "Amount: ", ref("input.amount")),
          },
        },
        {
          kind: "emit",
          event: "expenseSubmitted",
          payload: { expenseId: ref("steps.rec.id"), amount: ref("input.amount") },
        },
        { kind: "return", value: op("concat", "Submitted “", ref("input.description"), "”") },
      ],
    },
    {
      // The demo's event source: approving the oldest pending expense emits
      // `expenseApproved`, which the Accounting app is subscribed to. Written
      // with let/if/return so the whole step vocabulary is exercised.
      name: "approveOldest",
      permission: "approveOldest",
      params: [],
      steps: [
        {
          kind: "call",
          id: "pending",
          call: "storage.list",
          args: {
            model: "Expense",
            where: lit({ status: "pending" }),
            sort: [sortBy("createdAt", "asc")],
            limit: 1,
          },
        },
        { kind: "let", id: "target", value: ref("steps.pending.0") },
        {
          kind: "if",
          cond: ref("let.target.id"),
          then: [
            {
              kind: "call",
              call: "storage.update",
              args: { model: "Expense", id: ref("let.target.id"), data: lit({ status: "approved" }) },
            },
            {
              kind: "call",
              call: "notifications.send",
              args: { to: "finance", title: op("concat", "Approved: ", ref("let.target.description")) },
            },
            {
              kind: "emit",
              event: "expenseApproved",
              payload: {
                expenseId: ref("let.target.id"),
                amount: ref("let.target.amount"),
                description: ref("let.target.description"),
              },
            },
            { kind: "return", value: op("concat", "Approved “", ref("let.target.description"), "”") },
          ],
          else: [{ kind: "return", value: "Nothing pending to approve." }],
        },
      ],
    },
    {
      name: "monthlySummary",
      permission: "monthlySummary",
      params: [],
      steps: [
        { kind: "call", id: "all", call: "storage.list", args: { model: "Expense" } },
        {
          kind: "call",
          id: "summary",
          call: "ai.complete",
          args: { prompt: op("concat", "Summarize ", fn("len", ref("steps.all")), " expenses for the month.") },
        },
      ],
      returns: ref("steps.summary"),
    },
  ],

  subscriptions: [],

  views: [
    {
      name: "list",
      route: "/",
      title: "Expenses",
      root: {
        type: "Page",
        props: { title: "Expenses", subtitle: "Submit an expense, and a manager approves it. Nothing here was built or deployed." },
        children: [
          {
            type: "Row",
            props: { gap: "md" },
            children: [
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "Expense", where: lit({ status: "pending" }) } },
                props: { label: "Pending approval", value: fn("len", ref("rows")), hint: "waiting on a manager" },
              },
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "Expense", where: lit({ status: "approved" }) } },
                props: { label: "Approved", value: fn("len", ref("rows")), hint: "recorded in Accounting" },
              },
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "Expense" } },
                props: { label: "All expenses", value: fn("len", ref("rows")), hint: "since this app existed" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Spend by expense", subtitle: "Ten most recent submissions" },
            children: [
              {
                type: "Chart",
                bind: {
                  as: "rows",
                  query: { model: "Expense", sort: [{ field: "createdAt", dir: "desc" }], limit: 10 },
                },
                props: { kind: "bar", labelField: "description", valueField: "amount" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Expenses", subtitle: "Newest first" },
            children: [
              {
                type: "Table",
                bind: { as: "rows", query: { model: "Expense", sort: [{ field: "createdAt", dir: "desc" }] } },
                props: {
                  columns: ["description", "category", "amount", "status", "submittedBy"],
                  rows: ref("rows"),
                  badgeColumn: "status",
                },
              },
            ],
          },
          {
            type: "Row",
            props: { gap: "sm" },
            children: [
              {
                type: "Button",
                props: { label: "Approve oldest pending", variant: "primary" },
                on: { click: { action: "approveOldest" } },
              },
              {
                type: "Text",
                props: { text: "Approving emits an event Accounting is subscribed to — no API between them.", muted: true },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Submit an expense", subtitle: "The browser posts raw field values; the server evaluates the handler’s arguments from the IR." },
            children: [
              {
                type: "Form",
                props: { submitLabel: "Submit expense" },
                on: {
                  submit: {
                    action: "submitExpense",
                    args: {
                      description: ref("form.description"),
                      amount: ref("form.amount"),
                      category: ref("form.category"),
                      submittedBy: ref("user.id"),
                    },
                  },
                },
                children: [
                  {
                    type: "Field",
                    props: { name: "description", label: "Description", kind: "text", placeholder: "Client dinner", required: true },
                  },
                  { type: "Field", props: { name: "amount", label: "Amount", kind: "number", placeholder: "0.00", required: true } },
                  {
                    type: "Field",
                    props: { name: "category", label: "Category", kind: "select", options: ["travel", "meals", "software", "other"] },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ],

  permissions: {
    roles: ["owner", "manager", "employee", "finance", "guest"],
    default: "deny",
    actions: {
      submitExpense: ["employee", "manager"],
      approveOldest: ["manager"],
      monthlySummary: ["manager", "finance"],
    },
    models: {
      Expense: {
        create: ["employee", "manager"],
        update: ["manager"],
        delete: ["owner"],
        // Managers, finance and guests see everything; employees see only what
        // they submitted. One expression is the whole policy.
        read: {
          allow: ["manager", "finance", "employee", "guest"],
          where: op(
            "or",
            op("has", ref("user.roles"), "manager"),
            op("has", ref("user.roles"), "finance"),
            op("has", ref("user.roles"), "guest"),
            op("==", ref("row.submittedBy"), ref("user.id")),
          ),
        },
      },
    },
  },
});

/* ------------------------------------------------------------------ */
/* 2. Accounting — composed with #1 through one event, no API          */
/* ------------------------------------------------------------------ */

export const accounting: AppDocument = defineApp({
  id: "accounting",
  name: "Accounting",
  icon: "📒",
  description: "Keeps the ledger. Records an entry automatically whenever an expense is approved.",

  capabilities: [{ capability: "storage" }],

  models: [
    {
      name: "LedgerEntry",
      fields: [
        { name: "memo", type: "string" },
        { name: "amount", type: "number", required: true },
        { name: "source", type: "string" },
      ],
    },
  ],

  events: [{ name: "entryRecorded", payload: [{ name: "amount", type: "number" }, { name: "memo", type: "string" }] }],

  actions: [
    {
      name: "recordEntry",
      permission: "recordEntry",
      params: [
        { name: "amount", type: "number", required: true },
        { name: "memo", type: "string" },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "LedgerEntry",
            data: lit({ amount: ref("input.amount"), memo: ref("input.memo"), source: "expense-tracker" }),
          },
        },
        { kind: "emit", event: "entryRecorded", payload: { amount: ref("input.amount"), memo: ref("input.memo") } },
      ],
      returns: ref("steps.rec"),
    },
  ],

  // The connection. No import, no HTTP call, no shared table.
  subscriptions: [
    {
      on: "expense-tracker.expenseApproved",
      run: "recordEntry",
      map: { amount: ref("event.amount"), memo: ref("event.description") },
    },
  ],

  views: [
    {
      name: "ledger",
      route: "/",
      title: "Ledger",
      root: {
        type: "Page",
        props: { title: "Ledger", subtitle: "Written by an event from another application." },
        children: [
          {
            type: "Row",
            props: { gap: "md" },
            children: [
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "LedgerEntry" } },
                props: { label: "Entries recorded", value: fn("len", ref("rows")), hint: "one per approved expense" },
              },
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "LedgerEntry", where: lit({ source: "expense-tracker" }) } },
                props: { label: "From Expense Tracker", value: fn("len", ref("rows")), hint: "zero lines of glue code" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Ledger entries", subtitle: "Newest first" },
            children: [
              {
                type: "Table",
                bind: { as: "rows", query: { model: "LedgerEntry", sort: [{ field: "createdAt", dir: "desc" }] } },
                props: { columns: ["memo", "amount", "source"], rows: ref("rows"), badgeColumn: "source" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Reconciliation" },
            children: [
              {
                type: "Empty",
                props: { text: "Nothing to reconcile — approved expenses arrive here on their own." },
              },
            ],
          },
        ],
      },
    },
  ],

  permissions: {
    roles: ["owner", "accountant", "guest"],
    default: "deny",
    actions: { recordEntry: ["accountant"] },
    models: { LedgerEntry: { create: ["accountant"], read: ["accountant", "guest"] } },
  },
});

/* ------------------------------------------------------------------ */
/* 3. Revenue Dashboard — second hop of the event chain                */
/* ------------------------------------------------------------------ */

export const revenueDashboard: AppDocument = defineApp({
  id: "revenue-dashboard",
  name: "Revenue Dashboard",
  icon: "📊",
  description: "Tracks revenue you enter and costs that arrive from the ledger.",

  capabilities: [{ capability: "storage" }],

  models: [
    {
      name: "Metric",
      fields: [
        { name: "label", type: "string", required: true },
        { name: "amount", type: "number", required: true },
        { name: "kind", type: "enum", enum: ["revenue", "cost"], default: "revenue" },
      ],
    },
  ],

  events: [],

  actions: [
    {
      name: "addRevenue",
      permission: "addRevenue",
      params: [
        { name: "label", type: "string", required: true },
        { name: "amount", type: "number", required: true },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: { model: "Metric", data: lit({ label: ref("input.label"), amount: ref("input.amount"), kind: "revenue" }) },
        },
        { kind: "return", value: op("concat", "Added revenue “", ref("input.label"), "”") },
      ],
    },
    {
      name: "trackCost",
      permission: "trackCost",
      params: [
        { name: "amount", type: "number", required: true },
        { name: "memo", type: "string" },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "Metric",
            data: lit({
              label: fn("coalesce", ref("input.memo"), "Cost"),
              amount: ref("input.amount"),
              kind: "cost",
            }),
          },
        },
      ],
      returns: ref("steps.rec"),
    },
  ],

  // Second hop: expense approved → ledger entry → cost on the dashboard.
  subscriptions: [
    {
      on: "accounting.entryRecorded",
      run: "trackCost",
      map: { amount: ref("event.amount"), memo: ref("event.memo") },
    },
  ],

  views: [
    {
      name: "dashboard",
      route: "/",
      title: "Revenue & Costs",
      root: {
        type: "Page",
        props: { title: "Revenue & Costs", subtitle: "Costs arrive two apps downstream of an approval." },
        children: [
          {
            type: "Row",
            props: { gap: "md" },
            children: [
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "Metric", where: lit({ kind: "revenue" }) } },
                props: { label: "Revenue entries", value: fn("len", ref("rows")) },
              },
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "Metric", where: lit({ kind: "cost" }) } },
                props: { label: "Cost entries", value: fn("len", ref("rows")), hint: "auto-tracked from the ledger" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Revenue", subtitle: "Largest first" },
            children: [
              {
                type: "Chart",
                bind: {
                  as: "rows",
                  query: { model: "Metric", where: lit({ kind: "revenue" }), sort: [{ field: "amount", dir: "desc" }], limit: 8 },
                },
                props: { kind: "bar", labelField: "label", valueField: "amount", title: "Revenue by line" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Costs", subtitle: "Written by the Accounting app’s events" },
            children: [
              {
                type: "Table",
                bind: {
                  as: "rows",
                  query: { model: "Metric", where: lit({ kind: "cost" }), sort: [{ field: "createdAt", dir: "desc" }] },
                },
                props: { columns: ["label", "amount", "kind"], rows: ref("rows"), badgeColumn: "kind" },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Add a revenue line" },
            children: [
              {
                type: "Form",
                props: { submitLabel: "Add revenue" },
                on: {
                  submit: {
                    action: "addRevenue",
                    args: { label: ref("form.label"), amount: ref("form.amount") },
                  },
                },
                children: [
                  { type: "Field", props: { name: "label", label: "Line", kind: "text", placeholder: "Q3 retainer", required: true } },
                  { type: "Field", props: { name: "amount", label: "Amount", kind: "number", placeholder: "0.00", required: true } },
                ],
              },
            ],
          },
        ],
      },
    },
  ],

  permissions: {
    roles: ["owner", "analyst", "guest"],
    default: "deny",
    actions: { addRevenue: ["analyst"], trackCost: ["analyst"] },
    models: { Metric: { create: ["analyst"], read: ["analyst", "guest"] } },
  },
});

/* ------------------------------------------------------------------ */
/* 4. Leave Requests — the vision doc's HR example                     */
/* ------------------------------------------------------------------ */

export const leaveRequests: AppDocument = defineApp({
  id: "leave-requests",
  name: "Leave Requests",
  icon: "🏖",
  description: "Employees request time off; managers approve or decline; everyone is notified.",

  capabilities: [{ capability: "storage" }, { capability: "notifications" }],

  models: [
    {
      name: "LeaveRequest",
      fields: [
        { name: "employee", type: "string" },
        { name: "startDate", type: "datetime", required: true },
        { name: "endDate", type: "datetime", required: true },
        { name: "days", type: "number", required: true },
        { name: "reason", type: "text" },
        { name: "status", type: "enum", enum: [...STATUS], default: "pending" },
      ],
    },
  ],

  events: [
    { name: "leaveRequested", payload: [{ name: "requestId", type: "string" }, { name: "days", type: "number" }] },
    { name: "leaveApproved", payload: [{ name: "requestId", type: "string" }, { name: "employee", type: "string" }] },
  ],

  actions: [
    {
      name: "requestLeave",
      permission: "requestLeave",
      params: [
        { name: "days", type: "number", required: true },
        { name: "reason", type: "string" },
        { name: "startDate", type: "datetime", required: true },
        { name: "endDate", type: "datetime", required: true },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "LeaveRequest",
            data: lit({
              employee: ref("user.id"),
              days: ref("input.days"),
              reason: ref("input.reason"),
              startDate: ref("input.startDate"),
              endDate: ref("input.endDate"),
              status: "pending",
            }),
          },
        },
        {
          kind: "call",
          call: "notifications.send",
          args: {
            to: "manager",
            title: op("concat", "Leave request: ", ref("input.days"), " day(s)"),
            body: ref("input.reason"),
          },
        },
        { kind: "emit", event: "leaveRequested", payload: { requestId: ref("steps.rec.id"), days: ref("input.days") } },
        { kind: "return", value: op("concat", "Requested ", ref("input.days"), " day(s)") },
      ],
    },
    {
      name: "approveOldest",
      permission: "approveOldest",
      params: [],
      steps: [
        {
          kind: "call",
          id: "pending",
          call: "storage.list",
          args: {
            model: "LeaveRequest",
            where: lit({ status: "pending" }),
            sort: [sortBy("createdAt", "asc")],
            limit: 1,
          },
        },
        { kind: "let", id: "target", value: ref("steps.pending.0") },
        {
          kind: "if",
          cond: ref("let.target.id"),
          then: [
            {
              kind: "call",
              call: "storage.update",
              args: { model: "LeaveRequest", id: ref("let.target.id"), data: lit({ status: "approved" }) },
            },
            {
              kind: "call",
              call: "notifications.send",
              args: { to: ref("let.target.employee"), title: "Your leave was approved ✅" },
            },
            {
              kind: "emit",
              event: "leaveApproved",
              payload: { requestId: ref("let.target.id"), employee: ref("let.target.employee") },
            },
            { kind: "return", value: "Approved the oldest pending request." },
          ],
          else: [{ kind: "return", value: "Nothing pending to approve." }],
        },
      ],
    },
    {
      name: "remindPending",
      permission: "remindPending",
      params: [],
      steps: [
        {
          kind: "call",
          id: "pending",
          call: "storage.list",
          args: { model: "LeaveRequest", where: lit({ status: "pending" }) },
        },
        {
          kind: "forEach",
          id: "req",
          in: ref("steps.pending"),
          do: [
            {
              kind: "call",
              call: "notifications.send",
              args: {
                to: "manager",
                title: op("concat", "Still pending: ", ref("req.days"), " day(s) for ", ref("req.employee")),
              },
            },
          ],
        },
      ],
      returns: fn("len", ref("steps.pending")),
    },
  ],

  subscriptions: [],

  views: [
    {
      name: "list",
      route: "/",
      title: "Leave Requests",
      root: {
        type: "Page",
        props: { title: "Leave Requests", subtitle: "“I need a leave approval system” — one sentence, one document." },
        children: [
          {
            type: "Row",
            props: { gap: "md" },
            children: [
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "LeaveRequest", where: lit({ status: "pending" }) } },
                props: { label: "Awaiting decision", value: fn("len", ref("rows")) },
              },
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "LeaveRequest", where: lit({ status: "approved" }) } },
                props: { label: "Approved", value: fn("len", ref("rows")) },
              },
              {
                type: "Stat",
                bind: { as: "rows", query: { model: "LeaveRequest" } },
                props: { label: "All requests", value: fn("len", ref("rows")) },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Requests", subtitle: "Newest first" },
            children: [
              {
                type: "Table",
                bind: { as: "rows", query: { model: "LeaveRequest", sort: [{ field: "createdAt", dir: "desc" }] } },
                props: {
                  columns: ["employee", "days", "startDate", "reason", "status"],
                  rows: ref("rows"),
                  badgeColumn: "status",
                },
              },
            ],
          },
          {
            type: "Row",
            props: { gap: "sm" },
            children: [
              {
                type: "Button",
                props: { label: "Approve oldest request", variant: "primary" },
                on: { click: { action: "approveOldest" } },
              },
              {
                type: "Button",
                props: { label: "Remind manager", variant: "ghost" },
                on: { click: { action: "remindPending" } },
              },
            ],
          },
          {
            type: "Card",
            props: { title: "Request time off" },
            children: [
              {
                type: "Form",
                props: { submitLabel: "Request leave" },
                on: {
                  submit: {
                    action: "requestLeave",
                    args: {
                      days: ref("form.days"),
                      reason: ref("form.reason"),
                      startDate: ref("form.startDate"),
                      endDate: ref("form.endDate"),
                    },
                  },
                },
                children: [
                  { type: "Field", props: { name: "startDate", label: "First day", kind: "date", required: true } },
                  { type: "Field", props: { name: "endDate", label: "Last day", kind: "date", required: true } },
                  { type: "Field", props: { name: "days", label: "Working days", kind: "number", placeholder: "3", required: true } },
                  { type: "Field", props: { name: "reason", label: "Reason", kind: "textarea", placeholder: "Family holiday" } },
                ],
              },
            ],
          },
        ],
      },
    },
  ],

  permissions: {
    roles: ["owner", "manager", "employee", "guest"],
    default: "deny",
    actions: {
      requestLeave: ["employee", "manager"],
      approveOldest: ["manager"],
      remindPending: ["manager"],
    },
    models: {
      LeaveRequest: {
        create: ["employee", "manager"],
        update: ["manager"],
        read: {
          allow: ["manager", "employee", "guest"],
          where: op(
            "or",
            op("has", ref("user.roles"), "manager"),
            op("has", ref("user.roles"), "guest"),
            op("==", ref("row.employee"), ref("user.id")),
          ),
        },
      },
    },
  },
});

/** Seed rows so a fresh workspace has something to render. */
export interface SeedRow {
  appId: string;
  action: string;
  args: Record<string, unknown>;
}

export const SEED_DOCS: AppDocument[] = [expenseTracker, accounting, revenueDashboard, leaveRequests];

export const SEED_ROWS: SeedRow[] = [
  { appId: "expense-tracker", action: "submitExpense", args: { description: "Figma team seats", amount: 540, category: "software", submittedBy: "u_dana" } },
  { appId: "expense-tracker", action: "submitExpense", args: { description: "Client dinner — Osaka", amount: 218, category: "meals", submittedBy: "u_sam" } },
  { appId: "expense-tracker", action: "submitExpense", args: { description: "Flight to Berlin summit", amount: 940, category: "travel", submittedBy: "u_owner" } },
  { appId: "expense-tracker", action: "submitExpense", args: { description: "Monitor for new hire", amount: 380, category: "other", submittedBy: "u_kai" } },
  { appId: "expense-tracker", action: "submitExpense", args: { description: "Datadog overage", amount: 126, category: "software", submittedBy: "u_dana" } },
  // Two approvals, so the ledger and the dashboard already have real rows and
  // the connection graph has flowed at least once before anyone touches it.
  { appId: "expense-tracker", action: "approveOldest", args: {} },
  { appId: "expense-tracker", action: "approveOldest", args: {} },
  { appId: "revenue-dashboard", action: "addRevenue", args: { label: "Q3 retainer — Northwind", amount: 24000 } },
  { appId: "revenue-dashboard", action: "addRevenue", args: { label: "Onboarding fee — Initech", amount: 7500 } },
  { appId: "revenue-dashboard", action: "addRevenue", args: { label: "Support contract — Globex", amount: 12800 } },
  { appId: "leave-requests", action: "requestLeave", args: { days: 5, reason: "Family holiday", startDate: "2026-08-10", endDate: "2026-08-14" } },
  { appId: "leave-requests", action: "requestLeave", args: { days: 2, reason: "Moving apartment", startDate: "2026-07-30", endDate: "2026-07-31" } },
  { appId: "leave-requests", action: "approveOldest", args: {} },
];

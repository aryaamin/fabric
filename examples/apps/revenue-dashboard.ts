import { defineApp, ref, op, fn, type AppDocument } from "@fabric/ir";

/**
 * Revenue Dashboard — the "beautiful internal dashboard" case.
 *
 * WHY it earns its place in the examples: dashboards are the single most
 * requested internal app, and they are where declarative IR pays off hardest.
 * Every number on this page is a *query plus one expression* (`Stat`), and the
 * chart is a `bind` plus two field names (`Chart`). There is no aggregation
 * endpoint, no chart library, and no client code — so "add average revenue per
 * month" is a one-node patch, not a deploy.
 *
 * It also shows the write path on a dashboard: the same form both adds a month
 * and edits it, because `recordRevenue` upserts on `month`.
 */
export const revenueDashboard: AppDocument = defineApp({
  id: "revenue-dashboard",
  name: "Revenue Dashboard",
  icon: "📈",
  description: "Monthly revenue: stats, a bar chart, and a form that adds or edits a month.",

  capabilities: [{ capability: "storage" }],

  models: [
    {
      name: "Revenue",
      fields: [
        { name: "month", type: "string", required: true },
        { name: "amount", type: "number", required: true },
        { name: "note", type: "string" },
      ],
    },
  ],

  events: [
    {
      name: "revenueRecorded",
      payload: [
        { name: "month", type: "string" },
        { name: "amount", type: "number" },
      ],
    },
  ],

  actions: [
    {
      // Upsert by month: one form serves "add" and "edit". The branch lives in
      // the document, so the behaviour is visible and diffable.
      name: "recordRevenue",
      permission: "recordRevenue",
      params: [
        { name: "month", type: "string", required: true },
        { name: "amount", type: "number", required: true },
        { name: "note", type: "string" },
      ],
      steps: [
        {
          kind: "call",
          id: "existing",
          call: "storage.list",
          args: { model: "Revenue", where: { month: ref("input.month") }, limit: 1 },
        },
        {
          kind: "if",
          cond: op(">", fn("len", ref("steps.existing")), 0),
          then: [
            {
              kind: "call",
              id: "rec",
              call: "storage.update",
              args: {
                model: "Revenue",
                id: fn("get", ref("steps.existing"), "0.id"),
                data: { amount: ref("input.amount"), note: ref("input.note") },
              },
            },
          ],
          else: [
            {
              kind: "call",
              id: "rec",
              call: "storage.create",
              args: {
                model: "Revenue",
                data: { month: ref("input.month"), amount: ref("input.amount"), note: ref("input.note") },
              },
            },
          ],
        },
        {
          kind: "emit",
          event: "revenueRecorded",
          payload: { month: ref("input.month"), amount: ref("input.amount") },
        },
      ],
      returns: ref("steps.rec"),
    },
    {
      // Seed data so a freshly created dashboard is never an empty page — the
      // first impression of a generated app matters.
      name: "seedDemoData",
      permission: "seedDemoData",
      params: [],
      steps: [
        {
          kind: "forEach",
          id: "row",
          in: [
            { $obj: { month: "Jan", amount: 42000 } },
            { $obj: { month: "Feb", amount: 51500 } },
            { $obj: { month: "Mar", amount: 48250 } },
            { $obj: { month: "Apr", amount: 63100 } },
            { $obj: { month: "May", amount: 71800 } },
            { $obj: { month: "Jun", amount: 69400 } },
          ],
          do: [
            {
              kind: "call",
              call: "storage.create",
              args: { model: "Revenue", data: { month: ref("row.month"), amount: ref("row.amount"), note: "seed" } },
            },
          ],
        },
        { kind: "call", id: "all", call: "storage.list", args: { model: "Revenue" } },
      ],
      returns: fn("len", ref("steps.all")),
    },
  ],

  subscriptions: [],

  views: [
    {
      name: "dashboard",
      route: "/",
      title: "Revenue",
      root: {
        type: "Page",
        props: { title: "Revenue", subtitle: "Every figure below is one query and one expression." },
        children: [
          {
            type: "Stack",
            children: [
              {
                type: "Row",
                bind: { as: "all", query: { model: "Revenue" } },
                children: [
                  {
                    type: "Stat",
                    props: {
                      label: "Total revenue",
                      value: op("concat", "$", fn("sum", fn("pluck", ref("all"), "amount"))),
                      hint: "all recorded months",
                    },
                  },
                  {
                    type: "Stat",
                    props: { label: "Months tracked", value: fn("len", ref("all")), hint: "one row each" },
                  },
                  {
                    type: "Stat",
                    props: {
                      label: "Average / month",
                      // Total conditional: no division by zero on an empty app.
                      value: {
                        $if: [
                          fn("len", ref("all")),
                          op(
                            "concat",
                            "$",
                            op("/", fn("sum", fn("pluck", ref("all"), "amount")), fn("len", ref("all"))),
                          ),
                          "—",
                        ],
                      },
                      hint: "mean of recorded months",
                    },
                  },
                ],
              },
              {
                type: "Chart",
                bind: { as: "series", query: { model: "Revenue", sort: [{ field: "createdAt", dir: "asc" }] } },
                props: { kind: "bar", labelField: "month", valueField: "amount", title: "Revenue by month" },
              },
              {
                type: "Card",
                props: { title: "Add or edit a month", subtitle: "Submitting an existing month updates it." },
                children: [
                  {
                    type: "Form",
                    props: { submitLabel: "Save month" },
                    on: {
                      submit: {
                        action: "recordRevenue",
                        args: { month: ref("form.month"), amount: ref("form.amount"), note: ref("form.note") },
                      },
                    },
                    children: [
                      {
                        type: "Field",
                        props: {
                          name: "month",
                          label: "Month",
                          kind: "select",
                          options: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
                          required: true,
                        },
                      },
                      { type: "Field", props: { name: "amount", label: "Amount", kind: "number", placeholder: "50000", required: true } },
                      { type: "Field", props: { name: "note", label: "Note", kind: "text", placeholder: "optional" } },
                    ],
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "Rows" },
                children: [
                  {
                    type: "Table",
                    bind: { as: "rows", query: { model: "Revenue", sort: [{ field: "createdAt", dir: "asc" }] } },
                    props: { columns: ["month", "amount", "note"], rows: ref("rows") },
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
    roles: ["owner", "analyst", "viewer"],
    default: "deny",
    actions: {
      recordRevenue: ["analyst"],
      seedDemoData: ["analyst"],
    },
    models: {
      Revenue: {
        create: ["analyst"],
        update: ["analyst"],
        read: ["analyst", "viewer"],
      },
    },
  },
});

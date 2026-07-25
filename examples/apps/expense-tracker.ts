import { defineApp, ref, op, fn, type AppDocument } from "@fabric/ir";

/**
 * Example app authored as IR. In the product this document is produced by the
 * AI from a prompt like "I need an expense tracker where employees submit
 * expenses and managers approve them", then edited conversationally. Here we
 * write it by hand to exercise the runtime.
 */
export const expenseTracker: AppDocument = defineApp({
  id: "expense-tracker",
  name: "Expense Tracker",
  icon: "🧾",
  description: "Employees submit expenses; managers approve; finance can view.",

  capabilities: [
    { capability: "storage" },
    { capability: "notifications" },
    { capability: "ai" },
  ],

  models: [
    {
      name: "Expense",
      fields: [
        { name: "amount", type: "number", required: true },
        { name: "description", type: "string", required: true },
        { name: "category", type: "enum", enum: ["travel", "meals", "software", "other"], default: "other" },
        { name: "status", type: "enum", enum: ["pending", "approved", "rejected"], default: "pending" },
        { name: "submittedBy", type: "string" },
      ],
    },
  ],

  events: [
    { name: "expenseSubmitted", payload: [{ name: "expenseId", type: "string" }, { name: "amount", type: "number" }] },
    { name: "expenseApproved", payload: [{ name: "expenseId", type: "string" }, { name: "amount", type: "number" }, { name: "description", type: "string" }] },
  ],

  actions: [
    {
      name: "submitExpense",
      permission: "submitExpense",
      params: [
        { name: "amount", type: "number", required: true },
        { name: "description", type: "string", required: true },
        { name: "category", type: "enum" },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "Expense",
            data: {
              amount: ref("input.amount"),
              description: ref("input.description"),
              category: fn("coalesce", ref("input.category"), "other"),
              // `status` and `submittedBy` are decided by the DOCUMENT, never by
              // the submitter: a form can only supply the params above.
              status: "pending",
              submittedBy: ref("user.id"),
            },
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
      ],
      returns: ref("steps.rec.id"),
    },
    {
      name: "approveExpense",
      permission: "approveExpense",
      params: [{ name: "id", type: "string", required: true }],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.update",
          args: { model: "Expense", id: ref("input.id"), data: { status: "approved" } },
        },
        {
          kind: "emit",
          event: "expenseApproved",
          payload: {
            expenseId: ref("input.id"),
            amount: ref("steps.rec.amount"),
            description: ref("steps.rec.description"),
          },
        },
      ],
      returns: ref("steps.rec"),
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
      returns: { $obj: { count: fn("len", ref("steps.all")), summary: ref("steps.summary"), items: ref("steps.all") } },
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
        props: { title: "Expenses", subtitle: "Submit an expense; your manager approves it." },
        children: [
          {
            type: "Stack",
            children: [
              // Each Stat carries its own binding, so a metric is a query plus
              // one expression — no aggregate action, no client code.
              {
                type: "Row",
                children: [
                  {
                    type: "Stat",
                    bind: { as: "pending", query: { model: "Expense", where: { status: "pending" } } },
                    props: {
                      label: "Pending total",
                      value: fn("sum", fn("pluck", ref("pending"), "amount")),
                      hint: op("concat", fn("len", ref("pending")), " awaiting approval"),
                    },
                  },
                  {
                    type: "Stat",
                    bind: { as: "approved", query: { model: "Expense", where: { status: "approved" } } },
                    props: {
                      label: "Approved",
                      value: fn("len", ref("approved")),
                      hint: op("concat", "$", fn("sum", fn("pluck", ref("approved"), "amount")), " reimbursed"),
                    },
                  },
                  {
                    type: "Stat",
                    bind: { as: "all", query: { model: "Expense" } },
                    props: { label: "All expenses", value: fn("len", ref("all")), hint: "visible to you" },
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "New expense", subtitle: "Fields become action params; the IR maps them." },
                children: [
                  {
                    type: "Form",
                    props: { submitLabel: "Submit expense" },
                    on: {
                      submit: {
                        action: "submitExpense",
                        args: {
                          amount: ref("form.amount"),
                          description: ref("form.description"),
                          category: ref("form.category"),
                        },
                      },
                    },
                    children: [
                      { type: "Field", props: { name: "amount", label: "Amount", kind: "number", placeholder: "120", required: true } },
                      { type: "Field", props: { name: "description", label: "Description", kind: "text", placeholder: "Team lunch", required: true } },
                      {
                        type: "Field",
                        props: { name: "category", label: "Category", kind: "select", options: ["travel", "meals", "software", "other"] },
                      },
                    ],
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "Expenses" },
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
            ],
          },
        ],
      },
    },
  ],

  permissions: {
    roles: ["owner", "manager", "employee", "finance"],
    default: "deny",
    actions: {
      submitExpense: ["employee", "manager"],
      approveExpense: ["manager"],
      monthlySummary: ["manager", "finance"],
    },
    models: {
      Expense: {
        create: ["employee", "manager"],
        update: ["manager"],
        delete: ["owner"],
        // Row-level rule: managers & finance see everything; employees see
        // only their own submissions. This single expression is the whole
        // policy behind "employees can only see their own expenses".
        read: {
          allow: ["manager", "finance", "employee"],
          where: op(
            "or",
            op("has", ref("user.roles"), "manager"),
            op("has", ref("user.roles"), "finance"),
            op("==", ref("row.submittedBy"), ref("user.id")),
          ),
        },
      },
    },
  },
});

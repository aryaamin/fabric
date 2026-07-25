import { defineApp, ref, op, fn, type AppDocument } from "@fabric/ir";

/**
 * A second app that composes with the first WITHOUT any API, shared database,
 * or code import. It simply subscribes to an event the Expense Tracker emits.
 * This is the "connect like Lego" property made concrete.
 */
export const accounting: AppDocument = defineApp({
  id: "accounting",
  name: "Accounting",
  icon: "📒",
  description: "Keeps a ledger. Auto-records an entry whenever an expense is approved.",

  capabilities: [{ capability: "storage" }],

  models: [
    {
      name: "LedgerEntry",
      fields: [
        { name: "amount", type: "number", required: true },
        { name: "memo", type: "string" },
        { name: "source", type: "string" },
      ],
    },
  ],

  events: [{ name: "entryRecorded", payload: [{ name: "amount", type: "number" }] }],

  actions: [
    {
      name: "recordEntry",
      params: [
        { name: "amount", type: "number", required: true },
        { name: "memo", type: "string" },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: { model: "LedgerEntry", data: { amount: ref("input.amount"), memo: ref("input.memo"), source: "expense-tracker" } },
        },
        { kind: "emit", event: "entryRecorded", payload: { amount: ref("input.amount") } },
      ],
      returns: ref("steps.rec"),
    },
    {
      name: "ledger",
      params: [],
      steps: [{ kind: "call", id: "all", call: "storage.list", args: { model: "LedgerEntry" } }],
      returns: ref("steps.all"),
    },
  ],

  // The connection. "When expense-tracker.expenseApproved, run recordEntry,
  // mapping the event's amount/description onto the action's params."
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
        props: { title: "Ledger", subtitle: "Entries arrive automatically from connected apps." },
        children: [
          {
            type: "Stack",
            children: [
              {
                type: "Stat",
                bind: { as: "entries", query: { model: "LedgerEntry" } },
                props: {
                  label: "Total recorded",
                  value: fn("sum", fn("pluck", ref("entries"), "amount")),
                  hint: op("concat", fn("len", ref("entries")), " entry/entries, all via connections"),
                },
              },
              {
                type: "Card",
                props: { title: "Entries" },
                children: [
                  {
                    type: "Table",
                    bind: { as: "rows", query: { model: "LedgerEntry", sort: [{ field: "createdAt", dir: "desc" }] } },
                    props: { columns: ["amount", "memo", "source"], rows: ref("rows") },
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
    roles: ["owner", "accountant"],
    default: "deny",
    actions: { recordEntry: ["owner"], ledger: ["owner", "accountant"] },
    models: {
      LedgerEntry: { create: ["owner"], read: ["owner", "accountant"] },
    },
  },
});

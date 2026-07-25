import { defineApp, ref, op, fn, type AppDocument } from "@fabric/ir";

/**
 * Leave Requests — the vision doc's HR example, authored as IR.
 *
 * Showcases IR features beyond the Expense Tracker:
 *  - a `let` step (compute a value once, reuse it)
 *  - an `if` step (branching logic: approve vs. reject)
 *  - a `forEach` step (loop over a query result, acting per row)
 */
export const leaveRequests: AppDocument = defineApp({
  id: "leave-requests",
  name: "Leave Requests",
  icon: "🏖",
  description: "Employees request time off; managers approve or reject; everyone is notified.",

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
        { name: "status", type: "enum", enum: ["pending", "approved", "rejected"], default: "pending" },
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
            data: {
              employee: ref("user.id"),
              days: ref("input.days"),
              reason: ref("input.reason"),
              startDate: ref("input.startDate"),
              endDate: ref("input.endDate"),
              status: "pending",
            },
          },
        },
        {
          kind: "call",
          call: "notifications.send",
          args: { to: "manager", title: op("concat", "Leave request: ", ref("input.days"), " day(s)"), body: ref("input.reason") },
        },
        { kind: "emit", event: "leaveRequested", payload: { requestId: ref("steps.rec.id"), days: ref("input.days") } },
      ],
      returns: ref("steps.rec.id"),
    },
    {
      // Demonstrates `let` (compute the new status once) and `if` (branch).
      name: "decide",
      permission: "decide",
      params: [
        { name: "id", type: "string", required: true },
        { name: "approve", type: "boolean", required: true },
      ],
      steps: [
        { kind: "let", id: "status", value: { $if: [ref("input.approve"), "approved", "rejected"] } },
        {
          kind: "call",
          id: "rec",
          call: "storage.update",
          args: { model: "LeaveRequest", id: ref("input.id"), data: { status: ref("let.status") } },
        },
        {
          kind: "if",
          cond: ref("input.approve"),
          then: [
            {
              kind: "call",
              call: "notifications.send",
              args: { to: ref("steps.rec.employee"), title: "Your leave was approved ✅" },
            },
            { kind: "emit", event: "leaveApproved", payload: { requestId: ref("input.id"), employee: ref("steps.rec.employee") } },
          ],
          else: [
            {
              kind: "call",
              call: "notifications.send",
              args: { to: ref("steps.rec.employee"), title: "Your leave was declined ❌" },
            },
          ],
        },
      ],
      returns: ref("steps.rec"),
    },
    {
      // Demonstrates `forEach` over a query result, acting per row.
      name: "remindPending",
      permission: "remindPending",
      params: [],
      steps: [
        { kind: "call", id: "pending", call: "storage.list", args: { model: "LeaveRequest", where: { status: "pending" } } },
        {
          kind: "forEach",
          id: "req",
          in: ref("steps.pending"),
          do: [
            {
              kind: "call",
              call: "notifications.send",
              args: { to: "manager", title: op("concat", "Still pending: ", ref("req.days"), " day(s) for ", ref("req.employee")) },
            },
          ],
        },
      ],
      returns: ref("steps.pending"),
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
        props: { title: "Leave Requests", subtitle: "Request time off; your manager decides." },
        children: [
          {
            type: "Stack",
            children: [
              {
                type: "Row",
                children: [
                  {
                    type: "Stat",
                    bind: { as: "pending", query: { model: "LeaveRequest", where: { status: "pending" } } },
                    props: {
                      label: "Pending",
                      value: fn("len", ref("pending")),
                      hint: op("concat", fn("sum", fn("pluck", ref("pending"), "days")), " day(s) requested"),
                    },
                  },
                  {
                    type: "Stat",
                    bind: { as: "approved", query: { model: "LeaveRequest", where: { status: "approved" } } },
                    props: {
                      label: "Approved days",
                      value: fn("sum", fn("pluck", ref("approved"), "days")),
                      hint: op("concat", fn("len", ref("approved")), " request(s)"),
                    },
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
                      { type: "Field", props: { name: "days", label: "Days", kind: "number", placeholder: "3", required: true } },
                      { type: "Field", props: { name: "startDate", label: "Start date", kind: "date", required: true } },
                      { type: "Field", props: { name: "endDate", label: "End date", kind: "date", required: true } },
                      { type: "Field", props: { name: "reason", label: "Reason", kind: "textarea", placeholder: "Family holiday" } },
                    ],
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "Requests" },
                children: [
                  {
                    type: "Table",
                    bind: { as: "rows", query: { model: "LeaveRequest", sort: [{ field: "createdAt", dir: "desc" }] } },
                    props: {
                      columns: ["employee", "startDate", "endDate", "days", "reason", "status"],
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
    roles: ["owner", "manager", "employee"],
    default: "deny",
    actions: {
      requestLeave: ["employee", "manager"],
      decide: ["manager"],
      remindPending: ["manager"],
    },
    models: {
      LeaveRequest: {
        create: ["employee", "manager"],
        update: ["manager"],
        // Managers see all requests; employees see only their own.
        read: {
          allow: ["manager", "employee"],
          where: op("or", op("has", ref("user.roles"), "manager"), op("==", ref("row.employee"), ref("user.id"))),
        },
      },
    },
  },
});

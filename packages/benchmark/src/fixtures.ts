import { defineApp, ref, op, fn, type AppDocument } from "@fabric/ir";

/**
 * Default benchmark fixtures.
 *
 * WHY the package ships its own apps: `runBenchmark()` must be callable from
 * anywhere (a CLI, the studio, CI) without depending on the examples folder, and
 * the numbers must be comparable between runs. These two documents are sized
 * like real generated apps — a data-entry app with a form and a metrics
 * dashboard with a chart — so the measurements reflect realistic IR, not a toy.
 *
 * Callers who want to measure *their* apps pass `{ apps: [...] }` instead.
 */

const SEED = "benchmarkSeed";

/** A data-entry app: form → action → storage → table, plus two metrics. */
const tasks: AppDocument = defineApp({
  id: "bench-tasks",
  name: "Bench Tasks",
  icon: "✅",
  description: "Data-entry shaped fixture: a form, an action, a table and metrics.",
  capabilities: [{ capability: "storage" }],
  models: [
    {
      name: "Task",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "points", type: "number" },
        { name: "priority", type: "enum", enum: ["low", "medium", "high"], default: "medium" },
        { name: "status", type: "enum", enum: ["open", "done"], default: "open" },
        { name: "createdBy", type: "string" },
      ],
    },
  ],
  events: [
    { name: "taskCreated", payload: [{ name: "taskId", type: "string" }, { name: "title", type: "string" }] },
  ],
  actions: [
    {
      name: "createTask",
      params: [
        { name: "title", type: "string", required: true },
        { name: "points", type: "number" },
        { name: "priority", type: "enum" },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "Task",
            data: {
              title: ref("input.title"),
              points: ref("input.points"),
              priority: fn("coalesce", ref("input.priority"), "medium"),
              status: "open",
              createdBy: ref("user.id"),
            },
          },
        },
        { kind: "emit", event: "taskCreated", payload: { taskId: ref("steps.rec.id"), title: ref("input.title") } },
      ],
      returns: ref("steps.rec.id"),
    },
    {
      name: SEED,
      params: [],
      steps: [
        {
          kind: "forEach",
          id: "row",
          in: [
            { $obj: { title: "Draft the Q3 plan", points: 5, priority: "high" } },
            { $obj: { title: "Review vendor invoices", points: 3, priority: "medium" } },
            { $obj: { title: "Fix onboarding copy", points: 2, priority: "low" } },
            { $obj: { title: "Interview two candidates", points: 8, priority: "high" } },
            { $obj: { title: "Renew the SSL cert", points: 1, priority: "medium" } },
          ],
          do: [
            {
              kind: "call",
              call: "storage.create",
              args: {
                model: "Task",
                data: {
                  title: ref("row.title"),
                  points: ref("row.points"),
                  priority: ref("row.priority"),
                  status: "open",
                  createdBy: "bench",
                },
              },
            },
          ],
        },
      ],
    },
  ],
  subscriptions: [],
  views: [
    {
      name: "board",
      route: "/",
      title: "Tasks",
      root: {
        type: "Page",
        props: { title: "Tasks", subtitle: "Fixture app for the Fabric benchmark." },
        children: [
          {
            type: "Stack",
            children: [
              {
                type: "Row",
                bind: { as: "open", query: { model: "Task", where: { status: "open" } } },
                children: [
                  { type: "Stat", props: { label: "Open", value: fn("len", ref("open")), hint: "status = open" } },
                  {
                    type: "Stat",
                    props: {
                      label: "Points open",
                      value: fn("sum", fn("pluck", ref("open"), "points")),
                      hint: op("concat", fn("len", ref("open")), " task(s)"),
                    },
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "New task" },
                children: [
                  {
                    type: "Form",
                    props: { submitLabel: "Add task" },
                    on: {
                      submit: {
                        action: "createTask",
                        args: { title: ref("form.title"), points: ref("form.points"), priority: ref("form.priority") },
                      },
                    },
                    children: [
                      { type: "Field", props: { name: "title", label: "Title", kind: "text", required: true } },
                      { type: "Field", props: { name: "points", label: "Points", kind: "number" } },
                      { type: "Field", props: { name: "priority", label: "Priority", kind: "select", options: ["low", "medium", "high"] } },
                    ],
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "All tasks" },
                children: [
                  {
                    type: "Table",
                    bind: { as: "rows", query: { model: "Task", sort: [{ field: "createdAt", dir: "desc" }] } },
                    props: {
                      columns: ["title", "priority", "points", "status", "createdBy"],
                      rows: ref("rows"),
                      badgeColumn: "priority",
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
    roles: ["owner", "member"],
    default: "deny",
    actions: { createTask: ["member"], [SEED]: ["member"] },
    models: { Task: { create: ["member"], update: ["member"], read: ["member"] } },
  },
});

/** A dashboard app: stats + a bar chart over a seeded series. */
const metrics: AppDocument = defineApp({
  id: "bench-metrics",
  name: "Bench Metrics",
  icon: "📊",
  description: "Dashboard shaped fixture: stats and a bar chart over a bound query.",
  capabilities: [{ capability: "storage" }],
  models: [
    {
      name: "Point",
      fields: [
        { name: "label", type: "string", required: true },
        { name: "value", type: "number", required: true },
      ],
    },
  ],
  events: [{ name: "pointRecorded", payload: [{ name: "label", type: "string" }, { name: "value", type: "number" }] }],
  actions: [
    {
      name: "recordPoint",
      params: [
        { name: "label", type: "string", required: true },
        { name: "value", type: "number", required: true },
      ],
      steps: [
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: { model: "Point", data: { label: ref("input.label"), value: ref("input.value") } },
        },
        { kind: "emit", event: "pointRecorded", payload: { label: ref("input.label"), value: ref("input.value") } },
      ],
      returns: ref("steps.rec"),
    },
    {
      name: SEED,
      params: [],
      steps: [
        {
          kind: "forEach",
          id: "row",
          in: [
            { $obj: { label: "Mon", value: 120 } },
            { $obj: { label: "Tue", value: 180 } },
            { $obj: { label: "Wed", value: 90 } },
            { $obj: { label: "Thu", value: 240 } },
            { $obj: { label: "Fri", value: 310 } },
            { $obj: { label: "Sat", value: 150 } },
            { $obj: { label: "Sun", value: 70 } },
          ],
          do: [
            {
              kind: "call",
              call: "storage.create",
              args: { model: "Point", data: { label: ref("row.label"), value: ref("row.value") } },
            },
          ],
        },
      ],
    },
  ],
  subscriptions: [],
  views: [
    {
      name: "dashboard",
      route: "/",
      title: "Metrics",
      root: {
        type: "Page",
        props: { title: "Metrics", subtitle: "Fixture dashboard for the Fabric benchmark." },
        children: [
          {
            type: "Stack",
            children: [
              {
                type: "Row",
                bind: { as: "all", query: { model: "Point" } },
                children: [
                  { type: "Stat", props: { label: "Total", value: fn("sum", fn("pluck", ref("all"), "value")), hint: "sum of series" } },
                  { type: "Stat", props: { label: "Points", value: fn("len", ref("all")), hint: "rows" } },
                  {
                    type: "Stat",
                    props: {
                      label: "Average",
                      value: { $if: [fn("len", ref("all")), op("/", fn("sum", fn("pluck", ref("all"), "value")), fn("len", ref("all"))), "—"] },
                      hint: "mean",
                    },
                  },
                ],
              },
              {
                type: "Chart",
                bind: { as: "series", query: { model: "Point", sort: [{ field: "createdAt", dir: "asc" }] } },
                props: { kind: "bar", labelField: "label", valueField: "value", title: "Series" },
              },
              {
                type: "Card",
                props: { title: "Rows" },
                children: [
                  {
                    type: "Table",
                    bind: { as: "rows", query: { model: "Point", sort: [{ field: "createdAt", dir: "asc" }] } },
                    props: { columns: ["label", "value"], rows: ref("rows") },
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
    roles: ["owner", "analyst"],
    default: "deny",
    actions: { recordPoint: ["analyst"], [SEED]: ["analyst"] },
    models: { Point: { create: ["analyst"], read: ["analyst"] } },
  },
});

/** The apps `runBenchmark()` measures when the caller supplies none. */
export function defaultBenchmarkApps(): AppDocument[] {
  return [tasks, metrics];
}

/**
 * Action names the default seeder invokes (as owner) after install, so the
 * render and edit measurements run against an app with data in it. Apps that
 * declare none are simply measured empty.
 */
export const SEED_ACTION_NAMES = [SEED, "seedDemoData"] as const;

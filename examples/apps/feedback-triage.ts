import { defineApp, ref, op, fn, type AppDocument } from "@fabric/ir";

/**
 * Feedback Triage — AI *inside* an application, not just around it.
 *
 * WHY this example exists: on a codegen platform, "AI" is the thing that writes
 * your app and then leaves. Here the model is a declared **capability**, so the
 * app it wrote can keep using it at runtime: one form submission calls
 * `ai.classify` twice to tag sentiment and category, then stores the result like
 * any other field. The app never sees a provider, a model name, or an API key —
 * the runtime resolves `ai` the same way it resolves `storage`.
 *
 * That makes intelligence a *composable* part of the document: "also detect the
 * language" is a new step in this action, not a new service.
 */
export const feedbackTriage: AppDocument = defineApp({
  id: "feedback-triage",
  name: "Feedback Triage",
  icon: "🗂",
  description: "Collects free-text feedback and auto-tags sentiment and category with the AI capability.",

  capabilities: [{ capability: "storage" }, { capability: "ai" }],

  models: [
    {
      name: "Feedback",
      fields: [
        { name: "message", type: "text", required: true },
        { name: "sentiment", type: "enum", enum: ["positive", "neutral", "negative"], default: "neutral" },
        { name: "category", type: "enum", enum: ["bug", "feature", "praise", "question"], default: "question" },
        { name: "submittedBy", type: "string" },
      ],
    },
  ],

  events: [
    {
      name: "feedbackTriaged",
      payload: [
        { name: "feedbackId", type: "string" },
        { name: "sentiment", type: "string" },
        { name: "category", type: "string" },
      ],
    },
  ],

  actions: [
    {
      name: "submitFeedback",
      permission: "submitFeedback",
      params: [{ name: "message", type: "text", required: true }],
      steps: [
        {
          kind: "call",
          id: "sentiment",
          call: "ai.classify",
          args: { text: ref("input.message"), labels: ["positive", "neutral", "negative"] },
        },
        {
          kind: "call",
          id: "category",
          call: "ai.classify",
          args: { text: ref("input.message"), labels: ["bug", "feature", "praise", "question"] },
        },
        {
          kind: "call",
          id: "rec",
          call: "storage.create",
          args: {
            model: "Feedback",
            data: {
              message: ref("input.message"),
              // The tags are produced by the runtime's AI capability, so they
              // cannot be spoofed by whoever fills in the form.
              sentiment: ref("steps.sentiment"),
              category: ref("steps.category"),
              submittedBy: ref("user.id"),
            },
          },
        },
        {
          kind: "emit",
          event: "feedbackTriaged",
          payload: {
            feedbackId: ref("steps.rec.id"),
            sentiment: ref("steps.sentiment"),
            category: ref("steps.category"),
          },
        },
      ],
      returns: ref("steps.rec"),
    },
    {
      name: "summarize",
      permission: "summarize",
      params: [],
      steps: [
        { kind: "call", id: "all", call: "storage.list", args: { model: "Feedback" } },
        {
          kind: "call",
          id: "text",
          call: "ai.complete",
          args: { prompt: op("concat", "Summarize the themes across ", fn("len", ref("steps.all")), " pieces of feedback.") },
        },
      ],
      returns: { $obj: { count: fn("len", ref("steps.all")), summary: ref("steps.text") } },
    },
  ],

  subscriptions: [],

  views: [
    {
      name: "triage",
      route: "/",
      title: "Feedback",
      root: {
        type: "Page",
        props: { title: "Feedback Triage", subtitle: "Type feedback; the app tags it with AI as it saves." },
        children: [
          {
            type: "Stack",
            children: [
              {
                type: "Row",
                children: [
                  {
                    type: "Stat",
                    bind: { as: "all", query: { model: "Feedback" } },
                    props: { label: "Total", value: fn("len", ref("all")), hint: "auto-tagged on submit" },
                  },
                  {
                    type: "Stat",
                    bind: { as: "bugs", query: { model: "Feedback", where: { category: "bug" } } },
                    props: { label: "Bugs", value: fn("len", ref("bugs")), hint: "category = bug" },
                  },
                  {
                    type: "Stat",
                    bind: { as: "neg", query: { model: "Feedback", where: { sentiment: "negative" } } },
                    props: { label: "Negative", value: fn("len", ref("neg")), hint: "sentiment = negative" },
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "Leave feedback", subtitle: "One field in; two AI tags out." },
                children: [
                  {
                    type: "Form",
                    props: { submitLabel: "Send feedback" },
                    on: { submit: { action: "submitFeedback", args: { message: ref("form.message") } } },
                    children: [
                      {
                        type: "Field",
                        props: {
                          name: "message",
                          label: "What's on your mind?",
                          kind: "textarea",
                          placeholder: "The export button is broken on Safari…",
                          required: true,
                        },
                      },
                    ],
                  },
                ],
              },
              {
                type: "Card",
                props: { title: "Triaged feedback" },
                children: [
                  {
                    type: "Table",
                    bind: { as: "rows", query: { model: "Feedback", sort: [{ field: "createdAt", dir: "desc" }] } },
                    props: {
                      columns: ["message", "sentiment", "category", "submittedBy"],
                      rows: ref("rows"),
                      badgeColumn: "sentiment",
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
    roles: ["owner", "member", "support"],
    default: "deny",
    actions: {
      submitFeedback: ["member", "support"],
      summarize: ["support"],
    },
    models: {
      Feedback: {
        create: ["member", "support"],
        read: ["member", "support"],
      },
    },
  },
});

import type {
  Capability,
  CapabilityContext,
  CapabilityFactory,
  CapabilityManifest,
} from "@fabric/capabilities";
import { BaseCapability } from "@fabric/capabilities";

const manifest: CapabilityManifest = {
  name: "notifications",
  version: "0.1.0",
  description: "Send messages to people, across whatever channel the workspace has connected.",
  methods: [
    {
      name: "send",
      permission: "notifications.send",
      mutates: true,
      emits: ["sent"],
      input: {
        to: { type: "string", required: true, description: "user id, role, or channel" },
        title: { type: "string", required: true },
        body: { type: "string" },
      },
      output: { type: "object" },
    },
  ],
  events: [{ name: "sent", payload: { to: { type: "string" }, title: { type: "string" } } }],
};

class NotificationsCapability extends BaseCapability {
  readonly manifest = manifest;
  protected handlers = {
    send: async (a: { to: string; title: string; body?: string }, ctx: CapabilityContext) => {
      // Reference impl logs; a real adapter routes to Slack/email/push.
      ctx.logger.info(`notify ${a.to}: ${a.title}`, a.body);
      await ctx.emit("sent", { to: a.to, title: a.title });
      return { delivered: true, to: a.to };
    },
  };
}

export function notificationsCapabilityFactory(): CapabilityFactory {
  return { manifest, create: () => new NotificationsCapability() as Capability };
}

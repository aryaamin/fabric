import type {
  Capability,
  CapabilityContext,
  CapabilityFactory,
  CapabilityManifest,
} from "@fabric/capabilities";
import { BaseCapability } from "@fabric/capabilities";

export interface NotificationMessage {
  to: string;
  title: string;
  body?: string;
}

export interface NotificationDelivery {
  delivered: boolean;
  to: string;
  provider?: string;
  id?: string;
}

export interface NotificationTransport {
  send(message: NotificationMessage, signal?: AbortSignal): Promise<NotificationDelivery>;
}

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
  private readonly transport?: NotificationTransport;

  constructor(transport?: NotificationTransport) {
    super();
    this.transport = transport;
  }

  protected handlers = {
    send: async (a: NotificationMessage, ctx: CapabilityContext) => {
      const delivery = this.transport
        ? await this.transport.send(a, ctx.signal)
        : { delivered: true, to: a.to, provider: "log" };
      ctx.logger.info(`notify ${a.to}: ${a.title}`, a.body);
      await ctx.emit("sent", { to: a.to, title: a.title, provider: delivery.provider });
      return delivery;
    },
  };
}

export function notificationsCapabilityFactory(transport?: NotificationTransport): CapabilityFactory {
  return { manifest, create: () => new NotificationsCapability(transport) as Capability };
}

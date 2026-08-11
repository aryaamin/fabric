import type {
  NotificationMessage,
  NotificationTransport,
} from "@fabric/runtime";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createSlackWebhookTransport(
  webhookUrl: string,
  request: Fetcher = fetch,
): NotificationTransport {
  const url = new URL(webhookUrl);
  if (
    url.protocol !== "https:" ||
    !["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname)
  ) {
    throw new Error("Slack webhook must use an HTTPS Slack webhook URL");
  }

  return {
    async send(message: NotificationMessage, signal?: AbortSignal) {
      const response = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: slackText(message) }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Slack webhook returned ${response.status}: ${await response.text()}`);
      }
      return { delivered: true, to: message.to, provider: "slack" };
    },
  };
}

function slackText(message: NotificationMessage): string {
  const target = message.to ? `_${escapeSlack(message.to)}_\n` : "";
  const body = message.body ? `\n${escapeSlack(message.body)}` : "";
  return `${target}*${escapeSlack(message.title)}*${body}`;
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

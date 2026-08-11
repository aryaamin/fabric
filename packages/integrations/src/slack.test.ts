import assert from "node:assert/strict";
import test from "node:test";
import { createSlackWebhookTransport } from "./slack.ts";

test("Slack transport sends escaped notification text", async () => {
  let payload: { text: string } | undefined;
  const transport = createSlackWebhookTransport(
    "https://hooks.slack.com/services/team/bot/token",
    async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as { text: string };
      return new Response("ok");
    },
  );

  const delivery = await transport.send({
    to: "#finance",
    title: "Expense <approved>",
    body: "A&B",
  });

  assert.deepEqual(delivery, {
    delivered: true,
    to: "#finance",
    provider: "slack",
  });
  assert.deepEqual(payload, {
    text: "_#finance_\n*Expense &lt;approved&gt;*\nA&amp;B",
  });
});

test("Slack transport rejects non-Slack webhook hosts", () => {
  assert.throws(
    () => createSlackWebhookTransport("https://example.com/services/token"),
    /HTTPS Slack webhook URL/,
  );
});

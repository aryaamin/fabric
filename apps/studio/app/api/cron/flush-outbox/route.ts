import { flushEventOutbox } from "../../../../lib/queue";

export async function GET(request: Request) {
  if (
    !process.env.CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const delivered = await flushEventOutbox();
  console.info("[fabric-outbox] flush complete", { delivered });
  return Response.json({ ok: true, delivered });
}

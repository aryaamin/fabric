import {
  flushCloudBuildOutbox,
  flushCloudDeploymentOutbox,
  flushEventOutbox,
} from "../../../../lib/queue";

export async function GET(request: Request) {
  if (
    !process.env.CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const [events, builds, deployments] = await Promise.all([
    flushEventOutbox(),
    flushCloudBuildOutbox(),
    flushCloudDeploymentOutbox(),
  ]);
  const delivered = events + builds + deployments;
  console.info("[fabric-outbox] flush complete", { delivered });
  return Response.json({ ok: true, delivered, events, builds, deployments });
}

import { currentIdentity, unauthorized } from "../../../../../lib/auth";
import { cloudReadiness } from "../../../../../lib/cloud-readiness";

export async function GET(request: Request) {
  const identity = await currentIdentity();
  if (!identity) return unauthorized();
  try {
    return Response.json({ ok: true, status: cloudReadiness() });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Fabric cloud readiness check failed",
        requestId: request.headers.get("x-vercel-id"),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return Response.json(
      { ok: false, error: "Could not inspect cloud readiness" },
      { status: 500 },
    );
  }
}

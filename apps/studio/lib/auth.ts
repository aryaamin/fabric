import { auth } from "@clerk/nextjs/server";

export interface StudioIdentity {
  id: string;
  workspaceId: string;
  organizationId?: string;
}

export function clerkConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
      process.env.CLERK_SECRET_KEY,
  );
}

/**
 * Clerk is mandatory in production. Local development keeps the original
 * single-owner identity so the zero-setup demos remain runnable offline.
 */
export async function currentIdentity(): Promise<StudioIdentity | null> {
  if (!clerkConfigured()) {
    return process.env.NODE_ENV === "production"
      ? null
      : { id: "u_owner", workspaceId: "ws_acme" };
  }
  const session = await auth();
  if (!session.userId) return null;
  return {
    id: session.userId,
    workspaceId: session.orgId ? `org_${session.orgId}` : `user_${session.userId}`,
    ...(session.orgId ? { organizationId: session.orgId } : {}),
  };
}

export function unauthorized(): Response {
  return Response.json({ ok: false, error: "authentication required" }, { status: 401 });
}

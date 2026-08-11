import { clerkClient } from "@clerk/nextjs/server";
import type { ShareRole, WorkspaceObject } from "@fabric/workspace";
import type { StudioIdentity } from "./auth";
import { clerkConfigured } from "./auth";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";

export async function inviteToWorkspaceObject(input: {
  identity: StudioIdentity;
  object: WorkspaceObject;
  email: string;
  documentRole: Extract<ShareRole, "editor" | "viewer">;
  appRoles: string[];
  redirectUrl: string;
}): Promise<void> {
  if (!hasDurableDatabase()) {
    throw new Error("Email invitations require durable storage");
  }
  if (!clerkConfigured() || !input.identity.organizationId) {
    throw new Error("Email invitations currently require a Clerk organization workspace");
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address");
  }

  const id = `invite_${crypto.randomUUID()}`;
  const sql = getDatabaseExecutor();
  await sql(
    `INSERT INTO workspace_invitations
      (id, workspace_id, object_id, email, document_role, app_roles, invited_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (workspace_id, object_id, email)
     DO UPDATE SET document_role = EXCLUDED.document_role,
                   app_roles = EXCLUDED.app_roles,
                   invited_by = EXCLUDED.invited_by,
                   accepted_by = NULL,
                   accepted_at = NULL`,
    [
      id,
      input.identity.workspaceId,
      input.object.id,
      email,
      input.documentRole,
      JSON.stringify(input.appRoles),
      input.identity.id,
    ],
  );

  const client = await clerkClient();
  const invitation = await client.organizations.createOrganizationInvitation({
    organizationId: input.identity.organizationId,
    emailAddress: email,
    role: "org:member",
    inviterUserId: input.identity.id,
    redirectUrl: input.redirectUrl,
    publicMetadata: {
      fabricWorkspaceId: input.identity.workspaceId,
      fabricObjectId: input.object.id,
    },
  });
  await sql(
    `UPDATE workspace_invitations
     SET clerk_invitation_id = $2
     WHERE workspace_id = $1 AND object_id = $3 AND email = $4`,
    [input.identity.workspaceId, invitation.id, input.object.id, email],
  );
}

export async function claimWorkspaceInvitations(
  workspaceId: string,
  userId: string,
): Promise<number> {
  if (!hasDurableDatabase() || !clerkConfigured()) return 0;
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const emails = user.emailAddresses.map((address) => address.emailAddress.toLowerCase());
  if (emails.length === 0) return 0;

  const sql = getDatabaseExecutor();
  const invitations = await sql<{
    id: string;
    object_id: string;
    document_role: "editor" | "viewer";
    app_roles: string[] | string;
    app_id: string | null;
  }>(
    `SELECT i.id, i.object_id, i.document_role, i.app_roles, o.app_id
     FROM workspace_invitations i
     JOIN workspace_objects o ON o.id = i.object_id
     WHERE i.workspace_id = $1
       AND i.accepted_at IS NULL
       AND lower(i.email) = ANY($2::text[])`,
    [workspaceId, emails],
  );

  for (const invitation of invitations) {
    await sql(
      `INSERT INTO workspace_grants (object_id, principal_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (object_id, principal_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [invitation.object_id, userId, invitation.document_role],
    );
    const roles =
      typeof invitation.app_roles === "string"
        ? (JSON.parse(invitation.app_roles) as string[])
        : invitation.app_roles;
    if (invitation.app_id) {
      for (const role of roles) {
        await sql(
          `INSERT INTO app_role_grants (workspace_id, app_id, principal_id, role)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, app_id, principal_id, role) DO NOTHING`,
          [workspaceId, invitation.app_id, userId, role],
        );
      }
    }
    await sql(
      `UPDATE workspace_invitations
       SET accepted_by = $2, accepted_at = NOW()
       WHERE id = $1`,
      [invitation.id, userId],
    );
  }
  return invitations.length;
}

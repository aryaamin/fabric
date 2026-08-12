import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StudioIdentity } from "./auth";
import { getDatabaseExecutor, hasDurableDatabase } from "./database";

export type AgentScope =
  | "project:read"
  | "files:write"
  | "snapshot:write"
  | "build:create"
  | "deployment:create"
  | "logs:read";

export const ALL_AGENT_SCOPES: AgentScope[] = [
  "project:read",
  "files:write",
  "snapshot:write",
  "build:create",
  "deployment:create",
  "logs:read",
];

export interface AgentCredential {
  id: string;
  workspaceId: string;
  projectId: string;
  principalId: string;
  scopes: AgentScope[];
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export interface IssuedAgentCredential extends AgentCredential {
  /** Returned exactly once. Fabric persists only its SHA-256 digest. */
  token: string;
}

interface StoredCredential extends AgentCredential {
  tokenHash: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __fabricAgentCredentials: Map<string, StoredCredential> | undefined;
}

export async function issueAgentCredential(input: {
  identity: StudioIdentity;
  projectId: string;
  scopes: AgentScope[];
  expiresAt?: string;
}): Promise<IssuedAgentCredential> {
  const scopes = normalizeScopes(input.scopes);
  const id = `cred_${randomUUID()}`;
  const token = `fab_pat_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashToken(token);
  const createdAt = new Date().toISOString();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : undefined;
  if (expiresAt && expiresAt <= createdAt) throw new Error("credential expiry must be in the future");
  const credential: StoredCredential = {
    id,
    workspaceId: input.identity.workspaceId,
    projectId: input.projectId,
    principalId: input.identity.id,
    scopes,
    tokenHash,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
  };
  if (hasDurableDatabase()) {
    await getDatabaseExecutor()(
      `INSERT INTO project_credentials
        (workspace_id, id, project_id, principal_id, token_hash, scopes, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        credential.workspaceId,
        credential.id,
        credential.projectId,
        credential.principalId,
        credential.tokenHash,
        JSON.stringify(credential.scopes),
        credential.expiresAt ?? null,
        credential.createdAt,
      ],
    );
  } else {
    globalThis.__fabricAgentCredentials ??= new Map();
    globalThis.__fabricAgentCredentials.set(tokenHash, credential);
  }
  const { tokenHash: _, ...publicCredential } = credential;
  return { ...publicCredential, token };
}

export async function authenticateAgentToken(request: Request): Promise<AgentCredential | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token.startsWith("fab_pat_")) return null;
  const tokenHash = hashToken(token);
  const credential = hasDurableDatabase()
    ? await loadDurableCredential(tokenHash)
    : globalThis.__fabricAgentCredentials?.get(tokenHash);
  if (!credential || credential.revokedAt) return null;
  if (credential.expiresAt && credential.expiresAt <= new Date().toISOString()) return null;
  const { tokenHash: _, ...authenticated } = credential;
  return authenticated;
}

export async function revokeAgentCredential(
  workspaceId: string,
  projectId: string,
  credentialId: string,
): Promise<void> {
  if (hasDurableDatabase()) {
    await getDatabaseExecutor()(
      `UPDATE project_credentials
       SET revoked_at = NOW()
       WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
      [workspaceId, projectId, credentialId],
    );
    return;
  }
  for (const credential of globalThis.__fabricAgentCredentials?.values() ?? []) {
    if (
      credential.workspaceId === workspaceId &&
      credential.projectId === projectId &&
      credential.id === credentialId
    ) {
      credential.revokedAt = new Date().toISOString();
    }
  }
}

export function requireAgentScope(
  credential: AgentCredential | null,
  projectId: string,
  scope: AgentScope,
): void {
  if (!credential || credential.projectId !== projectId || !credential.scopes.includes(scope)) {
    throw new Error(`agent credential requires ${scope} for project ${projectId}`);
  }
}

async function loadDurableCredential(tokenHash: string): Promise<StoredCredential | undefined> {
  const rows = await getDatabaseExecutor()<{
    id: string;
    workspace_id: string;
    project_id: string;
    principal_id: string;
    token_hash: string;
    scopes: AgentScope[] | string;
    expires_at: string | Date | null;
    revoked_at: string | Date | null;
    created_at: string | Date;
  }>(
    `SELECT id, workspace_id, project_id, principal_id, token_hash, scopes,
            expires_at, revoked_at, created_at
     FROM project_credentials
     WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    principalId: row.principal_id,
    tokenHash: row.token_hash,
    scopes: typeof row.scopes === "string" ? (JSON.parse(row.scopes) as AgentScope[]) : row.scopes,
    createdAt: iso(row.created_at),
    ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function normalizeScopes(scopes: AgentScope[]): AgentScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error("at least one scope is required");
  const allowed = new Set(ALL_AGENT_SCOPES);
  for (const scope of scopes) if (!allowed.has(scope)) throw new Error(`invalid agent scope ${scope}`);
  return [...new Set(scopes)].sort();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

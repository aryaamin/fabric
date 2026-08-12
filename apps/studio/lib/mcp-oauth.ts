import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { StudioIdentity } from "./auth.ts";
import { getDatabaseExecutor, hasDurableDatabase } from "./database.ts";

export const MCP_OAUTH_SCOPE = "fabric:projects";
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export interface McpOAuthCredential {
  id: string;
  workspaceId: string;
  principalId: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
}

export interface McpOAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

export interface McpAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state?: string;
}

interface AuthorizationCode extends McpAuthorizationRequest {
  codeHash: string;
  principalId: string;
  workspaceId: string;
  expiresAt: string;
  createdAt: string;
}

interface StoredToken extends McpOAuthCredential {
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  resource: string;
  refreshExpiresAt: string;
  revokedAt?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __fabricMcpOAuthClients: Map<string, McpOAuthClient> | undefined;
  // eslint-disable-next-line no-var
  var __fabricMcpOAuthCodes: Map<string, AuthorizationCode> | undefined;
  // eslint-disable-next-line no-var
  var __fabricMcpOAuthTokens: Map<string, StoredToken> | undefined;
}

export class McpOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function registerMcpOAuthClient(input: {
  name?: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
}): Promise<McpOAuthClient> {
  const redirectUris = [...new Set(input.redirectUris.map(requireRedirectUri))];
  if (redirectUris.length === 0) {
    throw new McpOAuthError("invalid_redirect_uri", "At least one redirect URI is required");
  }
  if (
    input.grantTypes &&
    input.grantTypes.some((value) => !["authorization_code", "refresh_token"].includes(value))
  ) {
    throw new McpOAuthError("invalid_client_metadata", "Unsupported OAuth grant type");
  }
  if (input.responseTypes?.some((value) => value !== "code")) {
    throw new McpOAuthError("invalid_client_metadata", "Only the code response type is supported");
  }
  if (input.tokenEndpointAuthMethod && input.tokenEndpointAuthMethod !== "none") {
    throw new McpOAuthError(
      "invalid_client_metadata",
      "Fabric supports public PKCE clients without a client secret",
    );
  }
  const client: McpOAuthClient = {
    id: `fab_client_${randomBytes(18).toString("base64url")}`,
    name: requireClientName(input.name),
    redirectUris,
    createdAt: new Date().toISOString(),
  };
  if (hasDurableDatabase()) {
    await getDatabaseExecutor()(
      `INSERT INTO mcp_oauth_clients (id, name, redirect_uris, created_at)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [client.id, client.name, JSON.stringify(client.redirectUris), client.createdAt],
    );
  } else {
    globalThis.__fabricMcpOAuthClients ??= new Map();
    globalThis.__fabricMcpOAuthClients.set(client.id, client);
  }
  return client;
}

export async function validateMcpAuthorizationRequest(
  values: URLSearchParams | FormData,
  expectedResource: string,
): Promise<McpAuthorizationRequest> {
  if (stringValue(values, "response_type") !== "code") {
    throw new McpOAuthError("unsupported_response_type", "response_type must be code");
  }
  const clientId = requiredValue(values, "client_id");
  const client = await loadClient(clientId);
  if (!client) throw new McpOAuthError("invalid_client", "Unknown OAuth client", 401);
  const redirectUri = requiredValue(values, "redirect_uri");
  if (!client.redirectUris.includes(redirectUri)) {
    throw new McpOAuthError("invalid_redirect_uri", "redirect_uri is not registered");
  }
  if (stringValue(values, "code_challenge_method") !== "S256") {
    throw new McpOAuthError("invalid_request", "PKCE code_challenge_method must be S256");
  }
  const codeChallenge = requiredValue(values, "code_challenge");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new McpOAuthError("invalid_request", "Invalid PKCE code challenge");
  }
  const resource = requiredValue(values, "resource");
  if (resource !== expectedResource) {
    throw new McpOAuthError("invalid_target", "OAuth resource does not match Fabric MCP");
  }
  const requestedScopes = (stringValue(values, "scope") ?? MCP_OAUTH_SCOPE)
    .split(/\s+/)
    .filter(Boolean);
  if (!requestedScopes.includes(MCP_OAUTH_SCOPE)) {
    throw new McpOAuthError("invalid_scope", `Required scope: ${MCP_OAUTH_SCOPE}`);
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    scope: MCP_OAUTH_SCOPE,
    ...(stringValue(values, "state") ? { state: stringValue(values, "state") } : {}),
  };
}

export async function issueMcpAuthorizationCode(
  identity: StudioIdentity,
  request: McpAuthorizationRequest,
): Promise<string> {
  const code = `fab_code_${randomBytes(32).toString("base64url")}`;
  const record: AuthorizationCode = {
    ...request,
    codeHash: hash(code),
    principalId: identity.id,
    workspaceId: identity.workspaceId,
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };
  if (hasDurableDatabase()) {
    const sql = getDatabaseExecutor();
    await sql(
      `INSERT INTO workspaces (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [
        identity.workspaceId,
        identity.workspaceId.startsWith("org_") ? "Team Workspace" : "My Workspace",
      ],
    );
    await sql(
      `INSERT INTO mcp_oauth_codes
        (code_hash, client_id, principal_id, workspace_id, redirect_uri,
         code_challenge, scope, resource, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.codeHash,
        record.clientId,
        record.principalId,
        record.workspaceId,
        record.redirectUri,
        record.codeChallenge,
        record.scope,
        record.resource,
        record.expiresAt,
        record.createdAt,
      ],
    );
  } else {
    globalThis.__fabricMcpOAuthCodes ??= new Map();
    globalThis.__fabricMcpOAuthCodes.set(record.codeHash, record);
  }
  return code;
}

export async function exchangeMcpAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}) {
  const codeHash = hash(input.code);
  const record = await loadAuthorizationCode(codeHash);
  if (!record || record.expiresAt <= new Date().toISOString()) {
    throw new McpOAuthError("invalid_grant", "Authorization code is invalid or expired");
  }
  if (
    record.clientId !== input.clientId ||
    record.redirectUri !== input.redirectUri ||
    record.resource !== input.resource
  ) {
    throw new McpOAuthError("invalid_grant", "Authorization code binding does not match");
  }
  if (!verifyCodeChallenge(input.codeVerifier, record.codeChallenge)) {
    throw new McpOAuthError("invalid_grant", "PKCE verification failed");
  }
  if (!(await consumeAuthorizationCode(codeHash))) {
    throw new McpOAuthError("invalid_grant", "Authorization code was already used");
  }
  return issueTokens({
    clientId: record.clientId,
    principalId: record.principalId,
    workspaceId: record.workspaceId,
    scope: record.scope,
    resource: record.resource,
  });
}

export async function refreshMcpOAuthToken(input: {
  refreshToken: string;
  clientId: string;
  resource: string;
}) {
  const token = await loadTokenByRefreshHash(hash(input.refreshToken));
  if (
    !token ||
    token.revokedAt ||
    token.refreshExpiresAt <= new Date().toISOString() ||
    token.clientId !== input.clientId ||
    token.resource !== input.resource
  ) {
    throw new McpOAuthError("invalid_grant", "Refresh token is invalid or expired");
  }
  return rotateTokens(token);
}

export async function authenticateMcpOAuthToken(
  request: Request,
): Promise<McpOAuthCredential | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token.startsWith("fab_oauth_")) return null;
  const stored = await loadTokenByAccessHash(hash(token));
  if (
    !stored ||
    stored.revokedAt ||
    stored.expiresAt <= new Date().toISOString() ||
    stored.scope !== MCP_OAUTH_SCOPE
  ) {
    return null;
  }
  return {
    id: stored.id,
    workspaceId: stored.workspaceId,
    principalId: stored.principalId,
    scope: stored.scope,
    expiresAt: stored.expiresAt,
    createdAt: stored.createdAt,
  };
}

async function issueTokens(input: {
  clientId: string;
  principalId: string;
  workspaceId: string;
  scope: string;
  resource: string;
}) {
  const accessToken = `fab_oauth_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `fab_refresh_${randomBytes(40).toString("base64url")}`;
  const now = new Date();
  const stored: StoredToken = {
    id: `oauth_${randomUUID()}`,
    ...input,
    accessTokenHash: hash(accessToken),
    refreshTokenHash: hash(refreshToken),
    expiresAt: new Date(now.getTime() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1_000).toISOString(),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
    createdAt: now.toISOString(),
  };
  if (hasDurableDatabase()) {
    await getDatabaseExecutor()(
      `INSERT INTO mcp_oauth_tokens
        (id, client_id, principal_id, workspace_id, access_token_hash,
         refresh_token_hash, scope, resource, access_expires_at,
         refresh_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        stored.id,
        stored.clientId,
        stored.principalId,
        stored.workspaceId,
        stored.accessTokenHash,
        stored.refreshTokenHash,
        stored.scope,
        stored.resource,
        stored.expiresAt,
        stored.refreshExpiresAt,
        stored.createdAt,
      ],
    );
  } else {
    globalThis.__fabricMcpOAuthTokens ??= new Map();
    globalThis.__fabricMcpOAuthTokens.set(stored.accessTokenHash, stored);
  }
  return tokenResponse(accessToken, refreshToken, stored.scope);
}

async function rotateTokens(stored: StoredToken) {
  const accessToken = `fab_oauth_${randomBytes(32).toString("base64url")}`;
  const refreshToken = `fab_refresh_${randomBytes(40).toString("base64url")}`;
  const now = new Date();
  const next: StoredToken = {
    ...stored,
    accessTokenHash: hash(accessToken),
    refreshTokenHash: hash(refreshToken),
    expiresAt: new Date(now.getTime() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1_000).toISOString(),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
  };
  if (hasDurableDatabase()) {
    const rows = await getDatabaseExecutor()<{ id: string }>(
      `UPDATE mcp_oauth_tokens
       SET access_token_hash = $2, refresh_token_hash = $3,
           access_expires_at = $4, refresh_expires_at = $5, updated_at = NOW()
       WHERE id = $1 AND refresh_token_hash = $6 AND revoked_at IS NULL
       RETURNING id`,
      [
        stored.id,
        next.accessTokenHash,
        next.refreshTokenHash,
        next.expiresAt,
        next.refreshExpiresAt,
        stored.refreshTokenHash,
      ],
    );
    if (!rows[0]) throw new McpOAuthError("invalid_grant", "Refresh token was already used");
  } else {
    globalThis.__fabricMcpOAuthTokens ??= new Map();
    if (!globalThis.__fabricMcpOAuthTokens.delete(stored.accessTokenHash)) {
      throw new McpOAuthError("invalid_grant", "Refresh token was already used");
    }
    globalThis.__fabricMcpOAuthTokens.set(next.accessTokenHash, next);
  }
  return tokenResponse(accessToken, refreshToken, next.scope);
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

async function loadClient(id: string): Promise<McpOAuthClient | null> {
  if (!hasDurableDatabase()) return globalThis.__fabricMcpOAuthClients?.get(id) ?? null;
  const rows = await getDatabaseExecutor()<{
    id: string;
    name: string;
    redirect_uris: string[] | string;
    created_at: string | Date;
  }>(
    "SELECT id, name, redirect_uris, created_at FROM mcp_oauth_clients WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    redirectUris:
      typeof row.redirect_uris === "string"
        ? (JSON.parse(row.redirect_uris) as string[])
        : row.redirect_uris,
    createdAt: iso(row.created_at),
  };
}

async function loadAuthorizationCode(codeHash: string): Promise<AuthorizationCode | null> {
  if (!hasDurableDatabase()) return globalThis.__fabricMcpOAuthCodes?.get(codeHash) ?? null;
  const rows = await getDatabaseExecutor()<{
    code_hash: string;
    client_id: string;
    principal_id: string;
    workspace_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope: string;
    resource: string;
    expires_at: string | Date;
    created_at: string | Date;
  }>(
    `SELECT code_hash, client_id, principal_id, workspace_id, redirect_uri,
            code_challenge, scope, resource, expires_at, created_at
     FROM mcp_oauth_codes
     WHERE code_hash = $1 AND used_at IS NULL`,
    [codeHash],
  );
  const row = rows[0];
  return row
    ? {
        codeHash: row.code_hash,
        clientId: row.client_id,
        principalId: row.principal_id,
        workspaceId: row.workspace_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        expiresAt: iso(row.expires_at),
        createdAt: iso(row.created_at),
      }
    : null;
}

async function consumeAuthorizationCode(codeHash: string): Promise<boolean> {
  if (!hasDurableDatabase()) {
    return globalThis.__fabricMcpOAuthCodes?.delete(codeHash) ?? false;
  }
  const rows = await getDatabaseExecutor()<{ code_hash: string }>(
    `UPDATE mcp_oauth_codes
     SET used_at = NOW()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     RETURNING code_hash`,
    [codeHash],
  );
  return Boolean(rows[0]);
}

async function loadTokenByAccessHash(value: string): Promise<StoredToken | null> {
  if (!hasDurableDatabase()) return globalThis.__fabricMcpOAuthTokens?.get(value) ?? null;
  return loadDurableToken("access_token_hash", value);
}

async function loadTokenByRefreshHash(value: string): Promise<StoredToken | null> {
  if (!hasDurableDatabase()) {
    return (
      [...(globalThis.__fabricMcpOAuthTokens?.values() ?? [])].find(
        (token) => token.refreshTokenHash === value,
      ) ?? null
    );
  }
  return loadDurableToken("refresh_token_hash", value);
}

async function loadDurableToken(
  column: "access_token_hash" | "refresh_token_hash",
  value: string,
): Promise<StoredToken | null> {
  const rows = await getDatabaseExecutor()<{
    id: string;
    client_id: string;
    principal_id: string;
    workspace_id: string;
    access_token_hash: string;
    refresh_token_hash: string;
    scope: string;
    resource: string;
    access_expires_at: string | Date;
    refresh_expires_at: string | Date;
    revoked_at: string | Date | null;
    created_at: string | Date;
  }>(
    `SELECT id, client_id, principal_id, workspace_id, access_token_hash,
            refresh_token_hash, scope, resource, access_expires_at,
            refresh_expires_at, revoked_at, created_at
     FROM mcp_oauth_tokens
     WHERE ${column} = $1`,
    [value],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        principalId: row.principal_id,
        workspaceId: row.workspace_id,
        accessTokenHash: row.access_token_hash,
        refreshTokenHash: row.refresh_token_hash,
        scope: row.scope,
        resource: row.resource,
        expiresAt: iso(row.access_expires_at),
        refreshExpiresAt: iso(row.refresh_expires_at),
        createdAt: iso(row.created_at),
        ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
      }
    : null;
}

function requireRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError("invalid_redirect_uri", "Redirect URI must be an absolute URL");
  }
  const chatGpt =
    url.protocol === "https:" &&
    url.hostname === "chatgpt.com" &&
    (url.pathname.startsWith("/connector/oauth/") ||
      url.pathname === "/connector_platform_oauth_redirect");
  const local =
    process.env.NODE_ENV !== "production" &&
    ["http:", "https:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!chatGpt && !local) {
    throw new McpOAuthError(
      "invalid_redirect_uri",
      "Fabric currently accepts ChatGPT connector callback URLs",
    );
  }
  if (url.hash) throw new McpOAuthError("invalid_redirect_uri", "Redirect URI cannot contain a hash");
  return url.toString();
}

function requireClientName(value?: string): string {
  const name = (value ?? "ChatGPT").trim().slice(0, 100);
  return name || "ChatGPT";
}

function verifyCodeChallenge(verifier: string, expected: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredValue(values: URLSearchParams | FormData, key: string): string {
  const value = stringValue(values, key);
  if (!value) throw new McpOAuthError("invalid_request", `${key} is required`);
  return value;
}

function stringValue(values: URLSearchParams | FormData, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

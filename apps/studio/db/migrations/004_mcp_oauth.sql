BEGIN;

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_codes_expiry_idx
  ON mcp_oauth_codes(expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text NOT NULL UNIQUE,
  scope text NOT NULL,
  resource text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_access_expiry_idx
  ON mcp_oauth_tokens(access_expires_at)
  WHERE revoked_at IS NULL;

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_objects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('app', 'document', 'folder')),
  name text NOT NULL,
  slug text NOT NULL,
  app_id text,
  parent_id text REFERENCES workspace_objects(id) ON DELETE SET NULL,
  icon text,
  link_role text CHECK (link_role IN ('owner', 'editor', 'viewer')),
  share_token text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS workspace_grants (
  object_id text NOT NULL REFERENCES workspace_objects(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (object_id, principal_id)
);

CREATE TABLE IF NOT EXISTS app_role_grants (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (workspace_id, app_id, principal_id, role)
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_id text NOT NULL REFERENCES workspace_objects(id) ON DELETE CASCADE,
  email text NOT NULL,
  document_role text NOT NULL CHECK (document_role IN ('editor', 'viewer')),
  app_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  clerk_invitation_id text,
  invited_by text NOT NULL,
  accepted_by text,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, object_id, email)
);

CREATE TABLE IF NOT EXISTS app_versions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  app_id text NOT NULL,
  parent_id text,
  author text NOT NULL,
  message text NOT NULL,
  doc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id)
    REFERENCES app_versions(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS app_versions_app_created_idx
  ON app_versions(workspace_id, app_id, created_at);

CREATE TABLE IF NOT EXISTS app_installations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  instance_id text NOT NULL,
  head_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, app_id),
  FOREIGN KEY (workspace_id, head_version_id)
    REFERENCES app_versions(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS app_records (
  namespace text NOT NULL,
  collection text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, collection, id)
);

CREATE INDEX IF NOT EXISTS app_records_collection_idx
  ON app_records(namespace, collection);

CREATE TABLE IF NOT EXISTS fabric_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL,
  causation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fabric_events_workspace_created_idx
  ON fabric_events(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_outbox (
  event_id text PRIMARY KEY REFERENCES fabric_events(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_outbox_pending_idx
  ON event_outbox(created_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS connection_routes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_app_id text NOT NULL,
  pattern text NOT NULL,
  action text NOT NULL,
  input_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  head_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, target_app_id, pattern, action)
);

CREATE INDEX IF NOT EXISTS connection_routes_match_idx
  ON connection_routes(workspace_id, pattern);

CREATE TABLE IF NOT EXISTS processed_deliveries (
  idempotency_key text PRIMARY KEY,
  event_id text NOT NULL,
  target_app_id text NOT NULL,
  action text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

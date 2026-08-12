BEGIN;

CREATE TABLE IF NOT EXISTS cloud_projects (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('source', 'fabric_ir')),
  head_snapshot_id text,
  active_deployment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS project_services (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('web', 'worker', 'cron')),
  root text NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('auto', 'nodejs', 'python', 'go')),
  build_command jsonb,
  start_command jsonb,
  health_check_path text,
  PRIMARY KEY (workspace_id, project_id, name),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_working_files (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  path text NOT NULL,
  content text NOT NULL,
  encoding text NOT NULL CHECK (encoding IN ('utf8', 'base64')),
  executable boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, path),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_snapshots (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  tree_digest text NOT NULL,
  parent_id text,
  files jsonb NOT NULL,
  author text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, parent_id)
    REFERENCES project_snapshots(workspace_id, project_id, id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS project_snapshots_project_created_idx
  ON project_snapshots(workspace_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS builds (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  snapshot_id text NOT NULL,
  service text NOT NULL,
  plan jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  idempotency_key text NOT NULL,
  next_event_sequence integer NOT NULL DEFAULT 1,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, idempotency_key),
  FOREIGN KEY (workspace_id, project_id, snapshot_id)
    REFERENCES project_snapshots(workspace_id, project_id, id)
);

CREATE INDEX IF NOT EXISTS builds_project_created_idx
  ON builds(workspace_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS builds_pending_idx
  ON builds(created_at)
  WHERE state IN ('QUEUED', 'RUNNING');

CREATE TABLE IF NOT EXISTS cloud_dispatch_outbox (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN ('build', 'deployment')),
  operation_id text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_type, operation_id)
);

CREATE INDEX IF NOT EXISTS cloud_dispatch_outbox_pending_idx
  ON cloud_dispatch_outbox(created_at)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS build_events (
  workspace_id text NOT NULL,
  build_id text NOT NULL,
  sequence integer NOT NULL,
  stream text NOT NULL CHECK (stream IN ('system', 'stdout', 'stderr')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, build_id, sequence),
  FOREIGN KEY (workspace_id, build_id)
    REFERENCES builds(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployments (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  snapshot_id text NOT NULL,
  build_id text,
  service text NOT NULL,
  provider text NOT NULL,
  provider_deployment_id text,
  state text NOT NULL CHECK (state IN ('QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELLED')),
  idempotency_key text NOT NULL,
  immutable_url text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, idempotency_key),
  FOREIGN KEY (workspace_id, project_id, snapshot_id)
    REFERENCES project_snapshots(workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, build_id)
    REFERENCES builds(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS deployments_project_created_idx
  ON deployments(workspace_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS deployments_pending_idx
  ON deployments(created_at)
  WHERE state IN ('QUEUED', 'BUILDING');

CREATE TABLE IF NOT EXISTS project_routes (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  service text NOT NULL,
  hostname text NOT NULL,
  path_prefix text NOT NULL DEFAULT '/',
  deployment_id text,
  stable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (hostname, path_prefix),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, deployment_id)
    REFERENCES deployments(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS resource_specs (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('relational_database', 'object_storage', 'key_value', 'durable_queue', 'secret')
  ),
  plan text,
  region text,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, name),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resource_bindings (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  resource_id text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'error', 'revoked')),
  environment jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_references jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, resource_id)
    REFERENCES resource_specs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_credentials (
  workspace_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  principal_id text NOT NULL,
  token_hash text NOT NULL,
  scopes jsonb NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_secret_refs (
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  name text NOT NULL,
  provider text NOT NULL,
  secret_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, name),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE workspace_objects
  ADD COLUMN IF NOT EXISTS project_id text;

ALTER TABLE workspace_objects
  DROP CONSTRAINT IF EXISTS workspace_objects_kind_check;

ALTER TABLE workspace_objects
  ADD CONSTRAINT workspace_objects_kind_check
  CHECK (kind IN ('app', 'project', 'document', 'folder'));

CREATE INDEX IF NOT EXISTS workspace_objects_project_idx
  ON workspace_objects(workspace_id, project_id)
  WHERE project_id IS NOT NULL;

COMMIT;

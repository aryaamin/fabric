BEGIN;

CREATE TABLE IF NOT EXISTS workspace_cloud_policies (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  suspended_at timestamptz,
  suspended_by text,
  suspension_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_cloud_policies (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  suspended_at timestamptz,
  suspended_by text,
  suspension_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text,
  kind text NOT NULL CHECK (
    kind IN (
      'snapshot_bytes',
      'build_requested',
      'deployment_requested',
      'runtime_request'
    )
  ),
  units bigint NOT NULL CHECK (units >= 0),
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, idempotency_key)
);

CREATE INDEX IF NOT EXISTS usage_events_workspace_kind_created_idx
  ON usage_events(workspace_id, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_project_created_idx
  ON usage_events(workspace_id, project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS runtime_leases (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_leases_project_expiry_idx
  ON runtime_leases(workspace_id, project_id, expires_at);

COMMIT;

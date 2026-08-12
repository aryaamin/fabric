BEGIN;

CREATE TABLE IF NOT EXISTS schema_migration_reviews (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  plan_id text NOT NULL,
  from_version text NOT NULL,
  to_version text NOT NULL,
  classification text NOT NULL CHECK (
    classification IN ('safe', 'backfill_required', 'destructive')
  ),
  plan jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('approved', 'sealed')),
  approved_by text NOT NULL,
  approval_reason text,
  approved_at timestamptz NOT NULL DEFAULT now(),
  sealed_snapshot_id text,
  sealed_at timestamptz,
  PRIMARY KEY (workspace_id, project_id, plan_id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS schema_migration_reviews_project_idx
  ON schema_migration_reviews(workspace_id, project_id, approved_at DESC);

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS schema_record_backups (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  id text NOT NULL,
  plan_id text NOT NULL,
  namespace text NOT NULL,
  schema jsonb NOT NULL,
  records jsonb NOT NULL,
  checksum text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_migration_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  id text NOT NULL,
  plan_id text NOT NULL,
  target_snapshot_id text NOT NULL,
  plan jsonb NOT NULL,
  desired_schema jsonb NOT NULL,
  state text NOT NULL CHECK (
    state IN (
      'backing_up',
      'applying',
      'validating',
      'succeeded',
      'failed',
      'rolled_back'
    )
  ),
  backup_id text,
  changed_records integer NOT NULL DEFAULT 0,
  deleted_records integer NOT NULL DEFAULT 0,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  initiated_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rolled_back_by text,
  rolled_back_at timestamptz,
  PRIMARY KEY (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES cloud_projects(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS schema_migration_runs_plan_target_idx
  ON schema_migration_runs(workspace_id, project_id, plan_id, target_snapshot_id);

CREATE INDEX IF NOT EXISTS schema_migration_runs_project_started_idx
  ON schema_migration_runs(workspace_id, project_id, started_at DESC);

COMMIT;

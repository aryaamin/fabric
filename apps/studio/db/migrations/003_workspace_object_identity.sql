BEGIN;

WITH ranked_apps AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, app_id
      ORDER BY
        CASE WHEN slug = app_id THEN 0 ELSE 1 END,
        created_at,
        id
    ) AS position
  FROM workspace_objects
  WHERE app_id IS NOT NULL
)
DELETE FROM workspace_objects
WHERE id IN (SELECT id FROM ranked_apps WHERE position > 1);

WITH ranked_projects AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY workspace_id, project_id
      ORDER BY created_at, id
    ) AS position
  FROM workspace_objects
  WHERE project_id IS NOT NULL
)
DELETE FROM workspace_objects
WHERE id IN (SELECT id FROM ranked_projects WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_objects_workspace_app_idx
  ON workspace_objects(workspace_id, app_id)
  WHERE app_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_objects_workspace_project_idx
  ON workspace_objects(workspace_id, project_id)
  WHERE project_id IS NOT NULL;

COMMIT;

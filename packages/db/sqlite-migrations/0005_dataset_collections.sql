-- Mutable authoring collections. Immutable revisions and governed truth remain
-- separate evidence domains; no collection label asserts governed truth.
CREATE TABLE datasets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name)>0 AND name=trim(name)), description TEXT,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK(kind IN ('custom','adhoc')),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, archived_at TEXT,
  UNIQUE(project_id,id)
) STRICT;
CREATE UNIQUE INDEX dataset_active_name ON datasets(project_id,name) WHERE archived_at IS NULL;
CREATE TABLE dataset_items (
  id TEXT PRIMARY KEY NOT NULL, dataset_id TEXT NOT NULL, project_id TEXT NOT NULL,
  case_id TEXT NOT NULL, trace_id TEXT NOT NULL,
  expected_label TEXT CHECK(expected_label IS NULL OR expected_label IN ('pass','fail')),
  note TEXT, added_at TEXT NOT NULL,
  expected_fail_step INTEGER CHECK(expected_fail_step IS NULL OR expected_fail_step>=0),
  CHECK(expected_label IS NOT 'pass' OR expected_fail_step IS NULL),
  UNIQUE(dataset_id,case_id), UNIQUE(project_id,id),
  FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX dataset_items_order ON dataset_items(dataset_id,added_at,id);

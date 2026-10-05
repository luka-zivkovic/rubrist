CREATE TABLE evaluator_suites (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by_user_id TEXT, created_at TEXT NOT NULL, UNIQUE(project_id,id)
) STRICT;
-- The exact manifest BLOB is the complete immutable member bundle. Members
-- are validated against their project/criterion/evaluator pins on insertion.
CREATE TABLE evaluator_suite_manifests (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, suite_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), canonical_bytes BLOB NOT NULL,
  artifact_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, created_by_user_id TEXT,
  idempotency_key TEXT NOT NULL CHECK(idempotency_key=trim(idempotency_key) AND length(idempotency_key) BETWEEN 1 AND 200),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'), created_at TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,suite_id,revision), UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,suite_id) REFERENCES evaluator_suites(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER suite_manifest_validate BEFORE INSERT ON evaluator_suite_manifests
BEGIN
  SELECT CASE WHEN sqlite_suite_manifest_valid(NEW.canonical_bytes,NEW.id,NEW.project_id,NEW.suite_id,NEW.revision,NEW.artifact_digest,NEW.manifest_digest)=0 THEN RAISE(ABORT,'suite manifest identity or binding mismatch') END;
  SELECT CASE WHEN NEW.revision<>(SELECT coalesce(max(revision),0)+1 FROM evaluator_suite_manifests WHERE project_id=NEW.project_id AND suite_id=NEW.suite_id) THEN RAISE(ABORT,'suite manifest revision mismatch') END;
END;
CREATE TRIGGER suite_manifest_immutable BEFORE UPDATE ON evaluator_suite_manifests BEGIN SELECT RAISE(ABORT,'immutable suite manifest'); END;
CREATE TRIGGER suite_manifest_no_delete BEFORE DELETE ON evaluator_suite_manifests WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'suite manifest deletion requires project erasure'); END;
CREATE TRIGGER suite_identity_immutable BEFORE UPDATE ON evaluator_suites BEGIN SELECT RAISE(ABORT,'immutable suite identity'); END;
CREATE TRIGGER suite_no_delete BEFORE DELETE ON evaluator_suites WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'suite deletion requires project erasure'); END;
CREATE TABLE run_comparisons (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL, dataset_revision_id TEXT, version_a_id TEXT NOT NULL, version_b_id TEXT NOT NULL,
  run_a_id TEXT NOT NULL, run_b_id TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id),
  FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id),
  FOREIGN KEY(project_id,version_a_id) REFERENCES skill_versions(project_id,id),
  FOREIGN KEY(project_id,version_b_id) REFERENCES skill_versions(project_id,id),
  FOREIGN KEY(project_id,run_a_id) REFERENCES eval_runs(project_id,id),
  FOREIGN KEY(project_id,run_b_id) REFERENCES eval_runs(project_id,id)
) STRICT;
CREATE TRIGGER comparison_binding BEFORE INSERT ON run_comparisons WHEN NOT EXISTS(
  SELECT 1 FROM eval_runs a JOIN eval_runs b ON b.project_id=a.project_id WHERE a.project_id=NEW.project_id AND a.id=NEW.run_a_id AND b.id=NEW.run_b_id
  AND a.skill_version_id=NEW.version_a_id AND b.skill_version_id=NEW.version_b_id
  AND a.dataset_id IS NEW.dataset_id AND b.dataset_id IS NEW.dataset_id
  AND a.dataset_revision_id IS NEW.dataset_revision_id AND b.dataset_revision_id IS NEW.dataset_revision_id)
BEGIN SELECT RAISE(ABORT,'comparison run binding mismatch'); END;
CREATE TRIGGER comparison_immutable BEFORE UPDATE ON run_comparisons BEGIN SELECT RAISE(ABORT,'immutable comparison'); END;

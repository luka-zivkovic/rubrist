-- Resolution confirms the saved binding; it is not evaluator identity.
CREATE TABLE evaluator_resolution_records (
  skill_version_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=71 AND substr(binding_digest,1,7)='sha256:' AND substr(binding_digest,8) NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('resolved','unresolved','failed')),
  record TEXT NOT NULL CHECK(json_valid(record) AND json_type(record)='object' AND json_extract(record,'$.status') IS status),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE evaluator_resolution_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_version_id TEXT,
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=71 AND substr(binding_digest,1,7)='sha256:' AND substr(binding_digest,8) NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('resolution','recheck')),
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('candidate_creation','activation','binary_calibration','binary_calibration_run','on_demand','version_save')),
  trigger_ref TEXT NOT NULL CHECK(length(trigger_ref) BETWEEN 1 AND 4096),
  outcome TEXT NOT NULL CHECK((kind='resolution' AND outcome IN ('resolved','unresolved','failed')) OR (kind='recheck' AND outcome IN ('holds','no_longer_holds','unknown'))),
  probes TEXT NOT NULL CHECK(json_valid(probes) AND json_type(probes)='array'),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX evaluator_resolution_attempts_trigger ON evaluator_resolution_attempts(project_id,trigger_kind,trigger_ref,recorded_at);
CREATE TRIGGER evaluator_resolution_attempts_immutable BEFORE UPDATE ON evaluator_resolution_attempts BEGIN SELECT RAISE(ABORT,'Resolution attempts are immutable'); END;
CREATE TRIGGER evaluator_resolution_attempts_erasure BEFORE DELETE ON evaluator_resolution_attempts WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'Resolution attempts require project erasure'); END;
CREATE TABLE evaluator_capability_checks (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  context_digest TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  classification INTEGER NOT NULL CHECK(classification IN (0,1)),
  check_result TEXT NOT NULL CHECK(json_valid(check_result) AND json_type(check_result)='object')
) STRICT;
CREATE INDEX evaluator_capability_checks_lookup ON evaluator_capability_checks(project_id,context_digest,checked_at,sequence);
CREATE INDEX evaluator_capability_checks_expiry ON evaluator_capability_checks(checked_at);

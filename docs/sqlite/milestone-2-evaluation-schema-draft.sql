-- DRAFT: next Milestone 2 consistency group, not an applied migration.
-- ASSUMPTION: this initial shape is sufficient for the native evaluation slice.
-- Runtime commands, SQLite functions, execution fencing, fixture coverage,
-- retention compatibility, and independent audit remain required before moving
-- this into packages/db/sqlite-migrations/. Do not execute against installations.

CREATE TABLE judge_runs (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, case_id TEXT NOT NULL, skill_version_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','ambiguous')), score REAL NOT NULL,
  reasoning TEXT, raw_request TEXT CHECK(raw_request IS NULL OR json_valid(raw_request)),
  raw_response TEXT CHECK(raw_response IS NULL OR json_valid(raw_response)),
  created_at TEXT NOT NULL, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  provider_metadata TEXT CHECK(provider_metadata IS NULL OR json_valid(provider_metadata)),
  UNIQUE(project_id,id), UNIQUE(project_id,case_id,skill_version_id),
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE verdicts (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, case_id TEXT NOT NULL, skill_version_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source='llm_judge'), actor_user_id TEXT CHECK(actor_user_id IS NULL),
  verdict_kind TEXT NOT NULL CHECK(verdict_kind IN ('binary','scalar','categorical')),
  payload TEXT NOT NULL CHECK(json_valid(payload)), external_run_id TEXT CHECK(external_run_id IS NULL),
  created_at TEXT NOT NULL, observed TEXT CHECK(observed IS NULL OR (json_valid(observed) AND json_type(observed)='object')),
  evaluator_score TEXT CHECK(evaluator_score IS NULL OR (observed IS NOT NULL AND json_valid(evaluator_score) AND json_type(evaluator_score)='object')),
  UNIQUE(project_id,id), UNIQUE(project_id,case_id,id),
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id),
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, dataset_id TEXT,
  dataset_revision_id TEXT CHECK(dataset_revision_id IS NULL), skill_version_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','api_batch','release_evidence')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  blocking INTEGER NOT NULL DEFAULT 0 CHECK(blocking IN (0,1)),
  total_items INTEGER NOT NULL CHECK(total_items>=0), completed_items INTEGER NOT NULL DEFAULT 0 CHECK(completed_items>=0),
  failed_items INTEGER NOT NULL DEFAULT 0 CHECK(failed_items>=0), agreed_items INTEGER NOT NULL DEFAULT 0 CHECK(agreed_items>=0 AND agreed_items<=completed_items),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  queue_job_id TEXT, queue_dispatch_token TEXT, queue_dispatch_claimed_at INTEGER, queue_dispatched_at INTEGER,
  required_receipt_id TEXT GENERATED ALWAYS AS(CASE WHEN trigger='release_evidence' AND status IN ('completed','failed') THEN 'rart_'||id||'_v1_r1' END) STORED,
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id),
  FOREIGN KEY(project_id,id,required_receipt_id) REFERENCES assessment_receipt_artifacts(project_id,eval_run_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(completed_items+failed_items<=total_items),
  CHECK((status IN ('completed','failed'))=(finished_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','failed') OR completed_items+failed_items=total_items),
  CHECK(trigger<>'release_evidence' OR dataset_id IS NULL),
  CHECK((queue_dispatch_token IS NULL)=(queue_dispatch_claimed_at IS NULL))
) STRICT;
CREATE TABLE eval_run_items (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, eval_run_id TEXT NOT NULL,
  dataset_item_id TEXT, dataset_revision_item_id TEXT CHECK(dataset_revision_item_id IS NULL), case_id TEXT NOT NULL,
  client_item_id TEXT, content_digest TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','skipped')),
  verdict_id TEXT, expected_label TEXT CHECK(expected_label IS NULL OR expected_label IN ('pass','fail')),
  result_label TEXT, agreement INTEGER CHECK(agreement IS NULL OR agreement IN (0,1)),
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cached INTEGER NOT NULL DEFAULT 0 CHECK(cached IN (0,1)), error TEXT,
  created_at TEXT NOT NULL, finished_at TEXT, expected_fail_step INTEGER, failing_step INTEGER,
  provider_metadata TEXT CHECK(provider_metadata IS NULL OR json_valid(provider_metadata)),
  queue_job_id TEXT, delivery_deadline_at INTEGER, execution_token TEXT, execution_claimed_at INTEGER,
  provider_call_started_at INTEGER, provider_call_returned_at INTEGER,
  failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('provider_rejected_request','provider_unavailable','provider_authentication','provider_rate_limit','provider_timeout','provider_transport','provider_protocol','invalid_evaluator_output','outcome_unknown','internal')),
  not_attempted INTEGER NOT NULL DEFAULT 0 CHECK(not_attempted IN (0,1)),
  observed TEXT CHECK(observed IS NULL OR (json_valid(observed) AND json_type(observed)='object')),
  UNIQUE(project_id,id), UNIQUE(eval_run_id,client_item_id),
  FOREIGN KEY(project_id,eval_run_id) REFERENCES eval_runs(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id),
  FOREIGN KEY(project_id,case_id,verdict_id) REFERENCES verdicts(project_id,case_id,id),
  FOREIGN KEY(project_id,dataset_item_id) REFERENCES dataset_items(project_id,id),
  CHECK((status='pending')=(finished_at IS NULL)),
  CHECK((execution_token IS NULL)=(execution_claimed_at IS NULL)),
  CHECK(provider_call_started_at IS NULL OR execution_token IS NOT NULL),
  CHECK(provider_call_returned_at IS NULL OR provider_call_started_at IS NOT NULL),
  CHECK(status='pending' OR execution_token IS NULL),
  CHECK((status<>'failed')=((failure_kind IS NULL) AND not_attempted=0)),
  CHECK(failure_kind IS NULL OR (not_attempted=0 AND observed IS NOT NULL)),
  CHECK(not_attempted=0 OR observed IS NULL),
  CHECK(observed IS NULL OR status='failed'),
  CHECK(status<>'completed' OR (verdict_id IS NOT NULL AND result_label IS NOT NULL))
) STRICT;
CREATE INDEX eval_run_items_pending ON eval_run_items(project_id,eval_run_id,status,created_at,id);
CREATE TABLE assessment_receipt_artifacts (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, eval_run_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK(contract_version=1), artifact_revision INTEGER NOT NULL CHECK(artifact_revision>0),
  canonical_bytes BLOB NOT NULL CHECK(length(canonical_bytes)>0), artifact_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL, source_snapshot_digest TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('terminal_mint','historical_freeze','correction')),
  predecessor_artifact_id TEXT, correction_reason TEXT, created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,eval_run_id,id), UNIQUE(project_id,receipt_id), UNIQUE(eval_run_id,contract_version,artifact_revision),
  FOREIGN KEY(project_id,eval_run_id) REFERENCES eval_runs(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,eval_run_id,predecessor_artifact_id) REFERENCES assessment_receipt_artifacts(project_id,eval_run_id,id),
  CHECK((artifact_revision=1 AND predecessor_artifact_id IS NULL AND source_kind<>'correction' AND correction_reason IS NULL)
    OR (artifact_revision>1 AND predecessor_artifact_id IS NOT NULL AND source_kind='correction' AND length(trim(correction_reason))>0))
) STRICT;
CREATE TABLE assessment_receipt_comparisons (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, eval_run_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
  consumer_receipt_id TEXT NOT NULL, consumer_canonical_bytes BLOB NOT NULL CHECK(length(consumer_canonical_bytes)>0),
  consumer_artifact_digest TEXT NOT NULL, comparison_status TEXT NOT NULL CHECK(comparison_status IN ('match','diverged')),
  created_at TEXT NOT NULL, UNIQUE(artifact_id,consumer_artifact_digest),
  FOREIGN KEY(project_id,eval_run_id,artifact_id) REFERENCES assessment_receipt_artifacts(project_id,eval_run_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER receipt_validate BEFORE INSERT ON assessment_receipt_artifacts
BEGIN
  SELECT CASE WHEN sqlite_receipt_valid(NEW.canonical_bytes,NEW.project_id,NEW.eval_run_id,NEW.receipt_id,NEW.contract_version,NEW.artifact_digest,NEW.evidence_digest)=0
    THEN RAISE(ABORT,'receipt bytes or identity mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM eval_runs WHERE project_id=NEW.project_id AND id=NEW.eval_run_id
    AND trigger='release_evidence' AND status IN ('completed','failed')) THEN RAISE(ABORT,'receipt requires terminal release evidence') END;
  SELECT CASE WHEN NEW.artifact_revision>1 AND NOT EXISTS(SELECT 1 FROM assessment_receipt_artifacts
    WHERE id=NEW.predecessor_artifact_id AND project_id=NEW.project_id AND eval_run_id=NEW.eval_run_id
    AND contract_version=NEW.contract_version AND artifact_revision=NEW.artifact_revision-1)
    THEN RAISE(ABORT,'receipt predecessor mismatch') END;
END;
CREATE TRIGGER receipt_immutable BEFORE UPDATE ON assessment_receipt_artifacts
BEGIN SELECT RAISE(ABORT,'immutable receipt artifact'); END;
CREATE TRIGGER receipt_no_delete BEFORE DELETE ON assessment_receipt_artifacts WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'receipt deletion requires project erasure'); END;
CREATE TRIGGER receipt_comparison_immutable BEFORE UPDATE ON assessment_receipt_comparisons
BEGIN SELECT RAISE(ABORT,'immutable receipt comparison'); END;
CREATE TRIGGER receipt_comparison_no_delete BEFORE DELETE ON assessment_receipt_comparisons WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'receipt comparison deletion requires project erasure'); END;
CREATE TRIGGER verdict_immutable BEFORE UPDATE ON verdicts
BEGIN SELECT RAISE(ABORT,'immutable evaluator verdict'); END;
CREATE TRIGGER verdict_no_delete BEFORE DELETE ON verdicts WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'verdict deletion requires project erasure'); END;

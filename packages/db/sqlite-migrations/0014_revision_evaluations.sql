-- Forward rebuild for ordinary revision-backed evaluations. All M2 columns
-- and rowids are copied verbatim; generated receipt obligations are compared.

CREATE TABLE eval_runs__new (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, dataset_id TEXT,
  dataset_revision_id TEXT, skill_version_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','api_batch','backfill','release_evidence')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  blocking INTEGER NOT NULL DEFAULT 0 CHECK(blocking IN (0,1)),
  total_items INTEGER NOT NULL CHECK(total_items>=0), completed_items INTEGER NOT NULL DEFAULT 0 CHECK(completed_items>=0),
  failed_items INTEGER NOT NULL DEFAULT 0 CHECK(failed_items>=0), agreed_items INTEGER NOT NULL DEFAULT 0 CHECK(agreed_items>=0 AND agreed_items<=completed_items),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  queue_job_id TEXT, queue_dispatch_token TEXT, queue_dispatch_claimed_at INTEGER, queue_dispatched_at INTEGER,
  required_receipt_id TEXT GENERATED ALWAYS AS(CASE WHEN trigger='release_evidence' AND status IN ('completed','failed') THEN 'rart_'||id||'_v1_r1' END) STORED,
  convergence_case_id TEXT,ingestion_case_id TEXT,
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,convergence_case_id) REFERENCES cases(project_id,id),
  FOREIGN KEY(project_id,ingestion_case_id) REFERENCES cases(project_id,id),
  FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id),
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,dataset_id) REFERENCES datasets(project_id,id),
  FOREIGN KEY(project_id,id,required_receipt_id) REFERENCES assessment_receipt_artifacts(project_id,eval_run_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(completed_items+failed_items<=total_items),
  CHECK((status IN ('completed','failed'))=(finished_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','failed') OR completed_items+failed_items=total_items),
  CHECK(trigger<>'release_evidence' OR (dataset_id IS NULL AND dataset_revision_id IS NULL)),
  CHECK((queue_dispatch_token IS NULL)=(queue_dispatch_claimed_at IS NULL))
) STRICT;
INSERT INTO eval_runs__new(rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at) SELECT rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at FROM eval_runs;
CREATE TEMP TABLE eval_runs_copy_assert(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO eval_runs_copy_assert SELECT (SELECT count(*) FROM eval_runs)=(SELECT count(*) FROM eval_runs__new);
INSERT INTO eval_runs_copy_assert SELECT NOT EXISTS(SELECT rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at,required_receipt_id FROM eval_runs EXCEPT SELECT rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at,required_receipt_id FROM eval_runs__new);
DROP TABLE eval_runs_copy_assert;
CREATE TABLE eval_run_items__new (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, eval_run_id TEXT NOT NULL,
  dataset_item_id TEXT REFERENCES dataset_items(id) ON DELETE SET NULL, dataset_revision_item_id TEXT, case_id TEXT NOT NULL,
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
  FOREIGN KEY(project_id,dataset_revision_item_id) REFERENCES dataset_revision_items(project_id,id),
  FOREIGN KEY(project_id,eval_run_id) REFERENCES eval_runs(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,case_id,verdict_id) REFERENCES verdicts(project_id,case_id,id),
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
INSERT INTO eval_run_items__new(rowid,id,project_id,eval_run_id,dataset_item_id,dataset_revision_item_id,case_id,client_item_id,content_digest,status,verdict_id,expected_label,result_label,agreement,latency_ms,input_tokens,output_tokens,cached,error,created_at,finished_at,expected_fail_step,failing_step,provider_metadata,queue_job_id,delivery_deadline_at,execution_token,execution_claimed_at,provider_call_started_at,provider_call_returned_at,failure_kind,not_attempted,observed) SELECT rowid,id,project_id,eval_run_id,dataset_item_id,dataset_revision_item_id,case_id,client_item_id,content_digest,status,verdict_id,expected_label,result_label,agreement,latency_ms,input_tokens,output_tokens,cached,error,created_at,finished_at,expected_fail_step,failing_step,provider_metadata,queue_job_id,delivery_deadline_at,execution_token,execution_claimed_at,provider_call_started_at,provider_call_returned_at,failure_kind,not_attempted,observed FROM eval_run_items;
CREATE TEMP TABLE eval_run_items_copy_assert(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO eval_run_items_copy_assert SELECT (SELECT count(*) FROM eval_run_items)=(SELECT count(*) FROM eval_run_items__new);
INSERT INTO eval_run_items_copy_assert SELECT NOT EXISTS(SELECT rowid,id,project_id,eval_run_id,dataset_item_id,dataset_revision_item_id,case_id,client_item_id,content_digest,status,verdict_id,expected_label,result_label,agreement,latency_ms,input_tokens,output_tokens,cached,error,created_at,finished_at,expected_fail_step,failing_step,provider_metadata,queue_job_id,delivery_deadline_at,execution_token,execution_claimed_at,provider_call_started_at,provider_call_returned_at,failure_kind,not_attempted,observed FROM eval_run_items EXCEPT SELECT rowid,id,project_id,eval_run_id,dataset_item_id,dataset_revision_item_id,case_id,client_item_id,content_digest,status,verdict_id,expected_label,result_label,agreement,latency_ms,input_tokens,output_tokens,cached,error,created_at,finished_at,expected_fail_step,failing_step,provider_metadata,queue_job_id,delivery_deadline_at,execution_token,execution_claimed_at,provider_call_started_at,provider_call_returned_at,failure_kind,not_attempted,observed FROM eval_run_items__new);
DROP TABLE eval_run_items_copy_assert;
DROP TRIGGER receipt_validate;
DROP TRIGGER eval_item_dataset_owner;
DROP TRIGGER eval_item_dataset_update;
DROP TRIGGER eval_item_identity_immutable;
DROP TRIGGER eval_run_identity_immutable;
DROP TRIGGER eval_run_terminal_immutable;
DROP TRIGGER eval_item_terminal_immutable;
DROP TRIGGER comparison_binding;
DROP TRIGGER eval_item_verdict_insert;
DROP TRIGGER eval_item_verdict_update;
DROP TABLE eval_run_items;
DROP TABLE eval_runs;
ALTER TABLE eval_runs__new RENAME TO eval_runs;
ALTER TABLE eval_run_items__new RENAME TO eval_run_items;
CREATE INDEX eval_run_items_pending ON eval_run_items(project_id,eval_run_id,status,created_at,id);
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
CREATE TRIGGER eval_item_dataset_owner BEFORE INSERT ON eval_run_items WHEN NEW.dataset_item_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM dataset_items d JOIN eval_runs r ON r.project_id=d.project_id AND r.dataset_id=d.dataset_id
  WHERE d.id=NEW.dataset_item_id AND d.project_id=NEW.project_id AND d.case_id=NEW.case_id AND r.id=NEW.eval_run_id)
BEGIN SELECT RAISE(ABORT,'eval dataset item ownership mismatch'); END;
CREATE TRIGGER eval_item_dataset_update BEFORE UPDATE OF dataset_item_id ON eval_run_items WHEN NEW.dataset_item_id IS NOT OLD.dataset_item_id AND
 (NEW.dataset_item_id IS NOT NULL OR EXISTS(SELECT 1 FROM dataset_items WHERE id=OLD.dataset_item_id))
BEGIN SELECT RAISE(ABORT,'immutable eval dataset item'); END;
CREATE TRIGGER eval_item_identity_immutable BEFORE UPDATE ON eval_run_items WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.eval_run_id<>OLD.eval_run_id OR NEW.case_id<>OLD.case_id OR
  NEW.client_item_id IS NOT OLD.client_item_id OR NEW.content_digest IS NOT OLD.content_digest OR
  NEW.dataset_revision_item_id IS NOT OLD.dataset_revision_item_id OR NEW.expected_label IS NOT OLD.expected_label OR NEW.expected_fail_step IS NOT OLD.expected_fail_step OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable eval item identity'); END;
CREATE TRIGGER eval_run_identity_immutable BEFORE UPDATE ON eval_runs WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.skill_version_id<>OLD.skill_version_id OR NEW.trigger<>OLD.trigger OR
  NEW.convergence_case_id IS NOT OLD.convergence_case_id OR NEW.ingestion_case_id IS NOT OLD.ingestion_case_id OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.dataset_revision_id IS NOT OLD.dataset_revision_id OR NEW.total_items<>OLD.total_items OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable eval run identity'); END;
CREATE TRIGGER eval_run_terminal_immutable BEFORE UPDATE ON eval_runs WHEN OLD.status IN ('completed','failed') AND
  (NEW.status<>OLD.status OR NEW.completed_items<>OLD.completed_items OR NEW.failed_items<>OLD.failed_items OR
   NEW.agreed_items<>OLD.agreed_items OR NEW.error IS NOT OLD.error OR NEW.finished_at IS NOT OLD.finished_at)
BEGIN SELECT RAISE(ABORT,'immutable terminal eval run'); END;
CREATE TRIGGER eval_item_terminal_immutable BEFORE UPDATE ON eval_run_items WHEN OLD.status<>'pending' AND
  (NEW.status<>OLD.status OR NEW.verdict_id IS NOT OLD.verdict_id OR NEW.result_label IS NOT OLD.result_label OR
   NEW.agreement IS NOT OLD.agreement OR NEW.failing_step IS NOT OLD.failing_step OR NEW.latency_ms IS NOT OLD.latency_ms OR
   NEW.input_tokens IS NOT OLD.input_tokens OR NEW.output_tokens IS NOT OLD.output_tokens OR NEW.cached<>OLD.cached OR
   NEW.provider_metadata IS NOT OLD.provider_metadata OR NEW.error IS NOT OLD.error OR NEW.failure_kind IS NOT OLD.failure_kind OR
   NEW.not_attempted<>OLD.not_attempted OR NEW.observed IS NOT OLD.observed OR NEW.finished_at IS NOT OLD.finished_at)
BEGIN SELECT RAISE(ABORT,'immutable terminal eval item'); END;
CREATE TRIGGER comparison_binding BEFORE INSERT ON run_comparisons WHEN NOT EXISTS(
  SELECT 1 FROM eval_runs a JOIN eval_runs b ON b.project_id=a.project_id WHERE a.project_id=NEW.project_id AND a.id=NEW.run_a_id AND b.id=NEW.run_b_id
  AND a.skill_version_id=NEW.version_a_id AND b.skill_version_id=NEW.version_b_id
  AND ((NEW.dataset_revision_id IS NULL AND a.dataset_id IS NEW.dataset_id AND b.dataset_id IS NEW.dataset_id) OR (NEW.dataset_revision_id IS NOT NULL AND EXISTS(SELECT 1 FROM dataset_revisions d WHERE d.id=NEW.dataset_revision_id AND d.project_id=NEW.project_id AND d.source_dataset_id=NEW.dataset_id)))
  AND a.dataset_revision_id IS NEW.dataset_revision_id AND b.dataset_revision_id IS NEW.dataset_revision_id)
BEGIN SELECT RAISE(ABORT,'comparison run binding mismatch'); END;
CREATE TRIGGER eval_item_verdict_insert BEFORE INSERT ON eval_run_items WHEN NEW.verdict_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM verdicts v JOIN eval_runs r ON r.project_id=v.project_id AND r.skill_version_id=v.skill_version_id
  WHERE r.id=NEW.eval_run_id AND v.project_id=NEW.project_id AND v.case_id=NEW.case_id AND v.id=NEW.verdict_id)
BEGIN SELECT RAISE(ABORT,'eval verdict evaluator mismatch'); END;
CREATE TRIGGER eval_item_verdict_update BEFORE UPDATE OF verdict_id ON eval_run_items WHEN NEW.verdict_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM verdicts v JOIN eval_runs r ON r.project_id=v.project_id AND r.skill_version_id=v.skill_version_id
  WHERE r.id=NEW.eval_run_id AND v.project_id=NEW.project_id AND v.case_id=NEW.case_id AND v.id=NEW.verdict_id)
BEGIN SELECT RAISE(ABORT,'eval verdict evaluator mismatch'); END;
CREATE UNIQUE INDEX eval_backfill_unique ON eval_runs(project_id,skill_version_id) WHERE trigger='backfill';
CREATE UNIQUE INDEX eval_ingestion_unique ON eval_runs(project_id,skill_version_id,ingestion_case_id) WHERE ingestion_case_id IS NOT NULL;
CREATE UNIQUE INDEX eval_convergence_active_unique ON eval_runs(project_id,skill_version_id,convergence_case_id) WHERE convergence_case_id IS NOT NULL AND status IN ('pending','running');
CREATE TRIGGER eval_revision_stage BEFORE INSERT ON eval_runs WHEN NEW.dataset_revision_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM dataset_revisions WHERE id=NEW.dataset_revision_id AND project_id=NEW.project_id AND source_kind<>'analysis_population' AND role<>'sealed_validation')
BEGIN SELECT RAISE(ABORT,'ordinary evaluation revision unavailable'); END;
CREATE TRIGGER eval_revision_item BEFORE INSERT ON eval_run_items BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM eval_runs WHERE id=NEW.eval_run_id AND dataset_revision_id IS NOT NULL) AND NEW.dataset_revision_item_id IS NULL THEN RAISE(ABORT,'revision-bound evaluation requires item binding') END;
 SELECT CASE WHEN NEW.dataset_revision_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revision_items i JOIN eval_runs r ON r.project_id=i.project_id AND r.dataset_revision_id=i.revision_id WHERE i.id=NEW.dataset_revision_item_id AND i.project_id=NEW.project_id AND i.source_case_id=NEW.case_id AND r.id=NEW.eval_run_id) THEN RAISE(ABORT,'evaluation revision item binding mismatch') END;
END;
CREATE TRIGGER eval_revision_exposure BEFORE INSERT ON dataset_exposure_events WHEN NEW.evidence_ref_kind='eval_run' AND NOT EXISTS(
 SELECT 1 FROM eval_runs WHERE id=NEW.evidence_ref_id AND project_id=NEW.project_id AND dataset_revision_id=NEW.revision_id AND skill_version_id=NEW.subject_id AND status IN ('running','completed','failed') AND NEW.kind='development_use' AND NEW.exposure_class='development' AND NEW.activity='development_run' AND NEW.subject_kind='evaluator_version')
BEGIN SELECT RAISE(ABORT,'evaluation exposure binding mismatch'); END;

-- Account erasure may anonymize attribution through ON DELETE SET NULL.
CREATE TRIGGER eval_run_creator_immutable BEFORE UPDATE OF created_by_user_id ON eval_runs WHEN
  NEW.created_by_user_id IS NOT OLD.created_by_user_id AND NOT(
    NEW.created_by_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))
BEGIN SELECT RAISE(ABORT,'immutable eval run creator'); END;

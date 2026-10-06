-- Preserve automatic-run cascade semantics during ordinary traffic retention.
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
  convergence_case_id TEXT,ingestion_case_id TEXT, source_trace_test_id TEXT REFERENCES trace_tests(id), source_trace_test_revision INTEGER, source_trace_test_validation_id TEXT REFERENCES trace_test_validations(id), source_trace_test_validation_revision INTEGER, source_trace_test_case_ref TEXT, source_trace_test_case_id TEXT, source_trace_test_dataset_item_id TEXT,
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,convergence_case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,ingestion_case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
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
INSERT INTO eval_runs__new(rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at,convergence_case_id,ingestion_case_id,source_trace_test_id,source_trace_test_revision,source_trace_test_validation_id,source_trace_test_validation_revision,source_trace_test_case_ref,source_trace_test_case_id,source_trace_test_dataset_item_id) SELECT rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at,convergence_case_id,ingestion_case_id,source_trace_test_id,source_trace_test_revision,source_trace_test_validation_id,source_trace_test_validation_revision,source_trace_test_case_ref,source_trace_test_case_id,source_trace_test_dataset_item_id FROM eval_runs;
CREATE TEMP TABLE eval_retention_copy_assert(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO eval_retention_copy_assert SELECT (SELECT count(*) FROM eval_runs)=(SELECT count(*) FROM eval_runs__new);
INSERT INTO eval_retention_copy_assert SELECT NOT EXISTS(SELECT rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at,convergence_case_id,ingestion_case_id,source_trace_test_id,source_trace_test_revision,source_trace_test_validation_id,source_trace_test_validation_revision,source_trace_test_case_ref,source_trace_test_case_id,source_trace_test_dataset_item_id,required_receipt_id FROM eval_runs EXCEPT SELECT rowid,id,project_id,dataset_id,dataset_revision_id,skill_version_id,trigger,status,blocking,total_items,completed_items,failed_items,agreed_items,created_by_user_id,error,created_at,started_at,finished_at,queue_job_id,queue_dispatch_token,queue_dispatch_claimed_at,queue_dispatched_at,convergence_case_id,ingestion_case_id,source_trace_test_id,source_trace_test_revision,source_trace_test_validation_id,source_trace_test_validation_revision,source_trace_test_case_ref,source_trace_test_case_id,source_trace_test_dataset_item_id,required_receipt_id FROM eval_runs__new);
DROP TABLE eval_retention_copy_assert;
DROP TRIGGER receipt_validate;
DROP TRIGGER eval_item_dataset_owner;
DROP TRIGGER eval_run_identity_immutable;
DROP TRIGGER eval_run_terminal_immutable;
DROP TRIGGER comparison_binding;
DROP TRIGGER eval_item_verdict_insert;
DROP TRIGGER eval_item_verdict_update;
DROP TRIGGER eval_revision_stage;
DROP TRIGGER eval_revision_item;
DROP TRIGGER eval_revision_exposure;
DROP TRIGGER eval_trace_test_binding;
DROP TRIGGER eval_trace_test_identity;
DROP TABLE eval_runs;
ALTER TABLE eval_runs__new RENAME TO eval_runs;
CREATE UNIQUE INDEX eval_backfill_unique ON eval_runs(project_id,skill_version_id) WHERE trigger='backfill';
CREATE UNIQUE INDEX eval_ingestion_unique ON eval_runs(project_id,skill_version_id,ingestion_case_id) WHERE ingestion_case_id IS NOT NULL;
CREATE UNIQUE INDEX eval_convergence_active_unique ON eval_runs(project_id,skill_version_id,convergence_case_id) WHERE convergence_case_id IS NOT NULL AND status IN ('pending','running');
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
CREATE TRIGGER eval_run_identity_immutable BEFORE UPDATE ON eval_runs WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.skill_version_id<>OLD.skill_version_id OR NEW.trigger<>OLD.trigger OR
  NEW.convergence_case_id IS NOT OLD.convergence_case_id OR NEW.ingestion_case_id IS NOT OLD.ingestion_case_id OR NEW.dataset_id IS NOT OLD.dataset_id OR NEW.dataset_revision_id IS NOT OLD.dataset_revision_id OR NEW.total_items<>OLD.total_items OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable eval run identity'); END;
CREATE TRIGGER eval_run_terminal_immutable BEFORE UPDATE ON eval_runs WHEN OLD.status IN ('completed','failed') AND
  (NEW.status<>OLD.status OR NEW.completed_items<>OLD.completed_items OR NEW.failed_items<>OLD.failed_items OR
   NEW.agreed_items<>OLD.agreed_items OR NEW.error IS NOT OLD.error OR NEW.finished_at IS NOT OLD.finished_at OR NEW.started_at IS NOT OLD.started_at OR NEW.blocking IS NOT OLD.blocking)
BEGIN SELECT RAISE(ABORT,'immutable terminal eval run'); END;
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
CREATE TRIGGER eval_trace_test_binding BEFORE INSERT ON eval_runs WHEN
 (NEW.source_trace_test_id IS NULL AND (NEW.source_trace_test_revision IS NOT NULL OR NEW.source_trace_test_validation_id IS NOT NULL OR
 NEW.source_trace_test_validation_revision IS NOT NULL OR NEW.source_trace_test_case_ref IS NOT NULL OR NEW.source_trace_test_case_id IS NOT NULL OR NEW.source_trace_test_dataset_item_id IS NOT NULL)) OR
 (NEW.source_trace_test_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM trace_tests t JOIN trace_test_revisions r ON r.project_id=t.project_id AND r.trace_test_id=t.id
 JOIN trace_test_validations v ON v.project_id=r.project_id AND v.trace_test_id=r.trace_test_id AND v.id=r.validation_id AND v.revision=r.validated_revision
 JOIN dataset_items d ON d.project_id=t.project_id AND d.dataset_id=NEW.dataset_id
 WHERE t.id=NEW.source_trace_test_id AND t.project_id=NEW.project_id AND t.source_case_ref=NEW.source_trace_test_case_ref
 AND r.revision=NEW.source_trace_test_revision AND r.lifecycle='enabled' AND v.id=NEW.source_trace_test_validation_id
 AND v.revision=NEW.source_trace_test_validation_revision AND d.id=NEW.source_trace_test_dataset_item_id AND d.case_id=NEW.source_trace_test_case_id))
BEGIN SELECT RAISE(ABORT,'trace test evaluation binding mismatch'); END;
CREATE TRIGGER eval_trace_test_identity BEFORE UPDATE ON eval_runs WHEN
 NEW.source_trace_test_id IS NOT OLD.source_trace_test_id OR NEW.source_trace_test_revision IS NOT OLD.source_trace_test_revision OR
 NEW.source_trace_test_validation_id IS NOT OLD.source_trace_test_validation_id OR NEW.source_trace_test_validation_revision IS NOT OLD.source_trace_test_validation_revision OR
 NEW.source_trace_test_case_ref IS NOT OLD.source_trace_test_case_ref OR NEW.source_trace_test_case_id IS NOT OLD.source_trace_test_case_id OR NEW.source_trace_test_dataset_item_id IS NOT OLD.source_trace_test_dataset_item_id
BEGIN SELECT RAISE(ABORT,'immutable trace test run binding'); END;
ALTER TABLE projects ADD COLUMN last_retention_pruned_at TEXT;

-- Account erasure may anonymize attribution through ON DELETE SET NULL.
CREATE TRIGGER eval_run_creator_immutable BEFORE UPDATE OF created_by_user_id ON eval_runs WHEN
  NEW.created_by_user_id IS NOT OLD.created_by_user_id AND NOT(
    NEW.created_by_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))
BEGIN SELECT RAISE(ABORT,'immutable eval run creator'); END;

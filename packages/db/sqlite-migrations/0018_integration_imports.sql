-- Forward rebuild: retain all existing trace/case values and rowids while enabling integration imports.

CREATE TABLE raw_traces__new (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('manual','release_evidence','langsmith','langfuse','ironside')),
  source_integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
  source_remote_project_id TEXT CHECK(source_remote_project_id IS NULL OR
    (source_remote_project_id=trim(source_remote_project_id) AND length(source_remote_project_id) BETWEEN 1 AND 500)),
  source_trace_id TEXT NOT NULL,
  source_trace_version TEXT CHECK(source_trace_version IS NULL OR
    (source_trace_version=trim(source_trace_version) AND length(source_trace_version) BETWEEN 1 AND 200)),
  import_job_id TEXT,
  raw_payload TEXT NOT NULL CHECK(json_valid(raw_payload) AND json_type(raw_payload)='object'),
  normalization_version TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,import_job_id) REFERENCES import_jobs(project_id,id),
  UNIQUE(project_id,id,source)
) STRICT;
INSERT INTO raw_traces__new(rowid,id,project_id,source,source_integration_id,source_remote_project_id,source_trace_id,source_trace_version,import_job_id,raw_payload,normalization_version,created_at) SELECT rowid,id,project_id,source,source_integration_id,source_remote_project_id,source_trace_id,source_trace_version,import_job_id,raw_payload,normalization_version,created_at FROM raw_traces;
CREATE TEMP TABLE raw_traces_copy_assert(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO raw_traces_copy_assert SELECT (SELECT count(*) FROM raw_traces)=(SELECT count(*) FROM raw_traces__new);
INSERT INTO raw_traces_copy_assert SELECT NOT EXISTS(SELECT rowid,id,project_id,source,source_integration_id,source_remote_project_id,source_trace_id,source_trace_version,import_job_id,raw_payload,normalization_version,created_at FROM raw_traces EXCEPT SELECT rowid,id,project_id,source,source_integration_id,source_remote_project_id,source_trace_id,source_trace_version,import_job_id,raw_payload,normalization_version,created_at FROM raw_traces__new);
DROP TABLE raw_traces_copy_assert;
CREATE TABLE cases__new (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_trace_id TEXT NOT NULL, case_type TEXT NOT NULL,
  normalized_payload TEXT NOT NULL CHECK(json_valid(normalized_payload) AND json_type(normalized_payload)='object'),
  created_at TEXT NOT NULL, ingestion_purpose TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(raw_trace_id),
  FOREIGN KEY(project_id,raw_trace_id,case_type) REFERENCES raw_traces(project_id,id,source),
  CHECK((case_type='manual' AND ingestion_purpose IN ('analysis_eligible_manual','judge_api','judge_batch_general','dataset_example','trace_test_synthetic'))
    OR (case_type='release_evidence' AND ingestion_purpose='release_evidence')
    OR (case_type='langsmith' AND ingestion_purpose='analysis_eligible_langsmith')
    OR (case_type='langfuse' AND ingestion_purpose='analysis_eligible_langfuse')
    OR (case_type='ironside' AND ingestion_purpose='analysis_eligible_ironside'))
) STRICT;
INSERT INTO cases__new(rowid,id,project_id,raw_trace_id,case_type,normalized_payload,created_at,ingestion_purpose) SELECT rowid,id,project_id,raw_trace_id,case_type,normalized_payload,created_at,ingestion_purpose FROM cases;
CREATE TEMP TABLE cases_copy_assert(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO cases_copy_assert SELECT (SELECT count(*) FROM cases)=(SELECT count(*) FROM cases__new);
INSERT INTO cases_copy_assert SELECT NOT EXISTS(SELECT rowid,id,project_id,raw_trace_id,case_type,normalized_payload,created_at,ingestion_purpose FROM cases EXCEPT SELECT rowid,id,project_id,raw_trace_id,case_type,normalized_payload,created_at,ingestion_purpose FROM cases__new);
DROP TABLE cases_copy_assert;
DROP TRIGGER case_origin_immutable;
DROP TRIGGER trace_origin_immutable;
DROP TRIGGER case_input_identity_owner;
DROP TRIGGER dataset_revision_item_owner;
DROP TRIGGER revision_bound_case_payload_immutable;
DROP TRIGGER verdict_no_delete;
DROP TRIGGER trace_test_source_owner;
DROP TRIGGER trace_test_identity;
DROP TABLE cases;
DROP TABLE raw_traces;
ALTER TABLE raw_traces__new RENAME TO raw_traces;
ALTER TABLE cases__new RENAME TO cases;
CREATE UNIQUE INDEX trace_source_identity ON raw_traces(project_id,source,source_trace_id,
  (source_trace_version IS NULL),coalesce(source_trace_version,''),
  (source_remote_project_id IS NULL),coalesce(source_remote_project_id,''));
CREATE INDEX cases_project_time ON cases(project_id,created_at DESC,id);
CREATE TRIGGER case_origin_immutable BEFORE UPDATE ON cases WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.raw_trace_id<>OLD.raw_trace_id OR
  NEW.case_type<>OLD.case_type OR NEW.ingestion_purpose<>OLD.ingestion_purpose OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable case origin'); END;
CREATE TRIGGER trace_origin_immutable BEFORE UPDATE ON raw_traces WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.source<>OLD.source OR NEW.source_trace_id<>OLD.source_trace_id OR
  NEW.source_trace_version IS NOT OLD.source_trace_version OR NEW.source_remote_project_id IS NOT OLD.source_remote_project_id OR
  (NEW.source_integration_id IS NOT OLD.source_integration_id AND (NEW.source_integration_id IS NOT NULL OR EXISTS(SELECT 1 FROM integrations WHERE id=OLD.source_integration_id))) OR NEW.import_job_id IS NOT OLD.import_job_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable trace origin'); END;
CREATE TRIGGER case_input_identity_owner BEFORE INSERT ON case_input_identity_records WHEN NOT EXISTS(
  SELECT 1 FROM cases WHERE project_id=NEW.project_id AND id=NEW.source_case_id)
BEGIN SELECT RAISE(ABORT,'case input identity requires its project case'); END;
CREATE TRIGGER dataset_revision_item_owner BEFORE INSERT ON dataset_revision_items
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_finalizations WHERE revision_id=NEW.revision_id) THEN RAISE(ABORT,'immutable finalized revision') END;
  SELECT CASE WHEN sqlite_dataset_item_valid(NEW.input_digest,NEW.item_digest,NEW.payload_snapshot,NEW.reference_label,NEW.reference_fail_step,NEW.reference_provenance,NEW.note)=0 THEN RAISE(ABORT,'dataset item digest mismatch') END;
  SELECT CASE WHEN NEW.source_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cases WHERE project_id=NEW.project_id AND id=NEW.source_case_id AND sqlite_dataset_payload_equal(normalized_payload,NEW.payload_snapshot)=1) THEN RAISE(ABORT,'dataset item source snapshot mismatch') END;
  SELECT CASE WHEN NEW.source_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM case_input_identity_records WHERE project_id=NEW.project_id AND source_case_id=NEW.source_case_id AND input_digest=NEW.input_digest) THEN RAISE(ABORT,'dataset item input identity mismatch') END;
  SELECT CASE WHEN NEW.source_dataset_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_items d JOIN dataset_revisions r ON r.source_dataset_id=d.dataset_id AND r.project_id=d.project_id WHERE r.id=NEW.revision_id AND d.id=NEW.source_dataset_item_id AND d.project_id=NEW.project_id AND d.case_id=NEW.source_case_id) THEN RAISE(ABORT,'dataset item source membership mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_items i JOIN dataset_revisions r ON r.id=i.revision_id JOIN dataset_revisions target ON target.id=NEW.revision_id WHERE i.project_id=NEW.project_id AND i.input_digest=NEW.input_digest AND (r.role='sealed_validation')<>(target.role='sealed_validation')) THEN RAISE(ABORT,'sealed input overlap requires governed declassification') END;
END;
CREATE TRIGGER revision_bound_case_payload_immutable BEFORE UPDATE OF normalized_payload ON cases WHEN
  EXISTS(SELECT 1 FROM dataset_revision_items WHERE project_id=OLD.project_id AND source_case_id=OLD.id)
  AND sqlite_json_equal(NEW.normalized_payload,OLD.normalized_payload)=0
BEGIN SELECT RAISE(ABORT,'revision-bound case payload is immutable'); END;
CREATE TRIGGER verdict_no_delete BEFORE DELETE ON verdicts WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 AND (OLD.review_queue_item_id IS NOT NULL OR EXISTS(SELECT 1 FROM cases WHERE id=OLD.case_id))
BEGIN SELECT RAISE(ABORT,'verdict deletion requires project erasure'); END;
CREATE TRIGGER trace_test_source_owner BEFORE INSERT ON trace_tests WHEN NOT EXISTS(SELECT 1 FROM cases WHERE project_id=NEW.project_id AND id=NEW.source_case_id)
BEGIN SELECT RAISE(ABORT,'trace test source ownership mismatch'); END;
CREATE TRIGGER trace_test_identity BEFORE UPDATE ON trace_tests WHEN
 NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.source_case_ref<>OLD.source_case_ref OR NEW.source_trace_ref<>OLD.source_trace_ref OR
 NEW.source_snapshot<>OLD.source_snapshot OR NEW.source_scope<>OLD.source_scope OR NEW.created_at<>OLD.created_at OR
 (NEW.source_case_id IS NOT OLD.source_case_id AND (NEW.source_case_id IS NOT NULL OR EXISTS(SELECT 1 FROM cases WHERE id=OLD.source_case_id)))
BEGIN SELECT RAISE(ABORT,'immutable trace test source'); END;
CREATE TRIGGER trace_integration_binding BEFORE INSERT ON raw_traces WHEN
 (NEW.source_integration_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM integrations WHERE id=NEW.source_integration_id AND project_id=NEW.project_id AND provider=NEW.source)) OR
 (NEW.import_job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM import_jobs WHERE id=NEW.import_job_id AND project_id=NEW.project_id AND source=NEW.source))
BEGIN SELECT RAISE(ABORT,'trace import binding mismatch'); END;

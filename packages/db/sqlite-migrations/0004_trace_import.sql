CREATE TABLE raw_traces (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('manual','release_evidence')),
  source_integration_id TEXT CHECK(source_integration_id IS NULL),
  source_remote_project_id TEXT CHECK(source_remote_project_id IS NULL OR
    (source_remote_project_id=trim(source_remote_project_id) AND length(source_remote_project_id) BETWEEN 1 AND 500)),
  source_trace_id TEXT NOT NULL,
  source_trace_version TEXT CHECK(source_trace_version IS NULL OR
    (source_trace_version=trim(source_trace_version) AND length(source_trace_version) BETWEEN 1 AND 200)),
  import_job_id TEXT CHECK(import_job_id IS NULL),
  raw_payload TEXT NOT NULL CHECK(json_valid(raw_payload) AND json_type(raw_payload)='object'),
  normalization_version TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(project_id,id,source)
) STRICT;
CREATE UNIQUE INDEX trace_source_identity ON raw_traces(project_id,source,source_trace_id,
  (source_trace_version IS NULL),coalesce(source_trace_version,''),
  (source_remote_project_id IS NULL),coalesce(source_remote_project_id,''));
CREATE TABLE cases (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_trace_id TEXT NOT NULL, case_type TEXT NOT NULL,
  normalized_payload TEXT NOT NULL CHECK(json_valid(normalized_payload) AND json_type(normalized_payload)='object'),
  created_at TEXT NOT NULL, ingestion_purpose TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(raw_trace_id),
  FOREIGN KEY(project_id,raw_trace_id,case_type) REFERENCES raw_traces(project_id,id,source),
  CHECK((case_type='manual' AND ingestion_purpose IN ('analysis_eligible_manual','judge_api','judge_batch_general','dataset_example','trace_test_synthetic'))
    OR (case_type='release_evidence' AND ingestion_purpose='release_evidence'))
) STRICT;
CREATE INDEX cases_project_time ON cases(project_id,created_at DESC,id);
CREATE TABLE case_input_identity_records (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Deliberately no case FK: identities outlive retention of raw traffic.
  source_case_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind='authoring_import'),
  identity_basis TEXT NOT NULL CHECK(identity_basis='input-identity/v1'),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,source_case_id,record_kind)
) STRICT;
CREATE TRIGGER case_origin_immutable BEFORE UPDATE ON cases WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.raw_trace_id<>OLD.raw_trace_id OR
  NEW.case_type<>OLD.case_type OR NEW.ingestion_purpose<>OLD.ingestion_purpose OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable case origin'); END;
CREATE TRIGGER trace_origin_immutable BEFORE UPDATE ON raw_traces WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.source<>OLD.source OR NEW.source_trace_id<>OLD.source_trace_id OR
  NEW.source_trace_version IS NOT OLD.source_trace_version OR NEW.source_remote_project_id IS NOT OLD.source_remote_project_id OR
  NEW.source_integration_id IS NOT OLD.source_integration_id OR NEW.import_job_id IS NOT OLD.import_job_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable trace origin'); END;
CREATE TRIGGER case_input_identity_owner BEFORE INSERT ON case_input_identity_records WHEN NOT EXISTS(
  SELECT 1 FROM cases WHERE project_id=NEW.project_id AND id=NEW.source_case_id)
BEGIN SELECT RAISE(ABORT,'case input identity requires its project case'); END;
CREATE TRIGGER case_input_identity_immutable BEFORE UPDATE ON case_input_identity_records
BEGIN SELECT RAISE(ABORT,'immutable case input identity'); END;
CREATE TRIGGER case_input_identity_no_delete BEFORE DELETE ON case_input_identity_records WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'case input identity deletion requires project erasure'); END;

CREATE TABLE dataset_revisions (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  series_id TEXT NOT NULL, revision_number INTEGER NOT NULL CHECK(revision_number>0),
  source_dataset_id TEXT, parent_revision_id TEXT, role TEXT NOT NULL CHECK(role IN ('analysis_authoring','iterative_development','sealed_validation','regression_golden')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('collection_snapshot','golden_snapshot','sealed_intake','analysis_population')),
  identity_basis TEXT NOT NULL CHECK(identity_basis='input-identity/v1'), content_digest TEXT NOT NULL, revision_digest TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK(item_count>=0), provenance_level TEXT NOT NULL CHECK(provenance_level IN ('legacy','unverified','reviewed_unblinded','governed_blind','imported_self_attested','imported_verified_attested')),
  created_by_user_id TEXT, idempotency_key TEXT, created_at TEXT NOT NULL, criterion_version_id TEXT, analysis_population_id TEXT,
  UNIQUE(project_id,id), UNIQUE(project_id,series_id,revision_number), UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,parent_revision_id) REFERENCES dataset_revisions(project_id,id),
  FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
  FOREIGN KEY(project_id,id) REFERENCES dataset_revision_finalizations(project_id,revision_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(role<>'regression_golden' OR criterion_version_id IS NOT NULL)
) STRICT;
CREATE TABLE dataset_revision_items (
  id TEXT PRIMARY KEY NOT NULL, revision_id TEXT NOT NULL, project_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0),
  -- Historical source references are retained after ordinary traffic cleanup.
  source_case_id TEXT, source_trace_id TEXT, source_dataset_item_id TEXT, source_golden_entry_id TEXT,
  input_digest TEXT NOT NULL CHECK(length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'),
  item_digest TEXT NOT NULL, payload_snapshot TEXT NOT NULL CHECK(json_valid(payload_snapshot) AND json_type(payload_snapshot)='object'),
  reference_label TEXT CHECK(reference_label IS NULL OR reference_label IN ('pass','fail')),
  reference_fail_step INTEGER CHECK(reference_fail_step IS NULL OR reference_fail_step>=0),
  reference_provenance TEXT NOT NULL CHECK(json_valid(reference_provenance) AND json_type(reference_provenance)='object'), note TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,revision_id,id), UNIQUE(revision_id,position),
  FOREIGN KEY(project_id,revision_id) REFERENCES dataset_revisions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX dataset_revision_input ON dataset_revision_items(project_id,input_digest);
CREATE TABLE dataset_exposure_events (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, revision_id TEXT NOT NULL, revision_item_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('created','legacy_pretracking','human_access','evaluator_execution','development_use','declassification','superseded','overlap_detected','exported')),
  exposure_class TEXT NOT NULL CHECK(exposure_class IN ('lineage','provenance','development')),
  activity TEXT NOT NULL CHECK(activity IN ('revision_create','legacy_import','content_view','export','analysis_authoring','criterion_authoring','rubric_authoring','prompt_tuning','example_selection','model_selection','development_run','final_validation_run','regression_run','declassify','supersede','exact_overlap')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('person','api_key','evaluator_version','activity','system')),
  subject_id TEXT, actor_user_id TEXT, evidence_ref_kind TEXT, evidence_ref_id TEXT, reason TEXT,
  details TEXT NOT NULL CHECK(json_valid(details) AND json_type(details)='object'), idempotency_key TEXT NOT NULL, occurred_at TEXT NOT NULL,
  UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,revision_id) REFERENCES dataset_revisions(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,revision_id,revision_item_id) REFERENCES dataset_revision_items(project_id,revision_id,id)
) STRICT;
CREATE TABLE dataset_revision_finalizations (
  revision_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
  UNIQUE(project_id,revision_id),
  FOREIGN KEY(project_id,revision_id) REFERENCES dataset_revisions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE criterion_regression_revisions (
  project_id TEXT NOT NULL, criterion_version_id TEXT NOT NULL, revision_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,criterion_version_id),
  FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,revision_id) REFERENCES dataset_revisions(project_id,id)
) STRICT;
CREATE TRIGGER dataset_revision_stage BEFORE INSERT ON dataset_revisions WHEN NEW.role NOT IN ('analysis_authoring','iterative_development') OR NEW.source_kind<>'collection_snapshot' OR NEW.analysis_population_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'governed dataset revision workflow unavailable at this stage'); END;
CREATE TRIGGER dataset_revision_owner BEFORE INSERT ON dataset_revisions
BEGIN
  SELECT CASE WHEN NEW.source_dataset_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM datasets WHERE project_id=NEW.project_id AND id=NEW.source_dataset_id) THEN RAISE(ABORT,'revision source dataset ownership mismatch') END;
  SELECT CASE WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revisions WHERE project_id=NEW.project_id AND id=NEW.parent_revision_id AND series_id=NEW.series_id AND revision_number=NEW.revision_number-1) THEN RAISE(ABORT,'revision predecessor mismatch') END;
  SELECT CASE WHEN (NEW.role='regression_golden')<>(NEW.source_kind='golden_snapshot') THEN RAISE(ABORT,'regression revision source mismatch') END;
END;
CREATE TRIGGER dataset_revision_item_owner BEFORE INSERT ON dataset_revision_items
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_finalizations WHERE revision_id=NEW.revision_id) THEN RAISE(ABORT,'immutable finalized revision') END;
  SELECT CASE WHEN sqlite_dataset_item_valid(NEW.input_digest,NEW.item_digest,NEW.payload_snapshot,NEW.reference_label,NEW.reference_fail_step,NEW.reference_provenance,NEW.note)=0 THEN RAISE(ABORT,'dataset item digest mismatch') END;
  SELECT CASE WHEN NEW.source_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cases WHERE project_id=NEW.project_id AND id=NEW.source_case_id AND sqlite_dataset_payload_equal(normalized_payload,NEW.payload_snapshot)=1) THEN RAISE(ABORT,'dataset item source snapshot mismatch') END;
  SELECT CASE WHEN NEW.source_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM case_input_identity_records WHERE project_id=NEW.project_id AND source_case_id=NEW.source_case_id AND input_digest=NEW.input_digest) THEN RAISE(ABORT,'dataset item input identity mismatch') END;
  SELECT CASE WHEN NEW.source_dataset_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_items d JOIN dataset_revisions r ON r.source_dataset_id=d.dataset_id AND r.project_id=d.project_id WHERE r.id=NEW.revision_id AND d.id=NEW.source_dataset_item_id AND d.project_id=NEW.project_id AND d.case_id=NEW.source_case_id) THEN RAISE(ABORT,'dataset item source membership mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_items i JOIN dataset_revisions r ON r.id=i.revision_id JOIN dataset_revisions target ON target.id=NEW.revision_id WHERE i.project_id=NEW.project_id AND i.input_digest=NEW.input_digest AND (r.role='sealed_validation')<>(target.role='sealed_validation')) THEN RAISE(ABORT,'sealed input overlap requires governed declassification') END;
END;
CREATE TRIGGER dataset_revision_finalize BEFORE INSERT ON dataset_revision_finalizations
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revisions r WHERE r.project_id=NEW.project_id AND r.id=NEW.revision_id AND r.item_count=(SELECT count(*) FROM dataset_revision_items WHERE revision_id=r.id)
    AND sqlite_dataset_content_digest((SELECT json_group_array(item_digest) FROM dataset_revision_items WHERE revision_id=r.id))=r.content_digest
    AND sqlite_dataset_revision_digest(r.role,(SELECT json_group_array(item_digest) FROM dataset_revision_items WHERE revision_id=r.id))=r.revision_digest
    AND (r.item_count=0 OR r.item_count=(SELECT max(position)+1 FROM dataset_revision_items WHERE revision_id=r.id))) THEN RAISE(ABORT,'dataset revision bundle mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE project_id=NEW.project_id AND revision_id=NEW.revision_id AND kind='created' AND exposure_class='lineage' AND activity='revision_create') THEN RAISE(ABORT,'dataset revision creation exposure required') END;
END;

CREATE TRIGGER dataset_revisions_immutable BEFORE UPDATE ON dataset_revisions BEGIN SELECT RAISE(ABORT,'immutable dataset evidence'); END;
CREATE TRIGGER dataset_revisions_no_delete BEFORE DELETE ON dataset_revisions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'dataset evidence deletion requires project erasure'); END;

CREATE TRIGGER dataset_revision_items_immutable BEFORE UPDATE ON dataset_revision_items BEGIN SELECT RAISE(ABORT,'immutable dataset evidence'); END;
CREATE TRIGGER dataset_revision_items_no_delete BEFORE DELETE ON dataset_revision_items WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'dataset evidence deletion requires project erasure'); END;

CREATE TRIGGER dataset_exposure_events_immutable BEFORE UPDATE ON dataset_exposure_events BEGIN SELECT RAISE(ABORT,'immutable dataset evidence'); END;
CREATE TRIGGER dataset_exposure_events_no_delete BEFORE DELETE ON dataset_exposure_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'dataset evidence deletion requires project erasure'); END;

CREATE TRIGGER dataset_revision_finalizations_immutable BEFORE UPDATE ON dataset_revision_finalizations BEGIN SELECT RAISE(ABORT,'immutable dataset evidence'); END;
CREATE TRIGGER dataset_revision_finalizations_no_delete BEFORE DELETE ON dataset_revision_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'dataset evidence deletion requires project erasure'); END;
CREATE TRIGGER revision_bound_case_payload_immutable BEFORE UPDATE OF normalized_payload ON cases WHEN
  EXISTS(SELECT 1 FROM dataset_revision_items WHERE project_id=OLD.project_id AND source_case_id=OLD.id)
  AND sqlite_json_equal(NEW.normalized_payload,OLD.normalized_payload)=0
BEGIN SELECT RAISE(ABORT,'revision-bound case payload is immutable'); END;
CREATE UNIQUE INDEX criterion_regression_revision_unique ON criterion_regression_revisions(revision_id);
CREATE TRIGGER criterion_regression_pointer_insert BEFORE INSERT ON criterion_regression_revisions WHEN NOT EXISTS(
  SELECT 1 FROM dataset_revisions WHERE project_id=NEW.project_id AND id=NEW.revision_id AND role='regression_golden' AND criterion_version_id=NEW.criterion_version_id)
BEGIN SELECT RAISE(ABORT,'criterion regression revision mismatch'); END;
CREATE TRIGGER criterion_regression_pointer_update BEFORE UPDATE ON criterion_regression_revisions WHEN NOT EXISTS(
  SELECT 1 FROM dataset_revisions WHERE project_id=NEW.project_id AND id=NEW.revision_id AND role='regression_golden' AND criterion_version_id=NEW.criterion_version_id)
BEGIN SELECT RAISE(ABORT,'criterion regression revision mismatch'); END;

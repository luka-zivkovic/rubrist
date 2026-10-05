CREATE TABLE golden_set_entries (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 case_id TEXT NOT NULL,trace_id TEXT NOT NULL,agreed_label TEXT NOT NULL CHECK(agreed_label IN ('pass','fail')),
 reason TEXT NOT NULL,promoted_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,promoted_by TEXT NOT NULL,
 source_skill_version_id TEXT NOT NULL,criterion_version_id TEXT NOT NULL,promoted_at TEXT NOT NULL,retired_at TEXT,
 FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,source_skill_version_id) REFERENCES skill_versions(project_id,id),
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id)
) STRICT;
CREATE UNIQUE INDEX golden_active_case ON golden_set_entries(project_id,criterion_version_id,case_id) WHERE retired_at IS NULL;
CREATE TRIGGER golden_owner_insert BEFORE INSERT ON golden_set_entries WHEN NOT EXISTS(SELECT 1 FROM skill_versions WHERE project_id=NEW.project_id AND id=NEW.source_skill_version_id AND criterion_version_id=NEW.criterion_version_id) BEGIN SELECT RAISE(ABORT,'golden criterion binding mismatch'); END;
CREATE TRIGGER golden_owner_update BEFORE UPDATE ON golden_set_entries WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.case_id<>OLD.case_id OR NEW.criterion_version_id<>OLD.criterion_version_id OR NOT EXISTS(SELECT 1 FROM skill_versions WHERE project_id=NEW.project_id AND id=NEW.source_skill_version_id AND criterion_version_id=NEW.criterion_version_id) BEGIN SELECT RAISE(ABORT,'golden criterion binding mismatch'); END;
DROP TRIGGER dataset_revision_stage;
CREATE TRIGGER dataset_revision_stage BEFORE INSERT ON dataset_revisions WHEN NEW.analysis_population_id IS NOT NULL OR NOT(
 (NEW.role IN ('analysis_authoring','iterative_development') AND NEW.source_kind='collection_snapshot') OR (NEW.role='regression_golden' AND NEW.source_kind='golden_snapshot'))
BEGIN SELECT RAISE(ABORT,'governed dataset revision workflow unavailable at this stage'); END;
CREATE TRIGGER dataset_golden_item_owner BEFORE INSERT ON dataset_revision_items WHEN NEW.source_golden_entry_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM golden_set_entries g JOIN dataset_revisions r ON r.project_id=g.project_id AND r.criterion_version_id=g.criterion_version_id
 WHERE g.project_id=NEW.project_id AND g.id=NEW.source_golden_entry_id AND g.case_id=NEW.source_case_id AND g.agreed_label=NEW.reference_label AND g.retired_at IS NULL AND r.id=NEW.revision_id AND r.role='regression_golden')
BEGIN SELECT RAISE(ABORT,'golden snapshot source mismatch'); END;
CREATE TRIGGER dataset_golden_finalize BEFORE INSERT ON dataset_revision_finalizations WHEN EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND role='regression_golden') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_items WHERE revision_id=NEW.revision_id AND (source_golden_entry_id IS NULL OR reference_label IS NULL)) THEN RAISE(ABORT,'golden revision requires registry references') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE revision_id=NEW.revision_id AND kind='legacy_pretracking' AND exposure_class='development' AND activity='legacy_import') THEN RAISE(ABORT,'golden revision requires visible exposure') END;
END;

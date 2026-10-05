CREATE TABLE trace_tests (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 source_case_id TEXT REFERENCES cases(id) ON DELETE SET NULL,source_case_ref TEXT NOT NULL,source_trace_ref TEXT NOT NULL,
 source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot)),source_scope TEXT NOT NULL CHECK(json_valid(source_scope)),
 current_revision INTEGER NOT NULL CHECK(current_revision>0),enabled_revision INTEGER CHECK(enabled_revision>0),
 created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id,id,current_revision) REFERENCES trace_test_revisions(project_id,trace_test_id,revision) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,id,enabled_revision) REFERENCES trace_test_revisions(project_id,trace_test_id,revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE trace_test_revisions (
 id TEXT PRIMARY KEY NOT NULL,trace_test_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft','enabled')),desired_behavior TEXT NOT NULL,scenario TEXT NOT NULL,expected_behavior TEXT NOT NULL,
 must_do TEXT NOT NULL CHECK(json_valid(must_do)),must_avoid TEXT NOT NULL CHECK(json_valid(must_avoid)),
 good_example TEXT NOT NULL CHECK(json_valid(good_example)),bad_example TEXT NOT NULL CHECK(json_valid(bad_example)),
 checker TEXT NOT NULL CHECK(json_valid(checker)),draft_provenance TEXT NOT NULL CHECK(json_valid(draft_provenance)),
 validation_id TEXT,validated_revision INTEGER,created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 reviewed_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,created_at TEXT NOT NULL,reviewed_at TEXT,
 UNIQUE(project_id,trace_test_id,revision),
 FOREIGN KEY(project_id,trace_test_id) REFERENCES trace_tests(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,trace_test_id,validated_revision,validation_id) REFERENCES trace_test_validations(project_id,trace_test_id,revision,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((lifecycle='draft' AND validation_id IS NULL AND validated_revision IS NULL AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR
 (lifecycle='enabled' AND validation_id IS NOT NULL AND validated_revision IS NOT NULL AND reviewed_at IS NOT NULL))
) STRICT;
CREATE TABLE trace_test_validations (
 id TEXT PRIMARY KEY NOT NULL,trace_test_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('passed','failed','non_discriminating','ambiguous','evaluator_error','unavailable','needs_review','could_not_run')),
 bad_evidence TEXT NOT NULL CHECK(json_valid(bad_evidence)),good_evidence TEXT NOT NULL CHECK(json_valid(good_evidence)),
 recorded_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,created_at TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('automated','manual_override')),
 diagnostic TEXT CHECK(diagnostic IN ('always_pass','always_fail','reversed','ambiguous','evaluator_error','unavailable')),
 evaluator TEXT CHECK(evaluator IS NULL OR json_valid(evaluator)),override_reason TEXT,
 UNIQUE(project_id,trace_test_id,revision,id),
 FOREIGN KEY(project_id,trace_test_id,revision) REFERENCES trace_test_revisions(project_id,trace_test_id,revision) ON DELETE CASCADE,
 CHECK((method='automated' AND override_reason IS NULL) OR(method='manual_override' AND override_reason IS NOT NULL AND length(trim(override_reason))>=10))
) STRICT;
CREATE INDEX trace_tests_updated ON trace_tests(project_id,updated_at DESC,id DESC);
CREATE INDEX trace_tests_source ON trace_tests(project_id,source_case_ref,updated_at DESC);
CREATE INDEX trace_validations_history ON trace_test_validations(project_id,trace_test_id,created_at,id);
CREATE UNIQUE INDEX audit_trace_test_funnel ON audit_logs(project_id,target_id,action) WHERE target_type='trace_test_funnel';
CREATE TRIGGER trace_test_source_owner BEFORE INSERT ON trace_tests WHEN NOT EXISTS(SELECT 1 FROM cases WHERE project_id=NEW.project_id AND id=NEW.source_case_id)
BEGIN SELECT RAISE(ABORT,'trace test source ownership mismatch'); END;
CREATE TRIGGER trace_test_identity BEFORE UPDATE ON trace_tests WHEN
 NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.source_case_ref<>OLD.source_case_ref OR NEW.source_trace_ref<>OLD.source_trace_ref OR
 NEW.source_snapshot<>OLD.source_snapshot OR NEW.source_scope<>OLD.source_scope OR NEW.created_at<>OLD.created_at OR
 (NEW.source_case_id IS NOT OLD.source_case_id AND (NEW.source_case_id IS NOT NULL OR EXISTS(SELECT 1 FROM cases WHERE id=OLD.source_case_id)))
BEGIN SELECT RAISE(ABORT,'immutable trace test source'); END;
CREATE TRIGGER trace_test_revision_immutable BEFORE UPDATE ON trace_test_revisions WHEN
 NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.trace_test_id<>OLD.trace_test_id OR NEW.revision<>OLD.revision OR
 NEW.lifecycle<>OLD.lifecycle OR NEW.desired_behavior<>OLD.desired_behavior OR NEW.scenario<>OLD.scenario OR NEW.expected_behavior<>OLD.expected_behavior OR
 NEW.must_do<>OLD.must_do OR NEW.must_avoid<>OLD.must_avoid OR NEW.good_example<>OLD.good_example OR NEW.bad_example<>OLD.bad_example OR
 NEW.checker<>OLD.checker OR NEW.draft_provenance<>OLD.draft_provenance OR NEW.validation_id IS NOT OLD.validation_id OR NEW.validated_revision IS NOT OLD.validated_revision OR
 NEW.created_at<>OLD.created_at OR NEW.reviewed_at IS NOT OLD.reviewed_at OR
 (NEW.created_by_user_id IS NOT OLD.created_by_user_id AND (NEW.created_by_user_id IS NOT NULL OR EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))) OR
 (NEW.reviewed_by_user_id IS NOT OLD.reviewed_by_user_id AND (NEW.reviewed_by_user_id IS NOT NULL OR EXISTS(SELECT 1 FROM "user" WHERE id=OLD.reviewed_by_user_id)))
BEGIN SELECT RAISE(ABORT,'immutable trace test revision'); END;
CREATE TRIGGER trace_test_validation_immutable BEFORE UPDATE ON trace_test_validations WHEN
 NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.trace_test_id<>OLD.trace_test_id OR NEW.revision<>OLD.revision OR NEW.status<>OLD.status OR
 NEW.bad_evidence<>OLD.bad_evidence OR NEW.good_evidence<>OLD.good_evidence OR NEW.created_at<>OLD.created_at OR NEW.method<>OLD.method OR
 NEW.diagnostic IS NOT OLD.diagnostic OR NEW.evaluator IS NOT OLD.evaluator OR NEW.override_reason IS NOT OLD.override_reason OR
 (NEW.recorded_by_user_id IS NOT OLD.recorded_by_user_id AND (NEW.recorded_by_user_id IS NOT NULL OR EXISTS(SELECT 1 FROM "user" WHERE id=OLD.recorded_by_user_id)))
BEGIN SELECT RAISE(ABORT,'immutable trace test validation'); END;
CREATE TRIGGER trace_test_revision_erasure BEFORE DELETE ON trace_test_revisions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'trace test history requires project erasure'); END;
CREATE TRIGGER trace_test_validation_erasure BEFORE DELETE ON trace_test_validations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'trace test history requires project erasure'); END;
ALTER TABLE eval_runs ADD COLUMN source_trace_test_id TEXT REFERENCES trace_tests(id);
ALTER TABLE eval_runs ADD COLUMN source_trace_test_revision INTEGER;
ALTER TABLE eval_runs ADD COLUMN source_trace_test_validation_id TEXT REFERENCES trace_test_validations(id);
ALTER TABLE eval_runs ADD COLUMN source_trace_test_validation_revision INTEGER;
ALTER TABLE eval_runs ADD COLUMN source_trace_test_case_ref TEXT;
ALTER TABLE eval_runs ADD COLUMN source_trace_test_case_id TEXT;
ALTER TABLE eval_runs ADD COLUMN source_trace_test_dataset_item_id TEXT;
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

CREATE TRIGGER trace_test_reviewed_insert BEFORE INSERT ON trace_test_revisions WHEN NEW.lifecycle='enabled' AND NEW.reviewed_by_user_id IS NULL
BEGIN SELECT RAISE(ABORT,'enabled revision requires reviewer'); END;

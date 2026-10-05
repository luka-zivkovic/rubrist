-- Attempt ownership is operational; one immutable outcome belongs to a version.
CREATE TABLE regression_runs (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,skill_version_id TEXT NOT NULL,criterion_version_id TEXT NOT NULL,dataset_revision_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('passed','blocked','overridden','error')),
 compared INTEGER NOT NULL CHECK(compared>=0),regressed INTEGER NOT NULL CHECK(regressed>=0 AND regressed<=compared),improved INTEGER NOT NULL CHECK(improved>=0 AND improved<=compared),flipped INTEGER NOT NULL CHECK(flipped>=0 AND flipped<=compared),
 override_reason TEXT,override_actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 golden_set_missing INTEGER NOT NULL CHECK(golden_set_missing IN (0,1)),cases TEXT NOT NULL CHECK(json_valid(cases) AND json_type(cases)='array'),error_message TEXT,created_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(project_id,skill_version_id),
 CHECK((status='error')=(error_message IS NOT NULL)),
 FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id)
) STRICT;
CREATE TABLE regression_gate_attempts (
 project_id TEXT NOT NULL,skill_version_id TEXT NOT NULL,dataset_revision_id TEXT NOT NULL,
 epoch INTEGER NOT NULL CHECK(epoch>0),token TEXT,lease_until INTEGER,provider_started_at INTEGER,
 uncertain_epochs INTEGER NOT NULL DEFAULT 0 CHECK(uncertain_epochs>=0),
 PRIMARY KEY(project_id,skill_version_id),CHECK((token IS NULL)=(lease_until IS NULL)),
 FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER regression_run_binding BEFORE INSERT ON regression_runs WHEN NOT EXISTS(
 SELECT 1 FROM skill_versions s JOIN dataset_revisions d ON d.project_id=s.project_id AND d.id=s.regression_dataset_revision_id
 JOIN dataset_revision_finalizations f ON f.project_id=d.project_id AND f.revision_id=d.id
 WHERE s.project_id=NEW.project_id AND s.id=NEW.skill_version_id AND s.status='calibrating' AND s.criterion_version_id=NEW.criterion_version_id
 AND d.id=NEW.dataset_revision_id AND d.role='regression_golden' AND d.criterion_version_id=NEW.criterion_version_id)
BEGIN SELECT RAISE(ABORT,'regression outcome binding mismatch'); END;
CREATE TRIGGER regression_run_immutable BEFORE UPDATE ON regression_runs WHEN
 NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.skill_version_id IS NOT OLD.skill_version_id OR NEW.criterion_version_id IS NOT OLD.criterion_version_id OR NEW.dataset_revision_id IS NOT OLD.dataset_revision_id OR
 NEW.status IS NOT OLD.status OR NEW.compared IS NOT OLD.compared OR NEW.regressed IS NOT OLD.regressed OR NEW.improved IS NOT OLD.improved OR NEW.flipped IS NOT OLD.flipped OR NEW.override_reason IS NOT OLD.override_reason OR
 NEW.golden_set_missing IS NOT OLD.golden_set_missing OR NEW.cases IS NOT OLD.cases OR NEW.error_message IS NOT OLD.error_message OR NEW.created_at IS NOT OLD.created_at OR
 (NEW.override_actor_user_id IS NOT OLD.override_actor_user_id AND NOT(NEW.override_actor_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.override_actor_user_id)))
BEGIN SELECT RAISE(ABORT,'immutable regression outcome'); END;
CREATE TRIGGER regression_run_no_delete BEFORE DELETE ON regression_runs WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'regression outcome deletion requires project erasure'); END;
CREATE TRIGGER regression_status_transition BEFORE UPDATE OF status ON skill_versions WHEN OLD.status='calibrating' AND NEW.status<>OLD.status AND NOT EXISTS(
 SELECT 1 FROM regression_runs r WHERE r.project_id=NEW.project_id AND r.skill_version_id=NEW.id AND
 NEW.status=CASE r.status WHEN 'error' THEN 'failed' WHEN 'blocked' THEN 'regressing' ELSE 'approved' END)
BEGIN SELECT RAISE(ABORT,'evaluator status requires regression outcome'); END;
CREATE TRIGGER regression_attempt_binding BEFORE INSERT ON regression_gate_attempts WHEN NOT EXISTS(
 SELECT 1 FROM skill_versions WHERE project_id=NEW.project_id AND id=NEW.skill_version_id AND regression_dataset_revision_id=NEW.dataset_revision_id AND status='calibrating')
BEGIN SELECT RAISE(ABORT,'regression attempt binding mismatch'); END;
CREATE TRIGGER regression_attempt_identity BEFORE UPDATE ON regression_gate_attempts WHEN NEW.project_id IS NOT OLD.project_id OR NEW.skill_version_id IS NOT OLD.skill_version_id OR NEW.dataset_revision_id IS NOT OLD.dataset_revision_id
BEGIN SELECT RAISE(ABORT,'immutable regression attempt binding'); END;
CREATE TRIGGER regression_exposure_binding BEFORE INSERT ON dataset_exposure_events WHEN NEW.evidence_ref_kind='regression_run' AND NOT EXISTS(
 SELECT 1 FROM regression_runs r WHERE r.project_id=NEW.project_id AND r.id=NEW.evidence_ref_id AND r.dataset_revision_id=NEW.revision_id AND r.skill_version_id=NEW.subject_id
 AND NEW.kind='evaluator_execution' AND NEW.exposure_class='development' AND NEW.activity='regression_run' AND NEW.subject_kind='evaluator_version')
BEGIN SELECT RAISE(ABORT,'regression exposure binding mismatch'); END;

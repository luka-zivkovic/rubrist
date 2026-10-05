-- Native evaluator edits bind a finalized regression snapshot before dispatch.
ALTER TABLE skill_versions ADD COLUMN onboarding_idempotency_key TEXT;
ALTER TABLE skill_versions ADD COLUMN onboarding_request_digest TEXT;
CREATE UNIQUE INDEX skill_version_onboarding_request ON skill_versions(project_id,skill_id,onboarding_idempotency_key) WHERE onboarding_idempotency_key IS NOT NULL;
DROP TRIGGER skill_version_regression_insert;
DROP TRIGGER skill_version_regression_update;
CREATE TRIGGER skill_version_regression_insert BEFORE INSERT ON skill_versions WHEN NEW.regression_dataset_revision_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM dataset_revisions r JOIN dataset_revision_finalizations f ON f.project_id=r.project_id AND f.revision_id=r.id
 WHERE r.project_id=NEW.project_id AND r.id=NEW.regression_dataset_revision_id AND r.role='regression_golden' AND r.criterion_version_id=NEW.criterion_version_id)
BEGIN SELECT RAISE(ABORT,'evaluator regression revision mismatch'); END;
CREATE TRIGGER skill_version_regression_update BEFORE UPDATE OF regression_dataset_revision_id ON skill_versions WHEN NEW.regression_dataset_revision_id IS NOT OLD.regression_dataset_revision_id
BEGIN SELECT RAISE(ABORT,'immutable evaluator regression revision'); END;
CREATE TRIGGER skill_version_onboarding_insert BEFORE INSERT ON skill_versions WHEN
 (NEW.onboarding_idempotency_key IS NULL)<>(NEW.onboarding_request_digest IS NULL) OR
 (NEW.onboarding_idempotency_key IS NOT NULL AND (length(NEW.onboarding_idempotency_key) NOT BETWEEN 1 AND 240 OR NEW.onboarding_idempotency_key<>trim(NEW.onboarding_idempotency_key))) OR
 (NEW.onboarding_request_digest IS NOT NULL AND (length(NEW.onboarding_request_digest)<>71 OR substr(NEW.onboarding_request_digest,1,7)<>'sha256:' OR substr(NEW.onboarding_request_digest,8) GLOB '*[^0-9a-f]*'))
BEGIN SELECT RAISE(ABORT,'invalid onboarding request'); END;
CREATE TRIGGER skill_version_onboarding_immutable BEFORE UPDATE ON skill_versions WHEN
 NEW.onboarding_idempotency_key IS NOT OLD.onboarding_idempotency_key OR NEW.onboarding_request_digest IS NOT OLD.onboarding_request_digest OR NEW.onboarding_assurance IS NOT OLD.onboarding_assurance
BEGIN SELECT RAISE(ABORT,'immutable evaluator onboarding identity'); END;

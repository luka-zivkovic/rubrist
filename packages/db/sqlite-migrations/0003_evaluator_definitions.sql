-- Native evaluator authoring. Governed analysis-derived execution remains
-- forbidden until the complete lifecycle port is implemented.
CREATE TABLE criteria (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL CHECK(length(stable_key)>0 AND stable_key=trim(stable_key)),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('native','analysis_promotion')),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,stable_key)
) STRICT;
CREATE TABLE criterion_versions (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  name TEXT NOT NULL CHECK(length(name)>0 AND name=trim(name)),
  definition TEXT NOT NULL CHECK(length(definition)>0 AND definition=trim(definition)),
  criterion_digest TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('native','analysis_promotion')),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,criterion_id,id), UNIQUE(criterion_id,revision),
  FOREIGN KEY(project_id,criterion_id) REFERENCES criteria(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE governed_reviewer_subjects (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  subject_digest TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,account_user_id)
) STRICT;
CREATE TABLE skills (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, criterion_id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL,
  owner_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  status TEXT NOT NULL, is_starter INTEGER NOT NULL DEFAULT 0 CHECK(is_starter IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,id,criterion_id),
  FOREIGN KEY(project_id,criterion_id) REFERENCES criteria(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
  skill_id TEXT NOT NULL, criterion_id TEXT NOT NULL, criterion_version_id TEXT NOT NULL,
  version TEXT NOT NULL, status TEXT NOT NULL,
  rubric_markdown TEXT, prompt TEXT, typed_question TEXT CHECK(typed_question IS NULL OR json_valid(typed_question)),
  decision_threshold REAL, output_schema TEXT NOT NULL CHECK(json_valid(output_schema)),
  execution_binding TEXT NOT NULL CHECK(json_valid(execution_binding)), custom_endpoint_url TEXT,
  golden_set_agreement REAL, too_strict_count INTEGER NOT NULL DEFAULT 0,
  too_lenient_count INTEGER NOT NULL DEFAULT 0, ambiguous_count INTEGER NOT NULL DEFAULT 0,
  known_limitations TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(known_limitations) AND json_type(known_limitations)='array'),
  verdict_kind TEXT NOT NULL CHECK(verdict_kind IN ('binary','scalar','categorical')),
  scalar_range TEXT CHECK(scalar_range IS NULL OR json_valid(scalar_range)),
  categorical_choice_scores TEXT CHECK(categorical_choice_scores IS NULL OR json_valid(categorical_choice_scores)),
  rubric_provenance TEXT NOT NULL CHECK(rubric_provenance IN ('human-authored','agent-drafted','unspecified')),
  rubric_provenance_declared INTEGER NOT NULL CHECK(rubric_provenance_declared IN (0,1)),
  regression_dataset_revision_id TEXT,
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_by_subject_id TEXT, developer_identity_status TEXT NOT NULL CHECK(developer_identity_status IN ('recorded','unknown_legacy')),
  onboarding_assurance TEXT CHECK(onboarding_assurance IS NULL OR onboarding_assurance='starter_unvalidated'),
  created_at TEXT NOT NULL, approved_at TEXT,
  UNIQUE(project_id,id), UNIQUE(skill_id,version),
  FOREIGN KEY(project_id,skill_id,criterion_id) REFERENCES skills(project_id,id,criterion_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,criterion_id,criterion_version_id) REFERENCES criterion_versions(project_id,criterion_id,id),
  FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
  CHECK((developer_identity_status='recorded')=(created_by_subject_id IS NOT NULL)),
  CHECK(regression_dataset_revision_id IS NOT NULL OR status IN ('draft','approved'))
) STRICT;
CREATE TABLE evaluator_execution_authorizations (
  id TEXT PRIMARY KEY NOT NULL, contract_version TEXT NOT NULL CHECK(contract_version='rubrist/evaluator-execution-authorization/v1'),
  project_id TEXT NOT NULL, skill_version_id TEXT NOT NULL,
  execution_context TEXT NOT NULL CHECK(execution_context IN ('implicit_production','manual_import','scheduled_import','suite_publication','trace_test','release_gate','explicit_nonproduction_dataset','governed_nonsealed_evaluation','binary_calibration_evidence','candidate_regression_evidence')),
  lifecycle_event_id TEXT CHECK(lifecycle_event_id IS NULL),
  calibration_artifact_id TEXT CHECK(calibration_artifact_id IS NULL),
  resource_kind TEXT NOT NULL CHECK(length(resource_kind) BETWEEN 1 AND 120),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 4096),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 240),
  content_digest TEXT NOT NULL, authorized_at TEXT NOT NULL,
  UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER criterion_identity_immutable BEFORE UPDATE ON criteria WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.stable_key<>OLD.stable_key OR
  NEW.source_kind<>OLD.source_kind OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable criterion identity'); END;
CREATE TRIGGER criterion_version_validate BEFORE INSERT ON criterion_versions
BEGIN
  SELECT CASE WHEN NEW.criterion_digest<>sqlite_criterion_digest(NEW.criterion_id,NEW.id,NEW.name,NEW.definition)
    THEN RAISE(ABORT,'criterion digest mismatch') END;
END;
CREATE TRIGGER criterion_version_immutable BEFORE UPDATE ON criterion_versions WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.criterion_id<>OLD.criterion_id OR
  NEW.revision<>OLD.revision OR NEW.name<>OLD.name OR NEW.definition<>OLD.definition OR
  NEW.criterion_digest<>OLD.criterion_digest OR NEW.source_kind<>OLD.source_kind OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable criterion version'); END;
CREATE TRIGGER skill_version_validate BEFORE INSERT ON skill_versions
BEGIN
  SELECT CASE WHEN sqlite_skill_version_valid(NEW.id,NEW.skill_id,NEW.criterion_version_id,NEW.version,NEW.status,
    NEW.rubric_markdown,NEW.prompt,NEW.typed_question,NEW.decision_threshold,NEW.output_schema,NEW.execution_binding,
    NEW.custom_endpoint_url,NEW.verdict_kind,NEW.scalar_range,NEW.categorical_choice_scores)=0
    THEN RAISE(ABORT,'invalid evaluator definition') END;
END;
CREATE TRIGGER skill_version_identity_immutable BEFORE UPDATE ON skill_versions WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.skill_id<>OLD.skill_id OR NEW.criterion_id<>OLD.criterion_id OR
  NEW.criterion_version_id<>OLD.criterion_version_id OR NEW.version<>OLD.version OR
  NEW.rubric_markdown IS NOT OLD.rubric_markdown OR NEW.prompt IS NOT OLD.prompt OR
  NEW.typed_question IS NOT OLD.typed_question OR NEW.decision_threshold IS NOT OLD.decision_threshold OR
  NEW.output_schema<>OLD.output_schema OR NEW.execution_binding<>OLD.execution_binding OR
  NEW.custom_endpoint_url IS NOT OLD.custom_endpoint_url OR NEW.verdict_kind<>OLD.verdict_kind OR
  NEW.scalar_range IS NOT OLD.scalar_range OR NEW.categorical_choice_scores IS NOT OLD.categorical_choice_scores OR
  NEW.rubric_provenance<>OLD.rubric_provenance OR NEW.rubric_provenance_declared<>OLD.rubric_provenance_declared OR
  NEW.created_by_subject_id IS NOT OLD.created_by_subject_id OR NEW.developer_identity_status<>OLD.developer_identity_status OR
  NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable evaluator identity'); END;
CREATE TRIGGER execution_authorization_validate BEFORE INSERT ON evaluator_execution_authorizations
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skill_versions sv JOIN criteria c ON c.id=sv.criterion_id AND c.project_id=sv.project_id
    WHERE sv.id=NEW.skill_version_id AND sv.project_id=NEW.project_id AND c.source_kind='native')
    THEN RAISE(ABORT,'governed evaluator execution unavailable') END;
  SELECT CASE WHEN NEW.content_digest<>sqlite_execution_authorization_digest(NEW.project_id,NEW.skill_version_id,
    NEW.execution_context,NEW.resource_kind,NEW.resource_id)
    THEN RAISE(ABORT,'execution authorization digest mismatch') END;
END;
CREATE TRIGGER execution_authorization_immutable BEFORE UPDATE ON evaluator_execution_authorizations
BEGIN SELECT RAISE(ABORT,'immutable execution authorization'); END;
-- Do not admit incomplete governed bundles through direct writes while their
-- finalization/lifecycle tables are not yet implemented (Milestone 4).
CREATE TRIGGER criterion_native_stage BEFORE INSERT ON criteria WHEN NEW.source_kind<>'native'
BEGIN SELECT RAISE(ABORT,'governed criterion authoring unavailable'); END;
CREATE TRIGGER criterion_version_owner BEFORE INSERT ON criterion_versions WHEN NOT EXISTS(
  SELECT 1 FROM criteria WHERE id=NEW.criterion_id AND project_id=NEW.project_id AND source_kind=NEW.source_kind)
BEGIN SELECT RAISE(ABORT,'criterion definition source mismatch'); END;
CREATE TRIGGER skills_identity_immutable BEFORE UPDATE ON skills WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.criterion_id<>OLD.criterion_id
BEGIN SELECT RAISE(ABORT,'immutable evaluator criterion binding'); END;
CREATE TRIGGER skill_version_developer_insert BEFORE INSERT ON skill_versions
BEGIN
  SELECT CASE WHEN (NEW.developer_identity_status='unknown_legacy' AND NEW.created_by_user_id IS NOT NULL)
    OR (NEW.developer_identity_status='recorded' AND NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects
      WHERE id=NEW.created_by_subject_id AND project_id=NEW.project_id AND account_user_id=NEW.created_by_user_id))
    THEN RAISE(ABORT,'invalid evaluator developer identity') END;
END;
CREATE TRIGGER skill_version_account_immutable BEFORE UPDATE OF created_by_user_id ON skill_versions WHEN
  NEW.created_by_user_id IS NOT OLD.created_by_user_id AND NOT(NEW.created_by_user_id IS NULL AND
    NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))
BEGIN SELECT RAISE(ABORT,'immutable evaluator author account'); END;
CREATE TRIGGER subject_validate BEFORE INSERT ON governed_reviewer_subjects
BEGIN
  SELECT CASE WHEN NEW.subject_digest<>sqlite_subject_digest(NEW.project_id,NEW.id)
    THEN RAISE(ABORT,'reviewer subject digest mismatch') END;
END;
CREATE TRIGGER subject_identity_immutable BEFORE UPDATE ON governed_reviewer_subjects WHEN
  NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.subject_digest<>OLD.subject_digest OR NEW.created_at<>OLD.created_at OR
  (NEW.account_user_id IS NOT OLD.account_user_id AND NOT(NEW.account_user_id IS NULL AND
    NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.account_user_id)))
BEGIN SELECT RAISE(ABORT,'immutable reviewer subject'); END;
CREATE TRIGGER criterion_no_delete BEFORE DELETE ON criteria WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'criterion deletion requires project erasure'); END;
CREATE TRIGGER criterion_version_no_delete BEFORE DELETE ON criterion_versions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'criterion version deletion requires project erasure'); END;
CREATE TRIGGER skill_version_no_delete BEFORE DELETE ON skill_versions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'evaluator version deletion requires project erasure'); END;
CREATE TRIGGER subject_no_delete BEFORE DELETE ON governed_reviewer_subjects WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'reviewer subject deletion requires project erasure'); END;
CREATE TRIGGER execution_authorization_no_delete BEFORE DELETE ON evaluator_execution_authorizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'execution authorization deletion requires project erasure'); END;
CREATE TRIGGER criterion_author_immutable BEFORE UPDATE OF created_by_user_id ON criteria WHEN
  NEW.created_by_user_id IS NOT OLD.created_by_user_id AND NOT(NEW.created_by_user_id IS NULL AND
    NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))
BEGIN SELECT RAISE(ABORT,'immutable criterion author'); END;
CREATE TRIGGER criterion_version_author_immutable BEFORE UPDATE OF created_by_user_id ON criterion_versions WHEN
  NEW.created_by_user_id IS NOT OLD.created_by_user_id AND NOT(NEW.created_by_user_id IS NULL AND
    NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))
BEGIN SELECT RAISE(ABORT,'immutable criterion version author'); END;
-- Regression snapshots are ported separately. A text ID is not evidence of a
-- valid same-project, same-criterion regression binding.
CREATE TRIGGER skill_version_regression_insert BEFORE INSERT ON skill_versions WHEN NEW.regression_dataset_revision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'regression revision binding unavailable'); END;
CREATE TRIGGER skill_version_regression_update BEFORE UPDATE OF regression_dataset_revision_id ON skill_versions WHEN NEW.regression_dataset_revision_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'regression revision binding unavailable'); END;

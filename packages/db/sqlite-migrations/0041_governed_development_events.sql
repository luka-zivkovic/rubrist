CREATE TABLE governed_evaluator_development_events (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 criterion_version_id TEXT NOT NULL,skill_version_id TEXT NOT NULL,developer_subject_id TEXT NOT NULL,
 developer_role_at_recording TEXT NOT NULL CHECK(length(developer_role_at_recording)>0),
 activity_kind TEXT NOT NULL CHECK(activity_kind='evaluator_development'),
 source_kind TEXT NOT NULL CHECK(source_kind='system_recorded'),content_digest TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(project_id,id),UNIQUE(skill_version_id),
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id),
 FOREIGN KEY(project_id,developer_subject_id) REFERENCES governed_reviewer_subjects(project_id,id)
) STRICT;
-- SQLite permits NUL in text; the governed canonicalizer and PostgreSQL do not.
-- Reject incompatible legacy identity values before hashing or retaining them.
CREATE TEMP TABLE development_seed_check(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO development_seed_check SELECT NOT EXISTS(SELECT 1 FROM skill_versions
 WHERE developer_identity_status='recorded' AND (
 length(id)=0 OR instr(id,char(0))>0 OR length(criterion_version_id)=0 OR instr(criterion_version_id,char(0))>0
 OR created_by_subject_id IS NULL OR length(created_by_subject_id)=0 OR instr(created_by_subject_id,char(0))>0));
DROP TABLE development_seed_check;
-- The digest basis contains strings only, with literal UTF-16-sorted keys at
-- both object levels. json_object escapes each retained value without parsing
-- or reinterpreting it. Its bytes match governed-content-json/v1 for this basis.
INSERT INTO governed_evaluator_development_events
 SELECT 'grede_'||id,project_id,criterion_version_id,id,created_by_subject_id,
 'evaluator_developer','evaluator_development','system_recorded',
 sqlite_migration_sha256(CAST(json_object('content',json_object(
 'activityKind','evaluator_development','criterionVersionId',criterion_version_id,
 'developerRoleAtRecording','evaluator_developer','developerSubjectId',created_by_subject_id,
 'skillVersionId',id,'sourceKind','system_recorded'),
 'kind','governed-evaluator-development/v1') AS BLOB)),created_at
 FROM skill_versions WHERE developer_identity_status='recorded';
CREATE TRIGGER governed_development_event_insert BEFORE INSERT ON governed_evaluator_development_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'development evidence requires command time') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skill_versions v JOIN governed_reviewer_subjects s ON s.project_id=v.project_id AND s.id=v.created_by_subject_id WHERE v.id=NEW.skill_version_id AND v.project_id=NEW.project_id AND v.criterion_version_id=NEW.criterion_version_id AND v.created_by_subject_id=NEW.developer_subject_id AND v.developer_identity_status='recorded') THEN RAISE(ABORT,'development evidence must match recorded evaluator authorship') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-evaluator-development/v1',json_object('activityKind',NEW.activity_kind,'criterionVersionId',NEW.criterion_version_id,'developerRoleAtRecording',NEW.developer_role_at_recording,'developerSubjectId',NEW.developer_subject_id,'skillVersionId',NEW.skill_version_id,'sourceKind',NEW.source_kind)) THEN RAISE(ABORT,'development evidence digest mismatch') END;
END;
CREATE TRIGGER skill_version_development_event_append AFTER INSERT ON skill_versions WHEN NEW.developer_identity_status='recorded' BEGIN
 INSERT INTO governed_evaluator_development_events VALUES('grede_'||NEW.id,NEW.project_id,NEW.criterion_version_id,NEW.id,NEW.created_by_subject_id,'evaluator_developer','evaluator_development','system_recorded',governed_content_v1_digest('governed-evaluator-development/v1',json_object('activityKind','evaluator_development','criterionVersionId',NEW.criterion_version_id,'developerRoleAtRecording','evaluator_developer','developerSubjectId',NEW.created_by_subject_id,'skillVersionId',NEW.id,'sourceKind','system_recorded')),sqlite_command_time());
END;
CREATE TRIGGER governed_development_event_immutable BEFORE UPDATE ON governed_evaluator_development_events BEGIN SELECT RAISE(ABORT,'immutable development evidence'); END;
CREATE TRIGGER governed_development_event_erase BEFORE DELETE ON governed_evaluator_development_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'development evidence deletion requires project erasure'); END;

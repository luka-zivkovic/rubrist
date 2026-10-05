CREATE TABLE review_instruction_versions (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 criterion_version_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
 predecessor_instruction_version_id TEXT,title TEXT NOT NULL,instructions TEXT NOT NULL,
 allowed_labels TEXT NOT NULL CHECK(json_valid(allowed_labels)),failure_code_guidance TEXT NOT NULL,
 content_digest TEXT NOT NULL,created_by_subject_id TEXT,created_at TEXT NOT NULL,
 CHECK(length(title)>0 AND length(CAST(title AS BLOB))<=1024),
 CHECK(length(instructions)>0 AND length(CAST(instructions AS BLOB))<=262144),
 CHECK(length(CAST(failure_code_guidance AS BLOB))<=65536),
 UNIQUE(project_id,id),UNIQUE(project_id,criterion_version_id,revision),
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id),
 FOREIGN KEY(project_id,predecessor_instruction_version_id) REFERENCES review_instruction_versions(project_id,id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id)
) STRICT;
CREATE TRIGGER review_instruction_insert BEFORE INSERT ON review_instruction_versions BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'review instruction requires command time') END;
 SELECT CASE WHEN governed_canonical_json_v1(NEW.allowed_labels) IS NOT '["pass","fail","cannot_determine"]' THEN RAISE(ABORT,'review instruction allowed labels mismatch') END;
 SELECT CASE WHEN (NEW.predecessor_instruction_version_id IS NULL AND NEW.revision<>1)
 OR (NEW.predecessor_instruction_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM review_instruction_versions p WHERE p.id=NEW.predecessor_instruction_version_id AND p.project_id=NEW.project_id AND p.criterion_version_id=NEW.criterion_version_id AND p.revision+1=NEW.revision))
 THEN RAISE(ABORT,'review instruction requires exact predecessor lineage') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('review-instruction/v1',json_object('allowedLabels',json(NEW.allowed_labels),'criterionVersionId',NEW.criterion_version_id,'failureCodeGuidance',NEW.failure_code_guidance,'id',NEW.id,'instructions',NEW.instructions,'predecessorInstructionVersionId',NEW.predecessor_instruction_version_id,'revision',NEW.revision,'title',NEW.title)) THEN RAISE(ABORT,'review instruction content digest mismatch') END;
END;
CREATE TRIGGER review_instruction_immutable BEFORE UPDATE ON review_instruction_versions BEGIN SELECT RAISE(ABORT,'immutable governed review instruction'); END;
CREATE TRIGGER review_instruction_erase BEFORE DELETE ON review_instruction_versions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed review instruction deletion requires project erasure'); END;

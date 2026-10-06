CREATE TABLE review_queues (
  id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,description TEXT,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,created_at TEXT NOT NULL,closed_at TEXT,
  UNIQUE(project_id,id)
) STRICT;
CREATE TABLE review_queue_items (
  id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,queue_id TEXT NOT NULL,case_id TEXT NOT NULL,
  criterion_version_id TEXT NOT NULL,skill_version_id TEXT,judge_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  position INTEGER NOT NULL CHECK(position>=0),created_at TEXT NOT NULL,completed_at TEXT,
  assigned_to_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,assignment_key TEXT NOT NULL,
  FOREIGN KEY(project_id,queue_id) REFERENCES review_queues(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,judge_run_id) REFERENCES judge_runs(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((skill_version_id IS NULL)=(judge_run_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX review_queue_items_evidence_assignee_unique ON review_queue_items(queue_id,case_id,criterion_version_id,coalesce(judge_run_id,''),assignment_key);
CREATE INDEX review_queue_items_pending ON review_queue_items(queue_id,criterion_version_id,status,position);

-- Forward rebuild: preserve all M2 evaluator verdicts and their references.
-- migrateSqlite owns FK suppression and the transaction, verifies the full
-- graph before commit, and never exposes this connection to request work.
CREATE TABLE verdicts__new (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, case_id TEXT NOT NULL, skill_version_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('llm_judge','human','adjudicated','imported_external')),
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  verdict_kind TEXT NOT NULL CHECK(verdict_kind IN ('binary','scalar','categorical')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),external_run_id TEXT,
  created_at TEXT NOT NULL,observed TEXT CHECK(observed IS NULL OR (source='llm_judge' AND json_valid(observed) AND json_type(observed)='object')),
  evaluator_score TEXT CHECK(evaluator_score IS NULL OR (observed IS NOT NULL AND json_valid(evaluator_score) AND json_type(evaluator_score)='object')),
  review_queue_item_id TEXT REFERENCES review_queue_items(id) DEFERRABLE INITIALLY DEFERRED,
  reviewed_judge_run_id TEXT REFERENCES judge_runs(id) DEFERRABLE INITIALLY DEFERRED,
  review_submission_id TEXT CHECK(review_submission_id IS NULL OR (length(review_submission_id)=36 AND review_submission_id=lower(review_submission_id) AND substr(review_submission_id,9,1)='-' AND substr(review_submission_id,14,1)='-' AND substr(review_submission_id,19,1)='-' AND substr(review_submission_id,24,1)='-' AND length(replace(review_submission_id,'-',''))=32 AND replace(review_submission_id,'-','') NOT GLOB '*[^0-9a-f]*')),
  UNIQUE(project_id,id),UNIQUE(project_id,case_id,id),UNIQUE(review_queue_item_id,review_submission_id),
  FOREIGN KEY(project_id,case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE,
  CHECK(source NOT IN ('human','adjudicated') OR skill_version_id IS NOT NULL),
  CHECK(json_type(payload,'$.rationaleStatus') IS NULL OR (source='llm_judge' AND json_extract(payload,'$.kind')='binary' AND json_type(payload,'$.rationale') IS NULL)),
  CHECK((review_queue_item_id IS NULL AND reviewed_judge_run_id IS NULL AND review_submission_id IS NULL) OR
    (source='human' AND review_queue_item_id IS NOT NULL AND reviewed_judge_run_id IS NOT NULL AND review_submission_id IS NOT NULL))
) STRICT;
INSERT INTO verdicts__new(rowid,id,project_id,case_id,skill_version_id,source,actor_user_id,verdict_kind,payload,external_run_id,created_at,observed,evaluator_score)
SELECT rowid,id,project_id,case_id,skill_version_id,source,actor_user_id,verdict_kind,payload,external_run_id,created_at,observed,evaluator_score FROM verdicts;
CREATE TEMP TABLE verdict_copy_assert(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO verdict_copy_assert SELECT (SELECT count(*) FROM verdicts)=(SELECT count(*) FROM verdicts__new);
INSERT INTO verdict_copy_assert SELECT NOT EXISTS(SELECT rowid,id,project_id,case_id,skill_version_id,source,actor_user_id,verdict_kind,payload,external_run_id,created_at,observed,evaluator_score FROM verdicts EXCEPT SELECT rowid,id,project_id,case_id,skill_version_id,source,actor_user_id,verdict_kind,payload,external_run_id,created_at,observed,evaluator_score FROM verdicts__new);
DROP TABLE verdict_copy_assert;
DROP TRIGGER eval_item_verdict_insert;
DROP TRIGGER eval_item_verdict_update;
DROP TRIGGER verdict_immutable;
DROP TRIGGER verdict_no_delete;
DROP TABLE verdicts;
ALTER TABLE verdicts__new RENAME TO verdicts;
CREATE UNIQUE INDEX verdict_external_idempotency ON verdicts(project_id,external_run_id) WHERE source='imported_external' AND external_run_id IS NOT NULL;
CREATE TRIGGER eval_item_verdict_insert BEFORE INSERT ON eval_run_items WHEN NEW.verdict_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM verdicts v JOIN eval_runs r ON r.project_id=v.project_id AND r.skill_version_id=v.skill_version_id
  WHERE r.id=NEW.eval_run_id AND v.project_id=NEW.project_id AND v.case_id=NEW.case_id AND v.id=NEW.verdict_id)
BEGIN SELECT RAISE(ABORT,'eval verdict evaluator mismatch'); END;
CREATE TRIGGER eval_item_verdict_update BEFORE UPDATE OF verdict_id ON eval_run_items WHEN NEW.verdict_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM verdicts v JOIN eval_runs r ON r.project_id=v.project_id AND r.skill_version_id=v.skill_version_id
  WHERE r.id=NEW.eval_run_id AND v.project_id=NEW.project_id AND v.case_id=NEW.case_id AND v.id=NEW.verdict_id)
BEGIN SELECT RAISE(ABORT,'eval verdict evaluator mismatch'); END;
CREATE TRIGGER verdict_immutable BEFORE UPDATE ON verdicts WHEN NOT (
  OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.actor_user_id)
  AND NEW.sequence IS OLD.sequence AND NEW.id IS OLD.id AND NEW.project_id IS OLD.project_id AND NEW.case_id IS OLD.case_id AND NEW.skill_version_id IS OLD.skill_version_id
  AND NEW.source IS OLD.source AND NEW.verdict_kind IS OLD.verdict_kind AND NEW.payload IS OLD.payload AND NEW.external_run_id IS OLD.external_run_id
  AND NEW.created_at IS OLD.created_at AND NEW.observed IS OLD.observed AND NEW.evaluator_score IS OLD.evaluator_score
  AND NEW.review_queue_item_id IS OLD.review_queue_item_id AND NEW.reviewed_judge_run_id IS OLD.reviewed_judge_run_id AND NEW.review_submission_id IS OLD.review_submission_id)
BEGIN SELECT RAISE(ABORT,'immutable verdict'); END;
CREATE TRIGGER verdict_no_delete BEFORE DELETE ON verdicts WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
 AND (OLD.review_queue_item_id IS NOT NULL OR EXISTS(SELECT 1 FROM cases WHERE id=OLD.case_id))
BEGIN SELECT RAISE(ABORT,'verdict deletion requires project erasure'); END;
CREATE TRIGGER review_item_validate BEFORE INSERT ON review_queue_items BEGIN
 SELECT CASE WHEN NEW.assignment_key<>coalesce(NEW.assigned_to_user_id,'') THEN RAISE(ABORT,'review assignment identity mismatch') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skill_versions WHERE project_id=NEW.project_id AND criterion_version_id=NEW.criterion_version_id) THEN RAISE(ABORT,'review criterion has no evaluator') END;
 SELECT CASE WHEN NEW.judge_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM judge_runs r JOIN skill_versions v ON v.id=r.skill_version_id AND v.project_id=r.project_id WHERE r.project_id=NEW.project_id AND r.id=NEW.judge_run_id AND r.case_id=NEW.case_id AND r.skill_version_id=NEW.skill_version_id AND v.criterion_version_id=NEW.criterion_version_id) THEN RAISE(ABORT,'review evidence binding mismatch') END;
END;
CREATE TRIGGER review_item_identity BEFORE UPDATE ON review_queue_items WHEN
 NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.queue_id IS NOT OLD.queue_id OR NEW.case_id IS NOT OLD.case_id OR NEW.criterion_version_id IS NOT OLD.criterion_version_id OR NEW.skill_version_id IS NOT OLD.skill_version_id OR NEW.judge_run_id IS NOT OLD.judge_run_id OR NEW.assignment_key IS NOT OLD.assignment_key OR
 (NEW.assigned_to_user_id IS NOT OLD.assigned_to_user_id AND NOT(NEW.assigned_to_user_id IS NULL AND OLD.assigned_to_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.assigned_to_user_id)))
BEGIN SELECT RAISE(ABORT,'immutable review task evidence or assignment'); END;
CREATE TRIGGER review_item_no_delete BEFORE DELETE ON review_queue_items WHEN OLD.judge_run_id IS NOT NULL AND EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'pinned review task requires project erasure'); END;
CREATE TRIGGER review_queue_project BEFORE UPDATE OF project_id,id ON review_queues WHEN NEW.project_id<>OLD.project_id OR NEW.id<>OLD.id BEGIN SELECT RAISE(ABORT,'immutable review queue identity'); END;
CREATE TRIGGER review_queue_no_delete BEFORE DELETE ON review_queues WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) AND EXISTS(SELECT 1 FROM review_queue_items WHERE queue_id=OLD.id AND judge_run_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'pinned review queue requires project erasure'); END;
CREATE TRIGGER reviewed_judge_run_immutable BEFORE UPDATE ON judge_runs WHEN EXISTS(SELECT 1 FROM review_queue_items WHERE judge_run_id=OLD.id) OR EXISTS(SELECT 1 FROM verdicts WHERE reviewed_judge_run_id=OLD.id) BEGIN SELECT RAISE(ABORT,'immutable reviewed judge evidence'); END;
CREATE TRIGGER verdict_review_context BEFORE INSERT ON verdicts WHEN NEW.review_queue_item_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM review_queue_items i JOIN judge_runs r ON r.id=NEW.reviewed_judge_run_id JOIN skill_versions v ON v.id=r.skill_version_id
 WHERE i.id=NEW.review_queue_item_id AND i.project_id=NEW.project_id AND i.case_id=NEW.case_id AND r.project_id=NEW.project_id AND r.case_id=NEW.case_id AND r.skill_version_id=NEW.skill_version_id AND v.criterion_version_id=i.criterion_version_id
 AND(i.judge_run_id IS NULL OR(i.judge_run_id=r.id AND i.skill_version_id=r.skill_version_id)) AND(i.assigned_to_user_id IS NULL OR i.assigned_to_user_id=NEW.actor_user_id))
BEGIN SELECT RAISE(ABORT,'review attribution mismatch'); END;

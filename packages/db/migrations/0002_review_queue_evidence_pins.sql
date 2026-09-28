-- Preserve founder-hosted evidence; see ADR-0011's 2026-09-28 exception.
ALTER TABLE review_queue_items
  ADD COLUMN assignment_key text NOT NULL DEFAULT '',
  ADD COLUMN skill_version_id text REFERENCES skill_versions(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN judge_run_id text REFERENCES judge_runs(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT review_queue_pins_together CHECK ((skill_version_id IS NULL) = (judge_run_id IS NULL));
-- Stable dedup identity survives FK anonymization when an account is erased.
UPDATE review_queue_items SET assignment_key=coalesce(assigned_to_user_id,'');
DROP INDEX review_queue_items_queue_case_criterion_assignee_unique_idx;
CREATE UNIQUE INDEX review_queue_items_evidence_assignee_unique_idx
  ON review_queue_items(queue_id, case_id, criterion_version_id, judge_run_id, assignment_key) NULLS NOT DISTINCT;

CREATE FUNCTION guard_review_queue_evidence_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.judge_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM review_queues q JOIN projects p ON p.id=q.project_id WHERE q.id=OLD.queue_id) THEN
      RAISE EXCEPTION 'pinned review tasks cannot be deleted while their project exists' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.assignment_key := coalesce(NEW.assigned_to_user_id,'');
  ELSIF NEW.assignment_key IS DISTINCT FROM OLD.assignment_key THEN
    RAISE EXCEPTION 'review assignment identity is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
    AND NOT (NEW.assigned_to_user_id IS NULL AND OLD.assigned_to_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "user" WHERE id=OLD.assigned_to_user_id)) THEN
    NEW.assignment_key := coalesce(NEW.assigned_to_user_id,'');
  END IF;
  PERFORM 1 FROM review_queues WHERE id=NEW.queue_id FOR UPDATE;
  IF TG_OP='UPDATE' AND NEW.assigned_to_user_id IS DISTINCT FROM OLD.assigned_to_user_id
    AND (OLD.judge_run_id IS NOT NULL OR EXISTS (SELECT 1 FROM verdicts WHERE review_queue_item_id=OLD.id))
    AND NOT (NEW.assigned_to_user_id IS NULL AND OLD.assigned_to_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "user" WHERE id=OLD.assigned_to_user_id)) THEN
    RAISE EXCEPTION 'review task assignment is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.judge_run_id IS NOT NULL THEN
    PERFORM 1 FROM judge_runs WHERE id=NEW.judge_run_id FOR UPDATE;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.queue_id, NEW.case_id, NEW.criterion_version_id, NEW.skill_version_id, NEW.judge_run_id)
    IS DISTINCT FROM (OLD.queue_id, OLD.case_id, OLD.criterion_version_id, OLD.skill_version_id, OLD.judge_run_id) THEN
    RAISE EXCEPTION 'review task evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.judge_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM judge_runs run JOIN review_queues queue ON queue.id = NEW.queue_id
      JOIN skill_versions version ON version.id = run.skill_version_id AND version.project_id = run.project_id
    WHERE run.id = NEW.judge_run_id AND run.project_id = queue.project_id
      AND run.case_id = NEW.case_id AND run.skill_version_id = NEW.skill_version_id
      AND version.criterion_version_id = NEW.criterion_version_id
  ) THEN
    RAISE EXCEPTION 'review task evidence binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_queue_evidence_pin_guard BEFORE INSERT OR UPDATE OR DELETE ON review_queue_items
  FOR EACH ROW EXECUTE FUNCTION guard_review_queue_evidence_pin();

ALTER TABLE verdicts
  ADD COLUMN review_queue_item_id text REFERENCES review_queue_items(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN reviewed_judge_run_id text REFERENCES judge_runs(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN review_submission_id uuid,
  ADD CONSTRAINT verdict_review_context_complete CHECK (
    (review_queue_item_id IS NULL AND reviewed_judge_run_id IS NULL AND review_submission_id IS NULL)
    OR (source = 'human' AND review_queue_item_id IS NOT NULL AND reviewed_judge_run_id IS NOT NULL AND review_submission_id IS NOT NULL)
  );
CREATE UNIQUE INDEX verdict_review_submission_unique ON verdicts(review_queue_item_id, review_submission_id);

CREATE FUNCTION guard_review_verdict_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.review_queue_item_id IS NOT NULL OR NEW.review_queue_item_id IS NOT NULL) THEN
    -- Account erasure preserves the review while anonymizing its actor.
    IF OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
      AND (to_jsonb(NEW)-'actor_user_id') = (to_jsonb(OLD)-'actor_user_id')
      AND NOT EXISTS (SELECT 1 FROM "user" WHERE id=OLD.actor_user_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'task reviews are append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.review_queue_item_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
      RAISE EXCEPTION 'task reviews are append-only while their project exists' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.review_queue_item_id IS NOT NULL THEN
    PERFORM 1 FROM judge_runs WHERE id=NEW.reviewed_judge_run_id FOR UPDATE;
  END IF;
  IF NEW.review_queue_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM review_queue_items item JOIN review_queues queue ON queue.id = item.queue_id
      JOIN judge_runs run ON run.id = NEW.reviewed_judge_run_id
      JOIN skill_versions version ON version.id = run.skill_version_id
    WHERE item.id = NEW.review_queue_item_id AND queue.project_id = NEW.project_id
      AND item.case_id = NEW.case_id AND run.case_id = NEW.case_id AND run.project_id = NEW.project_id
      AND version.criterion_version_id = item.criterion_version_id AND run.skill_version_id = NEW.skill_version_id
      AND (item.judge_run_id IS NULL OR (item.judge_run_id = run.id AND item.skill_version_id = run.skill_version_id))
      AND (item.assigned_to_user_id IS NULL OR item.assigned_to_user_id = NEW.actor_user_id)
  ) THEN
    RAISE EXCEPTION 'task review attribution mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verdict_review_context_guard BEFORE INSERT OR UPDATE OR DELETE ON verdicts
  FOR EACH ROW EXECUTE FUNCTION guard_review_verdict_context();

CREATE FUNCTION guard_reviewed_judge_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (EXISTS (SELECT 1 FROM review_queue_items WHERE judge_run_id = OLD.id)
      OR EXISTS (SELECT 1 FROM verdicts WHERE reviewed_judge_run_id = OLD.id)) THEN
    RAISE EXCEPTION 'recorded review evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviewed_judge_run_guard BEFORE UPDATE ON judge_runs
  FOR EACH ROW EXECUTE FUNCTION guard_reviewed_judge_run();

CREATE FUNCTION guard_review_queue_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id)
      AND EXISTS (SELECT 1 FROM review_queue_items WHERE queue_id=OLD.id AND judge_run_id IS NOT NULL) THEN
      RAISE EXCEPTION 'pinned review queues cannot be deleted while their project exists' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'review queue project is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_queue_project_guard BEFORE UPDATE OR DELETE ON review_queues
  FOR EACH ROW EXECUTE FUNCTION guard_review_queue_project();

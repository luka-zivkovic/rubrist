-- Every protected write has a latest eligible capability record plus facts
-- rederived under the same serialized command. Reads do the same before replay.
DROP TRIGGER governed_sealed_execution_stage;
CREATE TRIGGER governed_sealed_open BEFORE INSERT ON governed_review_batch_events WHEN NEW.event_kind='open' AND EXISTS(SELECT 1 FROM governed_review_batches WHERE id=NEW.batch_id AND role_intent='sealed_validation') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM governed_review_batches b WHERE b.id=NEW.batch_id AND NOT analysis_governed_separation_valid_v1(b.id,'batch_open',b.custodian_subject_id)) OR EXISTS(SELECT 1 FROM governed_review_tasks t WHERE t.batch_id=NEW.batch_id AND NOT analysis_governed_separation_valid_v1(t.batch_id,'batch_open',t.reviewer_subject_id)) THEN RAISE(ABORT,'sealed open capability separation is missing or ineligible') END;
END;
CREATE TRIGGER governed_sealed_task_access BEFORE INSERT ON governed_review_task_events WHEN NEW.event_kind<>'expired' AND EXISTS(SELECT 1 FROM governed_review_tasks t JOIN governed_review_batches b ON b.id=t.batch_id WHERE t.id=NEW.task_id AND b.role_intent='sealed_validation') BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM governed_review_tasks t WHERE t.id=NEW.task_id AND NOT analysis_governed_separation_valid_v1(t.batch_id,'batch_open',t.reviewer_subject_id)) THEN RAISE(ABORT,'sealed task capability separation is missing or ineligible') END;
END;
CREATE TRIGGER governed_sealed_alignment_access BEFORE INSERT ON governed_review_alignment_events WHEN EXISTS(SELECT 1 FROM governed_review_batches WHERE id=NEW.batch_id AND role_intent='sealed_validation') BEGIN
 SELECT CASE WHEN NOT analysis_governed_separation_valid_v1(NEW.batch_id,'adjudication',NEW.actor_subject_id) THEN RAISE(ABORT,'sealed alignment capability separation is missing or ineligible') END;
END;
CREATE TRIGGER governed_sealed_adjudication_access BEFORE INSERT ON governed_review_adjudications WHEN EXISTS(SELECT 1 FROM governed_review_batches WHERE id=NEW.batch_id AND role_intent='sealed_validation') BEGIN
 SELECT CASE WHEN NOT analysis_governed_separation_valid_v1(NEW.batch_id,'adjudication',NEW.adjudicator_subject_id) THEN RAISE(ABORT,'sealed adjudication capability separation is missing or ineligible') END;
END;

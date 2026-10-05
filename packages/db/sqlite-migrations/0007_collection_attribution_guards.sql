-- Forward-only integrity repair: collection membership identity cannot move
-- underneath retained evaluation items. Labels and notes remain mutable.
CREATE TRIGGER dataset_item_identity_immutable BEFORE UPDATE ON dataset_items WHEN
  NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR
  NEW.dataset_id IS NOT OLD.dataset_id OR NEW.case_id IS NOT OLD.case_id OR
  NEW.trace_id IS NOT OLD.trace_id OR NEW.added_at IS NOT OLD.added_at
BEGIN SELECT RAISE(ABORT,'immutable dataset item identity'); END;

-- Account erasure may anonymize attribution through ON DELETE SET NULL.
CREATE TRIGGER eval_run_creator_immutable BEFORE UPDATE OF created_by_user_id ON eval_runs WHEN
  NEW.created_by_user_id IS NOT OLD.created_by_user_id AND NOT(
    NEW.created_by_user_id IS NULL AND NOT EXISTS(SELECT 1 FROM "user" WHERE id=OLD.created_by_user_id))
BEGIN SELECT RAISE(ABORT,'immutable eval run creator'); END;

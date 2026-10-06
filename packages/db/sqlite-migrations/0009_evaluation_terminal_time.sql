-- Preserve applied migration checksums while binding terminal start time.
DROP TRIGGER eval_run_terminal_immutable;
CREATE TRIGGER eval_run_terminal_immutable BEFORE UPDATE ON eval_runs WHEN OLD.status IN ('completed','failed') AND
  (NEW.status<>OLD.status OR NEW.completed_items<>OLD.completed_items OR NEW.failed_items<>OLD.failed_items OR
   NEW.agreed_items<>OLD.agreed_items OR NEW.error IS NOT OLD.error OR NEW.finished_at IS NOT OLD.finished_at OR NEW.started_at IS NOT OLD.started_at OR NEW.blocking IS NOT OLD.blocking)
BEGIN SELECT RAISE(ABORT,'immutable terminal eval run'); END;

-- Retain the frozen collection membership until the source item is removed.
DROP TRIGGER eval_item_dataset_update;
CREATE TRIGGER eval_item_dataset_update BEFORE UPDATE OF dataset_item_id ON eval_run_items WHEN
 NEW.dataset_item_id IS NOT OLD.dataset_item_id AND
 (NEW.dataset_item_id IS NOT NULL OR EXISTS(SELECT 1 FROM dataset_items WHERE id=OLD.dataset_item_id))
BEGIN SELECT RAISE(ABORT,'immutable eval dataset item'); END;

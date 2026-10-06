-- Authorization creates a revision lease that only a terminal owning mint (or
-- project erasure) can release, so an authorized run can only end by minting.
-- A rejection would orphan that lease and block the sealed revision forever.
-- Lifecycle refusal after authorization uses the incomplete mint instead.
CREATE TRIGGER binary_calibration_run_authorized_reject BEFORE UPDATE ON binary_calibration_runs WHEN NEW.state='rejected' AND (OLD.authorization_check_id IS NOT NULL OR NEW.authorization_check_id IS NOT NULL) BEGIN SELECT RAISE(ABORT,'authorized calibration run cannot be rejected'); END;

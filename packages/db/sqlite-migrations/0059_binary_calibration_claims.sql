-- Durable claim fencing for queued native calibration. Dispatch remains staged.
DROP TRIGGER binary_calibration_run_stage;
CREATE TRIGGER binary_calibration_run_update BEFORE UPDATE ON binary_calibration_runs BEGIN
 SELECT sqlite_command_token();
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR
 NEW.project_id IS NOT OLD.project_id OR
 NEW.dataset_revision_id IS NOT OLD.dataset_revision_id OR
 NEW.revision_digest IS NOT OLD.revision_digest OR
 NEW.truth_content_digest IS NOT OLD.truth_content_digest OR
 NEW.item_count IS NOT OLD.item_count OR
 NEW.criterion_id IS NOT OLD.criterion_id OR
 NEW.criterion_version_id IS NOT OLD.criterion_version_id OR
 NEW.criterion_digest IS NOT OLD.criterion_digest OR
 NEW.skill_id IS NOT OLD.skill_id OR
 NEW.skill_version_id IS NOT OLD.skill_version_id OR
 NEW.skill_digest IS NOT OLD.skill_digest OR
 NEW.output_contract_digest IS NOT OLD.output_contract_digest OR
 NEW.requested_provider IS NOT OLD.requested_provider OR
 NEW.definition_digest IS NOT OLD.definition_digest OR
 NEW.execution_binding IS NOT OLD.execution_binding OR
 NEW.requested_binding_digest IS NOT OLD.requested_binding_digest OR
 NEW.suite_manifest_id IS NOT OLD.suite_manifest_id OR
 NEW.suite_manifest_digest IS NOT OLD.suite_manifest_digest OR
 NEW.suite_member_position IS NOT OLD.suite_member_position OR
 NEW.governed_review_batch_id IS NOT OLD.governed_review_batch_id OR
 NEW.governed_review_batch_digest IS NOT OLD.governed_review_batch_digest OR
 NEW.review_instruction_version_id IS NOT OLD.review_instruction_version_id OR
 NEW.review_instruction_digest IS NOT OLD.review_instruction_digest OR
 NEW.population_id IS NOT OLD.population_id OR
 NEW.population_digest IS NOT OLD.population_digest OR
 NEW.draw_digest IS NOT OLD.draw_digest OR
 NEW.representative_of_population_id IS NOT OLD.representative_of_population_id OR
 NEW.representative_ineligible_reasons IS NOT OLD.representative_ineligible_reasons OR
 NEW.selection_method IS NOT OLD.selection_method OR
 NEW.positive_class IS NOT OLD.positive_class OR
 NEW.trial_plan_kind IS NOT OLD.trial_plan_kind OR
 NEW.trials_per_item IS NOT OLD.trials_per_item OR
 NEW.execution_environment IS NOT OLD.execution_environment OR
 NEW.provider_policy_id IS NOT OLD.provider_policy_id OR
 NEW.provider_policy_digest IS NOT OLD.provider_policy_digest OR
 NEW.provider_policy_canonical_bytes IS NOT OLD.provider_policy_canonical_bytes OR
 NEW.payload_transmission IS NOT OLD.payload_transmission OR
 NEW.idempotency_key IS NOT OLD.idempotency_key OR
 NEW.request_digest IS NOT OLD.request_digest OR
 NEW.planned_observations IS NOT OLD.planned_observations OR
 NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT,'immutable calibration pinned identity') END;
 SELECT CASE WHEN OLD.state IN('complete','incomplete','rejected') THEN RAISE(ABORT,'immutable terminal calibration run') END;
 SELECT CASE WHEN NOT(NEW.state=OLD.state OR (OLD.state='queued' AND NEW.state IN('running','recovery_required','rejected')) OR (OLD.state='running' AND NEW.state IN('recovery_required','complete','incomplete','rejected')) OR (OLD.state='recovery_required' AND NEW.state IN('running','complete','incomplete','rejected'))) THEN RAISE(ABORT,'invalid calibration state transition') END;
 SELECT CASE WHEN NEW.accounted_observations<OLD.accounted_observations THEN RAISE(ABORT,'calibration accounting is monotonic') END;
 SELECT CASE WHEN NEW.claim_expires_at IS NOT NULL AND (length(NEW.claim_expires_at)<>24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.claim_expires_at) IS NOT NEW.claim_expires_at OR NEW.claim_expires_at<sqlite_command_time()) THEN RAISE(ABORT,'invalid calibration claim expiry') END;
 SELECT CASE WHEN NEW.state='rejected' AND (NEW.completed_at IS NOT sqlite_command_time() OR NEW.claim_token IS NOT NULL) THEN RAISE(ABORT,'calibration rejection requires command completion and released claim') END;
END;
CREATE TRIGGER binary_calibration_run_execution_stage BEFORE UPDATE ON binary_calibration_runs WHEN NEW.accounted_observations<>0 OR NEW.authorization_check_id IS NOT NULL OR NEW.completion_check_id IS NOT NULL OR NEW.artifact_id IS NOT NULL OR NEW.artifact_digest IS NOT NULL OR NEW.evidence_digest IS NOT NULL OR NEW.started_at IS NOT NULL OR NEW.state IN('complete','incomplete') BEGIN SELECT RAISE(ABORT,'calibration execution requires complete owning commands'); END;

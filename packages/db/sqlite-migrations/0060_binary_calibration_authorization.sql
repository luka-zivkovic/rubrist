-- Native calibration authorization; immutable terminal mint remains staged.
DROP TRIGGER governed_capability_insert;
CREATE TRIGGER governed_capability_insert BEFORE INSERT ON governed_review_capability_checks BEGIN
 SELECT CASE WHEN NEW.checked_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'capability check requires current command') END;
 SELECT CASE WHEN NEW.verification_method<>'system_derived' OR (NEW.evaluator_version_id IS NOT NULL AND NEW.check_scope<>'final_validation') THEN RAISE(ABORT,'independent verification capability checks are staged') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_batches WHERE id=NEW.batch_id AND project_id=NEW.project_id AND criterion_version_id=NEW.criterion_version_id) THEN RAISE(ABORT,'capability check requires exact batch criterion') END;
 SELECT CASE WHEN NEW.check_scope='final_validation' AND NOT EXISTS(SELECT 1 FROM skill_versions WHERE id=NEW.evaluator_version_id AND project_id=NEW.project_id AND criterion_version_id=NEW.criterion_version_id) THEN RAISE(ABORT,'final validation requires exact evaluator criterion') END;
 SELECT CASE WHEN NEW.expected_previous_sequence<>coalesce((SELECT max(sequence) FROM governed_review_capability_checks WHERE batch_id=NEW.batch_id AND check_scope=NEW.check_scope AND subject_id=NEW.subject_id AND evaluator_version_id IS NEW.evaluator_version_id),0) OR NEW.sequence<>NEW.expected_previous_sequence+1 THEN RAISE(ABORT,'capability check sequence conflict') END;
 SELECT CASE WHEN governed_canonical_json_v1(NEW.covered_capabilities)<>'["criterion_authoring","instruction_authoring","evaluator_authoring","rubric_authoring","prompt_authoring","example_selection","development_exposure"]' THEN RAISE(ABORT,'capability coverage must be complete') END;
 SELECT CASE WHEN json_array_length(NEW.excluded_capabilities)>100 OR json_array_length(NEW.unknown_capabilities)>100 OR EXISTS(SELECT 1 FROM json_each(NEW.excluded_capabilities) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>1024) OR EXISTS(SELECT 1 FROM json_each(NEW.unknown_capabilities) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>1024) OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.excluded_capabilities))>65536 OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.unknown_capabilities))>65536 OR governed_jsonb_octets_v1(NEW.evidence)>262144 THEN RAISE(ABORT,'capability evidence exceeds bounds') END;
 SELECT CASE WHEN NEW.evidence_digest IS NOT governed_content_v1_digest('sealed-separation-evidence/v1',NEW.evidence) THEN RAISE(ABORT,'capability evidence digest mismatch') END;
 SELECT CASE WHEN NOT (CASE WHEN NEW.check_scope='final_validation' THEN analysis_calibration_capability_valid_v1(NEW.project_id,NEW.criterion_version_id,NEW.subject_id,NEW.result,governed_canonical_json_v1(NEW.excluded_capabilities),governed_canonical_json_v1(NEW.unknown_capabilities),governed_canonical_json_v1(NEW.evidence)) ELSE analysis_governed_capability_valid_v1(NEW.project_id,NEW.criterion_version_id,NEW.subject_id,NEW.result,governed_canonical_json_v1(NEW.excluded_capabilities),governed_canonical_json_v1(NEW.unknown_capabilities),governed_canonical_json_v1(NEW.evidence)) END) THEN RAISE(ABORT,'capability evidence must match live system facts') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-capability-check/v1',json_object('batchId',NEW.batch_id,'capabilityQueryVersion',NEW.capability_query_version,'checkScope',NEW.check_scope,'coveredCapabilities',json(NEW.covered_capabilities),'evidenceDigest',NEW.evidence_digest,'evaluatorVersionId',NEW.evaluator_version_id,'excludedCapabilities',json(NEW.excluded_capabilities),'result',NEW.result,'sequence',NEW.sequence,'subjectId',NEW.subject_id,'unknownCapabilities',json(NEW.unknown_capabilities),'verificationMethod',NEW.verification_method)) THEN RAISE(ABORT,'capability check content digest mismatch') END;
END;
DROP TRIGGER binary_calibration_revision_leases_stage;
DROP TRIGGER binary_calibration_attempts_stage;
DROP TRIGGER binary_calibration_exposure_checks_stage;
DROP TRIGGER binary_calibration_run_execution_stage;
CREATE TRIGGER binary_calibration_run_mint_stage BEFORE UPDATE ON binary_calibration_runs WHEN NEW.completion_check_id IS NOT NULL OR NEW.artifact_id IS NOT NULL OR NEW.artifact_digest IS NOT NULL OR NEW.evidence_digest IS NOT NULL OR NEW.state IN('complete','incomplete') BEGIN SELECT RAISE(ABORT,'calibration mint requires complete owning commands'); END;
CREATE TRIGGER binary_calibration_run_authorized_update BEFORE UPDATE ON binary_calibration_runs BEGIN
 SELECT CASE WHEN (NEW.authorization_check_id IS NULL)<>(NEW.started_at IS NULL) THEN RAISE(ABORT,'calibration authorization requires check and start together') END;
 SELECT CASE WHEN OLD.authorization_check_id IS NOT NULL AND (NEW.authorization_check_id IS NOT OLD.authorization_check_id OR NEW.started_at IS NOT OLD.started_at) THEN RAISE(ABORT,'immutable calibration authorization') END;
 SELECT CASE WHEN NEW.authorization_check_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM binary_calibration_exposure_checks x JOIN binary_calibration_revision_leases l ON l.run_id=x.run_id WHERE x.id=NEW.authorization_check_id AND x.run_id=NEW.id AND x.project_id=NEW.project_id AND x.phase='authorization' AND x.recorded_at=NEW.started_at AND l.dataset_revision_id=NEW.dataset_revision_id) THEN RAISE(ABORT,'calibration authorization requires exact check and active lease') END;
 SELECT CASE WHEN NEW.accounted_observations<>(SELECT count(*) FROM binary_calibration_attempts WHERE run_id=NEW.id AND accounting_state='accounted') THEN RAISE(ABORT,'calibration run accounting must match attempts') END;
END;
CREATE TABLE binary_calibration_authorization_finalizations (
 run_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(project_id,run_id,command_token),
 FOREIGN KEY(project_id,run_id) REFERENCES binary_calibration_runs(project_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE binary_calibration_authorization_claims (
 run_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 FOREIGN KEY(project_id,run_id) REFERENCES binary_calibration_runs(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,run_id,command_token) REFERENCES binary_calibration_authorization_finalizations(project_id,run_id,command_token) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER binary_calibration_authorization_claim_insert BEFORE INSERT ON binary_calibration_authorization_claims BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM binary_calibration_revision_leases WHERE project_id=NEW.project_id AND run_id=NEW.run_id) THEN RAISE(ABORT,'calibration authorization requires owning lease command') END;
END;
CREATE TRIGGER binary_calibration_lease_insert BEFORE INSERT ON binary_calibration_revision_leases BEGIN
 SELECT CASE WHEN NEW.acquired_at IS NOT sqlite_command_time() OR NEW.lease_generation<>1 OR NOT EXISTS(SELECT 1 FROM binary_calibration_runs r WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id AND r.dataset_revision_id=NEW.dataset_revision_id AND r.state IN('running','recovery_required') AND r.claim_token IS NOT NULL AND r.claim_expires_at>=sqlite_command_time() AND r.authorization_check_id IS NULL) THEN RAISE(ABORT,'calibration lease requires active claimed run') END;
END;
CREATE TRIGGER binary_calibration_lease_claim AFTER INSERT ON binary_calibration_revision_leases BEGIN
 INSERT INTO binary_calibration_authorization_claims VALUES(NEW.run_id,NEW.project_id,sqlite_command_token());
END;
CREATE TRIGGER binary_calibration_lease_immutable BEFORE UPDATE ON binary_calibration_revision_leases BEGIN SELECT RAISE(ABORT,'immutable calibration lease'); END;
CREATE TRIGGER binary_calibration_exposure_during_lease BEFORE INSERT ON dataset_exposure_events WHEN (NEW.exposure_class='development' OR NEW.activity IN('declassify','analysis_authoring','rubric_authoring','prompt_tuning','example_selection','model_selection','development_run','regression_run')) AND EXISTS(SELECT 1 FROM binary_calibration_revision_leases WHERE dataset_revision_id=NEW.revision_id) BEGIN SELECT RAISE(ABORT,'development exposure is blocked by active sealed calibration lease'); END;
CREATE TRIGGER binary_calibration_exposure_check_insert BEFORE INSERT ON binary_calibration_exposure_checks BEGIN
 SELECT CASE WHEN NEW.recorded_at IS NOT sqlite_command_time() OR NEW.snapshot_digest IS NOT governed_bytes_v1_digest(NEW.canonical_bytes) OR NOT EXISTS(SELECT 1 FROM binary_calibration_runs WHERE id=NEW.run_id AND project_id=NEW.project_id) THEN RAISE(ABORT,'calibration exposure snapshot ownership or byte digest mismatch') END;
 SELECT CASE WHEN NEW.phase<>'authorization' THEN RAISE(ABORT,'calibration completion snapshot remains staged') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM binary_calibration_authorization_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=sqlite_command_token()) OR EXISTS(SELECT 1 FROM binary_calibration_authorization_finalizations WHERE run_id=NEW.run_id) THEN RAISE(ABORT,'calibration snapshot requires unfinished authorization') END;
END;
CREATE TRIGGER binary_calibration_attempt_insert BEFORE INSERT ON binary_calibration_attempts BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.accounting_state<>'pending' OR NEW.attempt_state<>'not_started' OR NEW.physical_provider_calls<>0 OR NOT EXISTS(SELECT 1 FROM binary_calibration_runs r JOIN dataset_revision_items i ON i.revision_id=r.dataset_revision_id JOIN governed_dataset_truth_links t ON t.dataset_revision_item_id=i.id AND t.dataset_revision_id=i.revision_id AND t.criterion_version_id=r.criterion_version_id WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id AND i.project_id=r.project_id AND i.id=NEW.dataset_revision_item_id AND i.item_digest=NEW.dataset_revision_item_digest AND t.resolved_label=NEW.truth_label AND t.source_kind IN('governed_labels','adjudication') AND r.requested_provider=NEW.provider) THEN RAISE(ABORT,'calibration attempt requires exact governed run item') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM binary_calibration_authorization_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=sqlite_command_token()) OR EXISTS(SELECT 1 FROM binary_calibration_authorization_finalizations WHERE run_id=NEW.run_id) THEN RAISE(ABORT,'calibration attempt requires unfinished authorization') END;
END;
CREATE TRIGGER binary_calibration_attempt_update BEFORE UPDATE ON binary_calibration_attempts BEGIN
 SELECT sqlite_command_token();
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.project_id IS NOT OLD.project_id OR NEW.dataset_revision_item_id IS NOT OLD.dataset_revision_item_id OR NEW.dataset_revision_item_digest IS NOT OLD.dataset_revision_item_digest OR NEW.trial_index IS NOT OLD.trial_index OR NEW.truth_label IS NOT OLD.truth_label OR NEW.provider IS NOT OLD.provider OR NEW.commitment_salt IS NOT OLD.commitment_salt OR NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT,'immutable calibration attempt identity') END;
 SELECT CASE WHEN OLD.accounting_state='accounted' THEN RAISE(ABORT,'immutable accounted calibration attempt') END;
 SELECT CASE WHEN NEW.physical_provider_calls<OLD.physical_provider_calls OR (NEW.attempt_state='not_started' AND OLD.attempt_state<>'not_started') OR (NEW.attempt_state='started' AND OLD.attempt_state='terminal') THEN RAISE(ABORT,'calibration attempt state and calls are monotonic') END;
 SELECT CASE WHEN NEW.accounting_state='accounted' AND NEW.accounted_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'calibration accounting requires current command') END;
 SELECT CASE WHEN NEW.upstream_provider IS NOT NULL AND NEW.provider<>'openrouter' THEN RAISE(ABORT,'calibration upstream provider requires OpenRouter') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM binary_calibration_runs r JOIN binary_calibration_revision_leases l ON l.run_id=r.id JOIN binary_calibration_authorization_finalizations f ON f.run_id=r.id WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id AND r.state IN('running','recovery_required') AND r.authorization_check_id IS NOT NULL) THEN RAISE(ABORT,'calibration attempt requires authorized active run') END;
END;
CREATE TRIGGER binary_calibration_authorization_finalize BEFORE INSERT ON binary_calibration_authorization_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM binary_calibration_authorization_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=NEW.command_token) THEN RAISE(ABORT,'calibration finalization requires owning authorization') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM binary_calibration_runs r JOIN binary_calibration_exposure_checks x ON x.id=r.authorization_check_id AND x.run_id=r.id JOIN binary_calibration_revision_leases l ON l.run_id=r.id WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id AND x.phase='authorization' AND x.recorded_at=sqlite_command_time() AND r.started_at=x.recorded_at AND r.item_count=(SELECT count(*) FROM binary_calibration_attempts WHERE run_id=r.id) AND r.accounted_observations=0 AND EXISTS(SELECT 1 FROM dataset_exposure_events e WHERE e.project_id=r.project_id AND e.revision_id=r.dataset_revision_id AND e.evidence_ref_kind='binary_calibration_run' AND e.evidence_ref_id=r.id AND e.exposure_class='provenance' AND e.activity='final_validation_run' AND e.subject_kind='evaluator_version' AND e.subject_id=r.skill_version_id AND e.occurred_at=x.recorded_at)) THEN RAISE(ABORT,'calibration authorization bundle is incomplete') END;
END;
CREATE TRIGGER binary_calibration_authorization_claims_immutable BEFORE UPDATE ON binary_calibration_authorization_claims BEGIN SELECT RAISE(ABORT,'immutable calibration authorization'); END;
CREATE TRIGGER binary_calibration_authorization_claims_erase BEFORE DELETE ON binary_calibration_authorization_claims WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'calibration authorization deletion requires project erasure'); END;
CREATE TRIGGER binary_calibration_authorization_finalizations_immutable BEFORE UPDATE ON binary_calibration_authorization_finalizations BEGIN SELECT RAISE(ABORT,'immutable calibration authorization'); END;
CREATE TRIGGER binary_calibration_authorization_finalizations_erase BEFORE DELETE ON binary_calibration_authorization_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'calibration authorization deletion requires project erasure'); END;

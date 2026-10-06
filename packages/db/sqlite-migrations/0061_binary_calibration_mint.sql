-- Exact immutable artifacts and private ledgers. Project-owned data never leaves
-- the local transaction; public projections expose only the public artifact.
DROP TRIGGER binary_calibration_run_mint_stage;
DROP TRIGGER binary_calibration_private_ledgers_stage;
DROP TRIGGER binary_calibration_artifacts_stage;
DROP TRIGGER binary_calibration_exposure_check_insert;
DROP TRIGGER binary_calibration_revision_leases_erase;
DROP TRIGGER binary_calibration_revocation_events_stage;
CREATE TABLE binary_calibration_mint_finalizations (
 run_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(project_id,run_id,command_token),
 FOREIGN KEY(project_id,run_id) REFERENCES binary_calibration_runs(project_id,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE binary_calibration_mint_claims (
 run_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 command_token TEXT NOT NULL,
 UNIQUE(project_id,run_id,command_token),
 FOREIGN KEY(project_id,run_id) REFERENCES binary_calibration_runs(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,run_id,command_token) REFERENCES binary_calibration_mint_finalizations(project_id,run_id,command_token) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TRIGGER binary_calibration_mint_claim_insert BEFORE INSERT ON binary_calibration_mint_claims BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM binary_calibration_runs r JOIN binary_calibration_revision_leases l ON l.run_id=r.id WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id AND r.authorization_check_id IS NOT NULL AND r.state IN('running','recovery_required') AND r.claim_token IS NOT NULL AND r.claim_expires_at>=sqlite_command_time() AND r.accounted_observations=r.planned_observations AND r.planned_observations=(SELECT count(*) FROM binary_calibration_attempts WHERE run_id=r.id AND accounting_state='accounted')) THEN RAISE(ABORT,'calibration mint requires complete claimed execution') END;
END;
CREATE TRIGGER binary_calibration_exposure_check_insert BEFORE INSERT ON binary_calibration_exposure_checks BEGIN
 SELECT CASE WHEN NEW.recorded_at IS NOT sqlite_command_time() OR NEW.snapshot_digest IS NOT governed_bytes_v1_digest(NEW.canonical_bytes) OR NOT EXISTS(SELECT 1 FROM binary_calibration_runs WHERE id=NEW.run_id AND project_id=NEW.project_id) THEN RAISE(ABORT,'calibration exposure snapshot ownership or byte digest mismatch') END;
 SELECT CASE WHEN NEW.phase='authorization' AND (NOT EXISTS(SELECT 1 FROM binary_calibration_authorization_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=sqlite_command_token()) OR EXISTS(SELECT 1 FROM binary_calibration_authorization_finalizations WHERE run_id=NEW.run_id)) THEN RAISE(ABORT,'calibration snapshot requires unfinished authorization') END;
 SELECT CASE WHEN NEW.phase='completion' AND (NOT EXISTS(SELECT 1 FROM binary_calibration_mint_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=sqlite_command_token()) OR EXISTS(SELECT 1 FROM binary_calibration_mint_finalizations WHERE run_id=NEW.run_id)) THEN RAISE(ABORT,'calibration snapshot requires unfinished mint') END;
END;
CREATE TRIGGER binary_calibration_ledger_insert BEFORE INSERT ON binary_calibration_private_ledgers BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.commitment_digest IS NOT governed_bytes_v1_digest(NEW.canonical_bytes) OR NOT EXISTS(SELECT 1 FROM binary_calibration_mint_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=sqlite_command_token()) OR EXISTS(SELECT 1 FROM binary_calibration_mint_finalizations WHERE run_id=NEW.run_id) THEN RAISE(ABORT,'calibration ledger requires owning mint and exact byte digest') END;
END;
CREATE TRIGGER binary_calibration_artifact_insert BEFORE INSERT ON binary_calibration_artifacts BEGIN
 SELECT CASE WHEN NEW.artifact_revision<>1 OR NEW.predecessor_artifact_id IS NOT NULL OR NEW.correction_reason IS NOT NULL THEN RAISE(ABORT,'native calibration mint requires root artifact lineage') END;
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.artifact_digest IS NOT governed_bytes_v1_digest(NEW.canonical_bytes) OR NOT EXISTS(SELECT 1 FROM binary_calibration_private_ledgers l JOIN binary_calibration_mint_claims m ON m.run_id=l.run_id AND m.project_id=l.project_id WHERE l.id=NEW.private_ledger_id AND l.run_id=NEW.run_id AND l.project_id=NEW.project_id AND l.artifact_id=NEW.id AND m.command_token=sqlite_command_token()) OR EXISTS(SELECT 1 FROM binary_calibration_mint_finalizations WHERE run_id=NEW.run_id) THEN RAISE(ABORT,'calibration artifact requires reciprocal ledger and exact byte digest') END;
END;
CREATE TRIGGER binary_calibration_run_terminal BEFORE UPDATE ON binary_calibration_runs WHEN NEW.state IN('complete','incomplete') BEGIN
 SELECT CASE WHEN NEW.completed_at IS NOT sqlite_command_time() OR NEW.claim_token IS NOT NULL OR NOT EXISTS(SELECT 1 FROM binary_calibration_mint_claims WHERE run_id=NEW.id AND project_id=NEW.project_id AND command_token=sqlite_command_token()) OR NOT EXISTS(SELECT 1 FROM binary_calibration_artifacts a JOIN binary_calibration_exposure_checks x ON x.id=NEW.completion_check_id AND x.run_id=a.run_id WHERE a.id=NEW.artifact_id AND a.run_id=NEW.id AND a.project_id=NEW.project_id AND a.artifact_digest=NEW.artifact_digest AND a.evidence_digest=NEW.evidence_digest AND a.status=NEW.state AND a.created_at=NEW.completed_at AND x.phase='completion' AND x.recorded_at=NEW.completed_at) THEN RAISE(ABORT,'terminal calibration requires exact owning mint') END;
END;
CREATE TRIGGER binary_calibration_revision_leases_erase BEFORE DELETE ON binary_calibration_revision_leases WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM binary_calibration_runs r JOIN binary_calibration_mint_claims m ON m.run_id=r.id AND m.project_id=r.project_id WHERE r.id=OLD.run_id AND r.project_id=OLD.project_id AND r.state IN('complete','incomplete') AND r.completed_at=sqlite_command_time() AND m.command_token=sqlite_command_token()) THEN RAISE(ABORT,'calibration lease release requires terminal owning mint or project erasure') END;
END;
CREATE TRIGGER binary_calibration_mint_finalize BEFORE INSERT ON binary_calibration_mint_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM binary_calibration_mint_claims WHERE run_id=NEW.run_id AND project_id=NEW.project_id AND command_token=NEW.command_token) OR EXISTS(SELECT 1 FROM binary_calibration_revision_leases WHERE run_id=NEW.run_id) OR NOT analysis_calibration_mint_valid_v1(NEW.run_id,NEW.project_id) THEN RAISE(ABORT,'calibration mint must match retained execution and release its lease') END;
END;
CREATE TRIGGER binary_calibration_revocation_insert BEFORE INSERT ON binary_calibration_revocation_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM binary_calibration_artifacts WHERE id=NEW.artifact_id AND run_id=NEW.run_id AND project_id=NEW.project_id) THEN RAISE(ABORT,'calibration revocation requires exact artifact project and command') END;
END;
CREATE TRIGGER binary_calibration_mint_claims_immutable BEFORE UPDATE ON binary_calibration_mint_claims BEGIN SELECT RAISE(ABORT,'immutable calibration mint'); END;
CREATE TRIGGER binary_calibration_mint_claims_erase BEFORE DELETE ON binary_calibration_mint_claims WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'calibration mint deletion requires project erasure'); END;
CREATE TRIGGER binary_calibration_mint_finalizations_immutable BEFORE UPDATE ON binary_calibration_mint_finalizations BEGIN SELECT RAISE(ABORT,'immutable calibration mint'); END;
CREATE TRIGGER binary_calibration_mint_finalizations_erase BEFORE DELETE ON binary_calibration_mint_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'calibration mint deletion requires project erasure'); END;
